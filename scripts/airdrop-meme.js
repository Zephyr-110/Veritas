const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");

const MEME_PROGRAM_ID = new PublicKey("2Ztk1WhiRrFqZZktipzPEQghJFNJbA8C1LL1v3LsWCiP");
const EXPECTED_MINT = new PublicKey("CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG");
const DEFAULT_RECIPIENT = new PublicKey("2XTPuFTtsDZbCSks6c6fnxa8pzFcBUdwMZK8ds7kmqU7");
const DECIMALS = 6;
const PREMINT_AMOUNT = 1_000_000_000_000n;
const DEFAULT_TOKENS = BigInt(process.env.AIRDROP_TOKENS || "100000") * 10n ** BigInt(DECIMALS);
const DEFAULT_SOL = Number(process.env.AIRDROP_SOL || "0.5");

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function readText(p) {
  return fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").trim();
}

function rpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL.trim();
  const file = path.join(repoRoot(), "scripts", ".rpc.url");
  if (fs.existsSync(file)) {
    const line = readText(file)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("#"));
    if (line) return line;
  }
  return "https://api.devnet.solana.com";
}

function rpcHost(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/$/, "");
  } catch {
    return url.split("?")[0];
  }
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function tryReadKeypair(p) {
  try {
    if (!p || !fs.existsSync(p)) return null;
    const secret = JSON.parse(readText(p));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch {
    return null;
  }
}

function wslKeypair() {
  const cmd = spawnSync(
    "wsl.exe",
    ["-u", "dev", "--", "bash", "-lc", "cat /home/dev/.config/solana/id.json"],
    { encoding: "utf8", timeout: 15000 }
  );
  if (cmd.status !== 0) return null;
  const text = (cmd.stdout || "").trim();
  if (!text.startsWith("[")) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
}

function loadPayer() {
  const candidates = [
    process.env.WALLET_PATH,
    process.env.ANCHOR_WALLET,
    process.env.SOLANA_WALLET,
    path.join(os.homedir(), ".config", "solana", "id.json"),
    path.join(repoRoot(), "scripts", ".wallet.json"),
  ]
    .filter(Boolean)
    .map(expandHome);

  for (const p of candidates) {
    const kp = tryReadKeypair(p);
    if (kp) {
      console.log("wallet_file", p);
      return kp;
    }
  }

  const fromWsl = wslKeypair();
  if (fromWsl) {
    console.log("wallet_file", "wsl:/home/dev/.config/solana/id.json");
    return fromWsl;
  }

  throw new Error(
    "找不到 CLI 钱包。设 WALLET_PATH，或把 id.json 放到 ~/.config/solana/id.json"
  );
}

function mintPda() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("meme_mint")], MEME_PROGRAM_ID);
  return pda;
}

function tokenProgramOf(owner) {
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

function initializeIx(payer, mint, ata, tokenProgram) {
  const data = Buffer.from(
    crypto.createHash("sha256").update("global:initialize").digest().subarray(0, 8)
  );
  return {
    programId: MEME_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };
}

async function tokenBalance(connection, ata, tokenProgram) {
  try {
    const acc = await getAccount(connection, ata, "confirmed", tokenProgram);
    return acc.amount;
  } catch {
    return 0n;
  }
}

async function sendTx(connection, payer, ixs, label) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
    skipPreflight: false,
  });
  console.log(label, sig);
  return sig;
}

async function ensureInitialized(connection, payer, mint) {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (info) {
    const tokenProgram = tokenProgramOf(info.owner);
    const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tokenProgram);
    console.log("mint exists", mint.toBase58(), "owner", info.owner.toBase58());
    return { tokenProgram, ata };
  }

  const tokenProgram = TOKEN_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tokenProgram);
  console.log("mint missing, calling meme_token::initialize");
  await sendTx(
    connection,
    payer,
    [initializeIx(payer.publicKey, mint, ata, tokenProgram)],
    "initialize"
  );
  return { tokenProgram, ata };
}

