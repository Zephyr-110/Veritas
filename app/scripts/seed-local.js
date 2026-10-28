const fs = require("fs");
const os = require("os");
const path = require("path");

function load(name) {
  const tries = [
    path.join(__dirname, "..", "node_modules", name),
    path.join(__dirname, "..", "..", "node_modules", name),
  ];
  for (const dir of tries) {
    try {
      return require(dir);
    } catch (_) {
      /* keep looking */
    }
  }
  return require(name);
}

const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} = load("@solana/web3.js");
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} = load("@solana/spl-token");

const RPC = process.env.SOLANA_RPC || "http://127.0.0.1:8899";
const DECIMALS = 6;
const SEED_PATH = path.join(__dirname, "..", ".local-seed.json");
const TOKENS = BigInt(process.env.SEED_TOKENS || "10000") * 10n ** BigInt(DECIMALS);
const SOL = Number(process.env.SEED_SOL || "20");

function walletPath() {
  const fromEnv = process.env.ANCHOR_WALLET || process.env.SOLANA_WALLET;
  if (fromEnv) return fromEnv.replace(/^~/, os.homedir());
  return path.join(os.homedir(), ".config", "solana", "id.json");
}

function loadPayer() {
  const p = walletPath();
  if (!fs.existsSync(p)) {
    throw new Error(`CLI wallet not found: ${p}\nInstall Solana CLI, then run solana-keygen new`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function saveSeed(data) {
  fs.writeFileSync(SEED_PATH, JSON.stringify(data, null, 2));
}

function readSeed() {
  if (!fs.existsSync(SEED_PATH)) return null;
  return JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
}

async function airdrop(connection, pubkey, sol) {
  const need = sol * LAMPORTS_PER_SOL;
  const have = await connection.getBalance(pubkey, "confirmed");
  if (have >= need) return;
  const sig = await connection.requestAirdrop(pubkey, need - have);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
}

async function fundToken(connection, payer, mint, owner, amount) {
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner,
    false,
    "confirmed",
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  if (amount > 0n) {
    await mintTo(
      connection,
      payer,
      mint,
      ata.address,
      payer,
      amount,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );
  }
  return ata.address;
}

async function main() {
  const pubkeys = process.argv.slice(2).filter((s) => !s.startsWith("-"));
  const connection = new Connection(RPC, "confirmed");
  try {
    await connection.getVersion();
  } catch (err) {
    throw new Error(
      `Cannot reach ${RPC}. In another terminal run:\n  solana-test-validator\nthen deploy: anchor deploy`
    );
  }

  const payer = loadPayer();
  await airdrop(connection, payer.publicKey, 50);
  console.log("CLI wallet", payer.publicKey.toBase58());

  let seed = readSeed();
  let mint;
  if (seed?.mint) {
    mint = new PublicKey(seed.mint);
    const info = await connection.getAccountInfo(mint);
    if (!info) {
      console.log("Previous mint is gone with the validator; creating a new one");
      seed = null;
    }
  }
  if (!seed) {
    mint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      DECIMALS,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );
    seed = {
      rpc: RPC,
      mint: mint.toBase58(),
      decimals: DECIMALS,
      authority: payer.publicKey.toBase58(),
    };
    saveSeed(seed);
    console.log("Created collateral mint", mint.toBase58());
  } else {
    mint = new PublicKey(seed.mint);
    console.log("Reusing collateral mint", mint.toBase58());
  }

  const targets = [payer.publicKey, ...pubkeys.map((s) => new PublicKey(s))];
  const seen = new Set();
  for (const owner of targets) {
    const id = owner.toBase58();
    if (seen.has(id)) continue;
    seen.add(id);
    await airdrop(connection, owner, SOL);
    await fundToken(connection, payer, mint, owner, TOKENS);
    const sol = (await connection.getBalance(owner, "confirmed")) / LAMPORTS_PER_SOL;
    console.log(`Funded ${id}  SOL=${sol.toFixed(2)}  tokens=${TOKENS / 10n ** BigInt(DECIMALS)}`);
  }

  console.log("\nIn the app Settings, set the default collateral mint to:");
  console.log(mint.toBase58());
  console.log("\nUse two Phantom accounts for trading:");
  console.log("  Wallet A = creator / oracle, cannot trade");
  console.log("  Wallet B = trader, buys Yes / No");
  console.log("Pass both addresses to this script, for example:");
  console.log("  node app/scripts/seed-local.js <walletA> <walletB>");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