async function ensureAdminTokens(connection, payer, mint, tokenProgram, adminAta, need) {
  let bal = await tokenBalance(connection, adminAta, tokenProgram);
  console.log("admin_tokens", Number(bal) / 10 ** DECIMALS);
  if (bal >= need) return;

  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!mintInfo) throw new Error("initialize 之后还是没有 mint");
  const tag = mintInfo.data.readUInt32LE(0);
  const auth = tag === 1 ? new PublicKey(mintInfo.data.subarray(4, 36)) : null;
  if (!auth || !auth.equals(payer.publicKey)) {
    throw new Error(
      `CLI 钱包土狗币不够（${Number(bal) / 10 ** DECIMALS}），也不是 mint authority`
    );
  }

  const mintAmount = need > PREMINT_AMOUNT ? need : PREMINT_AMOUNT;
  console.log("admin empty, mintTo", Number(mintAmount) / 10 ** DECIMALS);
  await sendTx(
    connection,
    payer,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        adminAta,
        payer.publicKey,
        mint,
        tokenProgram
      ),
      createMintToInstruction(
        mint,
        adminAta,
        payer.publicKey,
        mintAmount,
        [],
        tokenProgram
      ),
    ],
    "mintTo"
  );
}

async function main() {
  const recipientArg = process.argv[2];
  const recipient = recipientArg ? new PublicKey(recipientArg) : DEFAULT_RECIPIENT;
  const tokens = DEFAULT_TOKENS;
  const sol = DEFAULT_SOL;
  const rpc = rpcUrl();
  const payer = loadPayer();
  if (payer.publicKey.toBase58() !== "DEPaDBPZeXhi8TfLpk4D5Niab6tnb8eF1e2hNUSSKKr8") {
    throw new Error("CLI wallet is not DEPa, initialize/mint will fail");
  }
  const mint = mintPda();
  if (!mint.equals(EXPECTED_MINT)) {
    throw new Error(`mint PDA ${mint.toBase58()} != ${EXPECTED_MINT.toBase58()}`);
  }

  console.log("rpc", rpcHost(rpc));
  console.log("from", payer.publicKey.toBase58());
  console.log("to", recipient.toBase58());
  console.log("mint", mint.toBase58());
  console.log("tokens", Number(tokens) / 10 ** DECIMALS);
  console.log("sol", sol);

  const connection = new Connection(rpc, "confirmed");
  const fromSol = (await connection.getBalance(payer.publicKey, "confirmed")) / LAMPORTS_PER_SOL;
  console.log("from_sol", fromSol);
  if (fromSol < sol + 0.05) {
    throw new Error(`CLI 钱包 SOL 不够：${fromSol}`);
  }

  const { tokenProgram, ata: adminAta } = await ensureInitialized(connection, payer, mint);
  await ensureAdminTokens(connection, payer, mint, tokenProgram, adminAta, tokens);

  const destAta = getAssociatedTokenAddressSync(mint, recipient, false, tokenProgram);
  const destSolBefore = await connection.getBalance(recipient, "confirmed");
  const destTokBefore = await tokenBalance(connection, destAta, tokenProgram);

  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      destAta,
      recipient,
      mint,
      tokenProgram
    ),
    createTransferInstruction(
      adminAta,
      destAta,
      payer.publicKey,
      tokens,
      [],
      tokenProgram
    ),
  ];
  if (sol > 0) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: Math.round(sol * LAMPORTS_PER_SOL),
      })
    );
  }

  await sendTx(connection, payer, ixs, "airdrop");

  const destSolAfter = await connection.getBalance(recipient, "confirmed");
  const destTokAfter = await tokenBalance(connection, destAta, tokenProgram);
  const adminAfter = await tokenBalance(connection, adminAta, tokenProgram);
  console.log("dest_sol", destSolBefore / LAMPORTS_PER_SOL, "->", destSolAfter / LAMPORTS_PER_SOL);
  console.log(
    "dest_tokens",
    Number(destTokBefore) / 10 ** DECIMALS,
    "->",
    Number(destTokAfter) / 10 ** DECIMALS
  );
  console.log("admin_tokens_left", Number(adminAfter) / 10 ** DECIMALS);
  console.log("dest_ata", destAta.toBase58());
  console.log("done");
}

main().catch((err) => {
  console.error(err && err.logs ? err.logs.join("\n") : "");
  console.error(err.message || err);
  process.exit(1);
});
