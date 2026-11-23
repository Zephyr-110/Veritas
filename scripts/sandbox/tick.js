#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { AnchorProvider, BN, Program, Wallet } = require("@coral-xyz/anchor");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} = require("@solana/spl-token");
const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js");

const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_PROGRAM_ID = "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER";
const DEFAULT_COLLATERAL_MINT = "CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG";
const DEFAULT_BTC_FEED = "6PxBx93S8x3tno1TsFZwT5VqP8drrRCbCXygEXYNkFJe";
const DEFAULT_BTC_OCR2_STATE = "HCKJKQ8xFfqm5BxTA6LaUCWYXNShYXF4eAwC7NhBYXkj";

const MARKET_ACCOUNT_SIZE = 409;
const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154];
const LP_POSITION_DISCRIMINATOR = [105, 241, 37, 200, 224, 2, 252, 90];
const I80F48_SCALE = 1n << 48n;

const FEED_DECIMALS_OFFSET = 138;
const FEED_COUNTER_OFFSET = 143;
const FEED_TS_OFFSET = 208;
const FEED_ANSWER_OFFSET = 216;
const FEED_MIN_LEN = 232;

const PREDICTION_BYTES = 64;
const MARKET_ID_BYTES = 16;

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/sandbox/tick.js [options]

Options:
  --self-check     Verify dependencies, IDL, settle.js path, feed decoding, and tx encoding offline
  -h, --help       Show this help message

Environment variables:
  SOLANA_RPC / RPC_URL         Solana RPC endpoint (default: ${DEFAULT_RPC})
  WALLET_PATH / ANCHOR_WALLET  Operator JSON keypair path (default: ~/.config/solana/id.json)
  PROGRAM_ID                   Program ID (default: ${DEFAULT_PROGRAM_ID})
  COLLATERAL_MINT              Collateral mint (default: ${DEFAULT_COLLATERAL_MINT})
  BTC_FEED_ACCOUNT             Chainlink BTC/USD Store feed (default: ${DEFAULT_BTC_FEED})
  BTC_OCR2_STATE               Chainlink BTC/USD OCR2 state (default: ${DEFAULT_BTC_OCR2_STATE})
  SANDBOX_STATE_PATH           State JSON file path (default: scripts/sandbox/state.json)
  SANDBOX_DURATION_SEC         Market duration in seconds (default: 120)
  SANDBOX_SEED_USDT            Initial seed liquidity in USDT (default: 150)
  SANDBOX_BET_USDT             Opening bot bet size in USDT (default: 2)
  SANDBOX_TITLE                Market title <= 64 UTF-8 bytes
  SANDBOX_SETTLE_GRACE_SEC     Grace wait seconds around expiry (default: 12)
  SANDBOX_RECYCLE_FUNDS        Recycle settled LP + winnings + empty ATAs (default: true)
  SANDBOX_DAILY_MAX_MARKETS    Max markets created per UTC day, 0=unlimited (default: 0)
  SANDBOX_MIN_SOL_LAMPORTS     Minimum operator SOL balance guard (default: 30000000)
  SANDBOX_ACTIVE_FILE          Optional JSON file {lastActiveTs} gating creation to active windows
  SANDBOX_ACTIVE_WINDOW_SEC    Active window duration in seconds (default: 1800)
  SETTLE_SCRIPT_PATH           Optional explicit path to scripts/settle.js
  IDL_PATH                     Optional explicit path to prediction_market.json
`);
  process.exit(exitCode);
}

function envStr(names, fallback) {
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return fallback;
}

function envNum(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

function defaultTitleForDuration(durationSec) {
  if (durationSec === 120) return "BTC/USD at or above opening price in 2 min?";
  if (durationSec % 60 === 0) {
    return `BTC/USD at or above opening price in ${durationSec / 60} min?`;
  }
  return `BTC/USD at or above opening price in ${durationSec} sec?`;
}

function getConfig() {
  const durationSec = Math.max(30, Math.round(envNum("SANDBOX_DURATION_SEC", 120)));
  const title = envStr(["SANDBOX_TITLE"], defaultTitleForDuration(durationSec));
  return {
    rpcUrl: envStr(["SOLANA_RPC", "RPC_URL"], DEFAULT_RPC),
    walletPath: envStr(
      ["WALLET_PATH", "ANCHOR_WALLET"],
      path.join(os.homedir(), ".config", "solana", "id.json")
    ),
    programId: new PublicKey(envStr(["PROGRAM_ID"], DEFAULT_PROGRAM_ID)),
    collateralMint: new PublicKey(envStr(["COLLATERAL_MINT"], DEFAULT_COLLATERAL_MINT)),
    btcFeed: new PublicKey(envStr(["BTC_FEED_ACCOUNT"], DEFAULT_BTC_FEED)),
    btcOcr2State: new PublicKey(envStr(["BTC_OCR2_STATE"], DEFAULT_BTC_OCR2_STATE)),
    statePath: envStr(["SANDBOX_STATE_PATH"], path.join(__dirname, "state.json")),
    durationSec,
    seedUsdt: Math.max(1.01, envNum("SANDBOX_SEED_USDT", 150)),
    betUsdt: Math.max(0.01, envNum("SANDBOX_BET_USDT", 2)),
    title,
    settleGraceSec: Math.max(0, Math.min(30, Math.round(envNum("SANDBOX_SETTLE_GRACE_SEC", 12)))),
    recycleFunds: envBool("SANDBOX_RECYCLE_FUNDS", true),
    dailyMaxMarkets: Math.max(0, Math.round(envNum("SANDBOX_DAILY_MAX_MARKETS", 0))),
    minSolLamports: Math.max(0, Math.round(envNum("SANDBOX_MIN_SOL_LAMPORTS", 30_000_000))),
    activeFile: envStr(["SANDBOX_ACTIVE_FILE"], ""),
    activeWindowSec: Math.max(60, Math.round(envNum("SANDBOX_ACTIVE_WINDOW_SEC", 1800))),
  };
}

function resolveSettleScript() {
  const candidates = [
    process.env.SETTLE_SCRIPT_PATH,
    path.resolve(__dirname, "..", "settle.js"),
    path.join(__dirname, "settle.js"),
    path.join(__dirname, "scripts", "settle.js"),
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Error(`scripts/settle.js not found. Checked:\n  ${candidates.join("\n  ")}`);
  }
  return hit;
}

function resolveIdlPath() {
  const candidates = [
    process.env.IDL_PATH,
    path.resolve(__dirname, "..", "..", "app", "src", "idl", "prediction_market.json"),
    path.resolve(__dirname, "..", "..", "target", "idl", "prediction_market.json"),
    path.join(__dirname, "app", "src", "idl", "prediction_market.json"),
    path.join(__dirname, "prediction_market.json"),
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Error(`prediction_market.json IDL not found. Checked:\n  ${candidates.join("\n  ")}`);
  }
  return hit;
}

function loadIdl(programId) {
  const idlPath = resolveIdlPath();
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  idl.address = programId.toBase58();
  return { idl, idlPath };
}

function loadKeypair(walletPath) {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Operator keypair file not found: ${walletPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error(`Invalid keypair JSON in ${walletPath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utcDayKey(nowSec = Math.floor(Date.now() / 1000)) {
  return new Date(nowSec * 1000).toISOString().slice(0, 10);
}

function loadState(statePath) {
  const fallback = { version: 1, nextBetSide: "yes", dailyCounts: {}, markets: [] };
  if (!fs.existsSync(statePath)) return fallback;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      version: 1,
      nextBetSide: raw.nextBetSide === "no" ? "no" : "yes",
      dailyCounts:
        raw.dailyCounts && typeof raw.dailyCounts === "object" ? raw.dailyCounts : {},
      markets: Array.isArray(raw.markets) ? raw.markets : [],
    };
  } catch (err) {
    throw new Error(`Failed to parse state JSON (${statePath}): ${err.message}`);
  }
}

function saveState(statePath, state) {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, statePath);
}

function encodePrediction(title) {
  const bytes = Buffer.from(title, "utf8");
  if (bytes.length === 0 || bytes.length > PREDICTION_BYTES) {
    throw new Error(
      `Market title UTF-8 length (${bytes.length}) must be 1..${PREDICTION_BYTES} bytes`
    );
  }
  const out = Buffer.alloc(PREDICTION_BYTES);
  bytes.copy(out, 0);
  return Array.from(out);
}

function findMarketPdas(programId, marketId) {
  const idBuf = Buffer.from(marketId);
  const [market, marketBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), idBuf],
    programId
  );
  const [snapshot] = PublicKey.findProgramAddressSync(
    [Buffer.from("snapshot"), market.toBuffer()],
    programId
  );
  const [yesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_mint"), market.toBuffer()],
    programId
  );
  const [noMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("no_mint"), market.toBuffer()],
    programId
  );
  const [collateralVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_vault"), market.toBuffer()],
    programId
  );
  const [yesPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_pool"), market.toBuffer()],
    programId
  );
  const [noPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("no_pool"), market.toBuffer()],
    programId
  );
  return { market, marketBump, snapshot, yesMint, noMint, collateralVault, yesPool, noPool };
}

function findLpPosition(programId, market, owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), market.toBuffer(), owner.toBuffer()],
    programId
  )[0];
}

function sameDisc(actual, expected) {
  if (actual.length < expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

class Cursor {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.offset = offset;
  }
  take(n) {
    if (this.offset + n > this.buf.length) throw new Error("Unexpected end of account data");
    const slice = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
  u8() {
    return this.take(1)[0];
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    return this.take(2).readUInt16LE(0);
  }
  u64() {
    return this.take(8).readBigUInt64LE(0);
  }
  i64() {
    return this.take(8).readBigInt64LE(0);
  }
  i128() {
    const lo = this.take(8).readBigUInt64LE(0);
    const hi = this.take(8).readBigInt64LE(0);
    return (hi << 64n) + lo;
  }
  pubkey() {
    return new PublicKey(this.take(32));
  }
  bytes(n) {
    return Array.from(this.take(n));
  }
}

function decodeMarket(data) {
  if (data.length !== MARKET_ACCOUNT_SIZE || !sameDisc(data, MARKET_DISCRIMINATOR)) {
    throw new Error("Account is not a valid Market account");
  }
  const c = new Cursor(data, 8);
  const expiry = Number(c.u64());
  const creator = c.pubkey();
  const id = c.bytes(16);
  const bump = c.u8();
  const yesMint = c.pubkey();
  const noMint = c.pubkey();
  const statusByte = c.u8();
  const statusMap = ["open", "resolved", "windowBurn", "staleBurn"];
  const status = statusMap[statusByte];
  if (!status) throw new Error(`Unknown market status byte: ${statusByte}`);
  const collateralMint = c.pubkey();
  const winnerTag = c.u8();
  const winner = winnerTag === 0 ? null : winnerTag === 1 ? (c.u8() === 0 ? "yes" : "no") : null;
  c.u8(); // marketCollateralBump
  c.bytes(64); // prediction
  c.u64(); // finishTs
  c.i128(); // lZero
  c.i64(); // lastAccrualTs
  c.i128(); // cumYesPerShare
  c.i128(); // cumNoPerShare
  c.u16(); // feeBps
  c.i128(); // reserveYes
  c.i128(); // reserveNo
  c.i128(); // totalLpShares
  const endTs = Number(c.i64());
  const ocr2State = c.pubkey();
  const threshold = c.i64();
  const priceDecimals = c.u8();
  const settleAbove = c.bool();
  return {
    expiry,
    creator,
    id,
    bump,
    yesMint,
    noMint,
    status,
    collateralMint,
    winner,
    endTs,
    ocr2State,
    threshold,
    priceDecimals,
    settleAbove,
  };
}

function decodeLpPosition(data) {
  if (!sameDisc(data, LP_POSITION_DISCRIMINATOR)) return null;
  const c = new Cursor(data, 8);
  const owner = c.pubkey();
  const shares = c.i128();
  return { owner, shares };
}

function decodeChainlinkFeed(data) {
  if (!data || data.length < FEED_MIN_LEN) {
    throw new Error(`Invalid Chainlink feed data length: ${data ? data.length : 0}`);
  }
  const decimals = data[FEED_DECIMALS_OFFSET];
  const counter = data.readUInt32LE(FEED_COUNTER_OFFSET);
  const publishTime = Number(data.readBigInt64LE(FEED_TS_OFFSET));
  const lo = data.readBigUInt64LE(FEED_ANSWER_OFFSET);
  const hi = data.readBigInt64LE(FEED_ANSWER_OFFSET + 8);
  const answer = (hi << 64n) + lo;
  if (!Number.isFinite(publishTime) || publishTime <= 0 || answer <= 0n) {
    throw new Error("Chainlink feed returned non-positive timestamp or answer");
  }
  return { decimals, counter, publishTime, answer };
}

function tokenProgramOf(owner) {
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

function ataOf(mint, owner, tokenProgram) {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}

function ensureAtaIx(owner, mint, tokenProgram, payer) {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ataOf(mint, owner, tokenProgram),
    owner,
    mint,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

async function fetchMintMeta(connection, mint) {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`Collateral mint not found: ${mint.toBase58()}`);
  const tokenProgram = tokenProgramOf(info.owner);
  const decimals = unpackMint(mint, info, tokenProgram).decimals;
  return { tokenProgram, decimals };
}

async function sendAndConfirm(connection, payer, ixs) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.add(...ixs);
    tx.sign(payer);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    try {
      const conf = await connection.confirmTransaction(
        {
          signature: sig,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
      );
      if (conf.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(conf.value.err)}`);
      }
      return sig;
    } catch (err) {
      const st = await connection
        .getSignatureStatus(sig, { searchTransactionHistory: true })
        .catch(() => null);
      if (
        st &&
        st.value &&
        st.value.err === null &&
        (st.value.confirmationStatus === "confirmed" ||
          st.value.confirmationStatus === "finalized")
      ) {
        return sig;
      }
      if (attempt === 0 && /block height exceeded|Blockhash not found|timed out/i.test(String(err))) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("Transaction confirmation failed after retry");
}

async function buildCreateMarketIxs(program, args) {
  const pdas = findMarketPdas(program.programId, args.marketId);
  const lpPosition = findLpPosition(program.programId, pdas.market, args.creator);
  const ix = await program.methods
    .createMarket({
      expiry: new BN(args.expiry.toString()),
      marketId: args.marketId,
      prediction: args.prediction,
      collateralAmount: new BN(args.collateralAmount.toString()),
      threshold: new BN(args.threshold.toString()),
      settleAbove: args.settleAbove,
    })
    .accountsPartial({
      creator: args.creator,
      market: pdas.market,
      ocr2State: args.ocr2State,
      snapshot: pdas.snapshot,
      lpPosition,
      collateralMint: args.collateralMint,
      yesMint: pdas.yesMint,
      noMint: pdas.noMint,
      collateralVault: pdas.collateralVault,
      creatorCollateralAta: ataOf(args.collateralMint, args.creator, args.tokenProgram),
      yesPool: pdas.yesPool,
      noPool: pdas.noPool,
      clock: SYSVAR_CLOCK_PUBKEY,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: args.tokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return {
    pdas,
    ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }), ix],
  };
}

async function buildUserBetOnIxs(program, args) {
  const { market, pdas, signer, collateralMint, tokenProgram, collateralAmount, side, minOut } = args;
  const ix = await program.methods
    .userBetOn({
      minOut: new BN(minOut.toString()),
      collateralAmount: new BN(collateralAmount.toString()),
      tokenType: side === "yes" ? { yes: {} } : { no: {} },
    })
    .accountsPartial({
      signer,
      market,
      collateralAta: ataOf(collateralMint, signer, tokenProgram),
      collateralMint,
      collateralVault: pdas.collateralVault,
      yesMint: pdas.yesMint,
      noMint: pdas.noMint,
      yesTokenAta: ataOf(pdas.yesMint, signer, tokenProgram),
      noTokenAta: ataOf(pdas.noMint, signer, tokenProgram),
      yesPool: pdas.yesPool,
      noPool: pdas.noPool,
      clock: SYSVAR_CLOCK_PUBKEY,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    ensureAtaIx(signer, pdas.yesMint, tokenProgram, signer),
    ensureAtaIx(signer, pdas.noMint, tokenProgram, signer),
    ix,
  ];
}

async function buildGetLiquidityIxs(program, args) {
  const { market, pdas, signer, tokenProgram, lpShare } = args;
  const lpPosition = findLpPosition(program.programId, market, signer);
  const ix = await program.methods
    .getLiquidity(new BN(lpShare.toString()))
    .accountsPartial({
      signer,
      market,
      lpPosition,
      yesMint: pdas.yesMint,
      noMint: pdas.noMint,
      makerYesAta: ataOf(pdas.yesMint, signer, tokenProgram),
      makerNoAta: ataOf(pdas.noMint, signer, tokenProgram),
      yesPool: pdas.yesPool,
      noPool: pdas.noPool,
      clock: SYSVAR_CLOCK_PUBKEY,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    ensureAtaIx(signer, pdas.yesMint, tokenProgram, signer),
    ensureAtaIx(signer, pdas.noMint, tokenProgram, signer),
    ix,
  ];
}

async function buildGetCollateralIxs(program, args) {
  const { market, pdas, signer, collateralMint, tokenMint, tokenProgram, amount } = args;
  const ix = await program.methods
    .getCollateral(new BN(amount.toString()))
    .accountsPartial({
      signer,
      market,
      tokenMint,
      tokenAta: ataOf(tokenMint, signer, tokenProgram),
      collateralMint,
      collateralVault: pdas.collateralVault,
      userCollateralAta: ataOf(collateralMint, signer, tokenProgram),
      tokenProgram,
    })
    .instruction();
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    ensureAtaIx(signer, collateralMint, tokenProgram, signer),
    ensureAtaIx(signer, tokenMint, tokenProgram, signer),
    ix,
  ];
}

function runSettleScript(settleScriptPath, marketAddress, cfg) {
  const res = spawnSync(
    process.execPath,
    [settleScriptPath, marketAddress, "--keypair", cfg.walletPath, "--rpc", cfg.rpcUrl],
    {
      env: { ...process.env, PROGRAM_ID: cfg.programId.toBase58() },
      encoding: "utf8",
      timeout: 90_000,
    }
  );
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.status === 0;
}

async function settleTrackedMarket(connection, cfg, settleScriptPath, entry) {
  const marketPk = new PublicKey(entry.address);
  let info = await connection.getAccountInfo(marketPk, "confirmed");
  if (!info) {
    entry.status = "closed";
    entry.recycled = true;
    return;
  }

  let market = decodeMarket(Buffer.from(info.data));
  if (market.status !== "open") {
    entry.status = market.status;
    entry.winner = market.winner;
    return;
  }

  let nowSec = Math.floor(Date.now() / 1000);
  if (market.expiry > nowSec) {
    const secsToExpiry = market.expiry - nowSec;
    if (secsToExpiry <= 10 && cfg.settleGraceSec > 0) {
      const waitMs = Math.min(cfg.settleGraceSec, secsToExpiry + 4) * 1000;
      console.log(
        `[settle] ${entry.address} expires in ${secsToExpiry}s; waiting ${Math.round(
          waitMs / 1000
        )}s for first OCR2 print...`
      );
      await pause(waitMs);
      nowSec = Math.floor(Date.now() / 1000);
    } else {
      return;
    }
  } else if (nowSec - market.expiry < 4 && cfg.settleGraceSec > 0) {
    const waitMs = Math.min(cfg.settleGraceSec, 4 - (nowSec - market.expiry) + 1) * 1000;
    console.log(`[settle] ${entry.address} just expired; waiting ${Math.round(waitMs / 1000)}s...`);
    await pause(waitMs);
  }

  console.log(`[settle] invoking settle.js for ${entry.address}...`);
  let ok = runSettleScript(settleScriptPath, entry.address, cfg);
  if (!ok && cfg.settleGraceSec > 0) {
    await pause(4000);
    ok = runSettleScript(settleScriptPath, entry.address, cfg);
  }

  info = await connection.getAccountInfo(marketPk, "confirmed");
  if (info) {
    market = decodeMarket(Buffer.from(info.data));
    entry.status = market.status;
    entry.winner = market.winner;
    if (market.status !== "open") {
      entry.settledAt = Math.floor(Date.now() / 1000);
    }
  }
}

async function safeTokenAmount(connection, ata, tokenProgram) {
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info) return { exists: false, amount: 0n };
  try {
    return { exists: true, amount: unpackAccount(ata, info, tokenProgram).amount };
  } catch {
    return { exists: true, amount: 0n };
  }
}

async function recycleMarketFunds(connection, program, payer, cfg, entry) {
  const marketPk = new PublicKey(entry.address);
  const info = await connection.getAccountInfo(marketPk, "confirmed");
  if (!info) {
    entry.recycled = true;
    return;
  }
  const market = decodeMarket(Buffer.from(info.data));
  if (market.status === "open") return;

  const pdas = findMarketPdas(program.programId, market.id);
  const mintMeta = await fetchMintMeta(connection, market.collateralMint);
  const tp = mintMeta.tokenProgram;
  const lpPda = findLpPosition(program.programId, marketPk, payer.publicKey);

  // 1. Withdraw LP shares if still present
  const lpInfo = await connection.getAccountInfo(lpPda, "confirmed");
  if (lpInfo) {
    const lpPos = decodeLpPosition(Buffer.from(lpInfo.data));
    if (lpPos && lpPos.shares > 0n) {
      const ceilShares =
        lpPos.shares / I80F48_SCALE + (lpPos.shares % I80F48_SCALE > 0n ? 1n : 0n);
      const lpIxs = await buildGetLiquidityIxs(program, {
        market: marketPk,
        pdas,
        signer: payer.publicKey,
        tokenProgram: tp,
        lpShare: ceilShares > 0n ? ceilShares : 1n,
      });
      const sig = await sendAndConfirm(connection, payer, lpIxs);
      console.log(`[recycle] withdrew LP from ${entry.address}: ${sig}`);
    }
  }

  // 2. Redeem winning / voided tokens
  const yesAta = ataOf(pdas.yesMint, payer.publicKey, tp);
  const noAta = ataOf(pdas.noMint, payer.publicKey, tp);
  const yesBal = await safeTokenAmount(connection, yesAta, tp);
  const noBal = await safeTokenAmount(connection, noAta, tp);

  const redeemSide = async (mint, bal) => {
    const redeemAmt = market.status === "resolved" ? bal : bal - (bal % 2n);
    const minNeeded = market.status === "resolved" ? 1n : 2n;
    if (redeemAmt < minNeeded) return;
    const ixs = await buildGetCollateralIxs(program, {
      market: marketPk,
      pdas,
      signer: payer.publicKey,
      collateralMint: market.collateralMint,
      tokenMint: mint,
      tokenProgram: tp,
      amount: redeemAmt,
    });
    const sig = await sendAndConfirm(connection, payer, ixs);
    console.log(`[recycle] redeemed ${redeemAmt} from ${entry.address}: ${sig}`);
  };

  if (market.status === "resolved") {
    if (market.winner === "yes") await redeemSide(pdas.yesMint, yesBal.amount);
    else if (market.winner === "no") await redeemSide(pdas.noMint, noBal.amount);
  } else {
    await redeemSide(pdas.yesMint, yesBal.amount);
    await redeemSide(pdas.noMint, noBal.amount);
  }

  // 3. Burn leftover worthless / odd-dust tokens and close empty ATAs to reclaim rent
  try {
    const closeIxs = [];
    for (const [mint, ata] of [
      [pdas.yesMint, yesAta],
      [pdas.noMint, noAta],
    ]) {
      const latestBal = await safeTokenAmount(connection, ata, tp);
      if (!latestBal.exists) continue;
      if (latestBal.amount > 0n) {
        closeIxs.push(createBurnInstruction(ata, mint, payer.publicKey, latestBal.amount, [], tp));
      }
      closeIxs.push(createCloseAccountInstruction(ata, payer.publicKey, payer.publicKey, [], tp));
    }
    if (closeIxs.length > 0) {
      const sig = await sendAndConfirm(connection, payer, closeIxs);
      console.log(`[recycle] closed operator ATAs for ${entry.address}: ${sig}`);
    }
  } catch (err) {
    console.warn(`[recycle] ATA cleanup skipped for ${entry.address}: ${err.message}`);
  }

  entry.recycled = true;
}

function isActiveWindowOpen(cfg, nowSec) {
  if (!cfg.activeFile) return true;
  if (!fs.existsSync(cfg.activeFile)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(cfg.activeFile, "utf8"));
    const lastTs = Number(data.lastActiveTs || 0);
    return Number.isFinite(lastTs) && nowSec - lastTs <= cfg.activeWindowSec;
  } catch {
    return false;
  }
}

function computeAlignedExpiry(nowSec, durationSec) {
  if (durationSec >= 60 && nowSec % 60 <= 12) {
    const aligned = Math.floor(nowSec / 60) * 60 + durationSec - 5;
    if (aligned >= nowSec + 30) return aligned;
  }
  return nowSec + durationSec;
}

async function runSelfCheck() {
  const cfg = getConfig();
  const { idl, idlPath } = loadIdl(cfg.programId);
  const settleScriptPath = resolveSettleScript();
  const encodedPred = encodePrediction(cfg.title);

  // Synthetic 232-byte Chainlink feed buffer check
  const synthFeed = Buffer.alloc(FEED_MIN_LEN);
  synthFeed[FEED_DECIMALS_OFFSET] = 8;
  synthFeed.writeUInt32LE(42, FEED_COUNTER_OFFSET);
  synthFeed.writeBigInt64LE(1_763_900_000n, FEED_TS_OFFSET);
  const expectedPrice = 95_123_45678900n;
  synthFeed.writeBigUInt64LE(expectedPrice & ((1n << 64n) - 1n), FEED_ANSWER_OFFSET);
  synthFeed.writeBigInt64LE(expectedPrice >> 64n, FEED_ANSWER_OFFSET + 8);
  const decoded = decodeChainlinkFeed(synthFeed);
  if (decoded.decimals !== 8 || decoded.answer !== expectedPrice) {
    throw new Error("Chainlink feed decoder self-check failed");
  }

  // Offline Anchor instruction serialization check
  const dummyPayer = Keypair.generate();
  const dummyConn = new Connection(cfg.rpcUrl, "confirmed");
  const program = new Program(
    idl,
    new AnchorProvider(dummyConn, new Wallet(dummyPayer), { commitment: "confirmed" })
  );
  const marketId = Array.from(crypto.randomBytes(MARKET_ID_BYTES));
  const createRes = await buildCreateMarketIxs(program, {
    creator: dummyPayer.publicKey,
    collateralMint: cfg.collateralMint,
    ocr2State: cfg.btcOcr2State,
    marketId,
    prediction: encodedPred,
    expiry: Math.floor(Date.now() / 1000) + cfg.durationSec,
    collateralAmount: 150_000_000n,
    threshold: decoded.answer,
    settleAbove: true,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  await buildUserBetOnIxs(program, {
    market: createRes.pdas.market,
    pdas: createRes.pdas,
    signer: dummyPayer.publicKey,
    collateralMint: cfg.collateralMint,
    tokenProgram: TOKEN_PROGRAM_ID,
    collateralAmount: 2_000_000n,
    side: "yes",
    minOut: 1_000_000n,
  });
  await buildGetLiquidityIxs(program, {
    market: createRes.pdas.market,
    pdas: createRes.pdas,
    signer: dummyPayer.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
    lpShare: 150_000_000n,
  });
  await buildGetCollateralIxs(program, {
    market: createRes.pdas.market,
    pdas: createRes.pdas,
    signer: dummyPayer.publicKey,
    collateralMint: cfg.collateralMint,
    tokenMint: createRes.pdas.yesMint,
    tokenProgram: TOKEN_PROGRAM_ID,
    amount: 2_000_000n,
  });

  // Atomic state round-trip in OS temp dir
  const tmpStatePath = path.join(os.tmpdir(), `veritas-sandbox-selfcheck-${process.pid}.json`);
  try {
    saveState(tmpStatePath, {
      version: 1,
      nextBetSide: "no",
      dailyCounts: {},
      markets: [{ address: createRes.pdas.market.toBase58(), status: "open" }],
    });
    const loaded = loadState(tmpStatePath);
    if (loaded.nextBetSide !== "no" || loaded.markets.length !== 1) {
      throw new Error("State persistence self-check failed");
    }
  } finally {
    if (fs.existsSync(tmpStatePath)) fs.unlinkSync(tmpStatePath);
  }

  console.log("SANDBOX_SELF_CHECK_OK", {
    node: process.version,
    idlPath,
    settleScriptPath,
    titleBytes: Buffer.byteLength(cfg.title, "utf8"),
    sampleMarketPda: createRes.pdas.market.toBase58(),
  });
}

async function runTick() {
  const cfg = getConfig();
  const { idl } = loadIdl(cfg.programId);
  const settleScriptPath = resolveSettleScript();
  const payer = loadKeypair(cfg.walletPath);
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const state = loadState(cfg.statePath);

  // 1. Settle any tracked markets that are expired (or within grace window)
  for (const entry of state.markets) {
    if (entry.status !== "open") continue;
    try {
      await settleTrackedMarket(connection, cfg, settleScriptPath, entry);
      saveState(cfg.statePath, state);
    } catch (err) {
      console.error(`[settle] error on ${entry.address}:`, err.message || err);
    }
  }

  // 1b. Recycle settled LP + winnings + empty ATAs so collateral & rent roll over
  if (cfg.recycleFunds) {
    for (const entry of state.markets) {
      if (entry.recycled) continue;
      if (!["resolved", "windowBurn", "staleBurn"].includes(entry.status)) continue;
      try {
        await recycleMarketFunds(connection, program, payer, cfg, entry);
        saveState(cfg.statePath, state);
      } catch (err) {
        console.error(`[recycle] error on ${entry.address}:`, err.message || err);
      }
    }
  }

  // Prune old recycled history beyond 200 entries
  if (state.markets.length > 200) {
    const activeEntries = state.markets.filter((m) => m.status === "open" || !m.recycled);
    const archivedEntries = state.markets
      .filter((m) => m.status !== "open" && m.recycled)
      .slice(-200);
    state.markets = [...archivedEntries, ...activeEntries];
    saveState(cfg.statePath, state);
  }

  // 2. Check if any tracked market is currently live
  let nowSec = Math.floor(Date.now() / 1000);
  let hasLive = false;
  for (const entry of state.markets) {
    if (entry.status !== "open") continue;
    const info = await connection.getAccountInfo(new PublicKey(entry.address), "confirmed");
    if (!info) {
      entry.status = "closed";
      entry.recycled = true;
      continue;
    }
    const decoded = decodeMarket(Buffer.from(info.data));
    if (decoded.status !== "open") {
      entry.status = decoded.status;
      entry.winner = decoded.winner;
      continue;
    }
    if (decoded.expiry > nowSec) {
      hasLive = true;
      break;
    }
  }
  saveState(cfg.statePath, state);

  if (hasLive) {
    console.log("[tick] Live sandbox short market already exists; done.");
    return;
  }

  if (!isActiveWindowOpen(cfg, nowSec)) {
    console.log("[tick] Outside SANDBOX_ACTIVE_FILE activity window; skipping creation.");
    return;
  }

  const today = utcDayKey(nowSec);
  const todayCount = Number(state.dailyCounts[today] || 0);
  if (cfg.dailyMaxMarkets > 0 && todayCount >= cfg.dailyMaxMarkets) {
    console.log(`[tick] Daily cap (${cfg.dailyMaxMarkets}) reached for ${today}; skipping.`);
    return;
  }

  const mintMeta = await fetchMintMeta(connection, cfg.collateralMint);
  const scale = 10 ** mintMeta.decimals;
  const seedAtoms = BigInt(Math.round(cfg.seedUsdt * scale));
  const betAtoms = BigInt(Math.round(cfg.betUsdt * scale));
  if (seedAtoms <= 1_000_000n) {
    throw new Error("SANDBOX_SEED_USDT must produce > 1,000,000 raw collateral units");
  }

  const creatorCollateralAta = ataOf(cfg.collateralMint, payer.publicKey, mintMeta.tokenProgram);
  const [solLamports, usdtBal, feedInfo] = await Promise.all([
    connection.getBalance(payer.publicKey, "confirmed"),
    safeTokenAmount(connection, creatorCollateralAta, mintMeta.tokenProgram),
    connection.getAccountInfo(cfg.btcFeed, "confirmed"),
  ]);

  if (solLamports < cfg.minSolLamports) {
    throw new Error(
      `Operator SOL balance ${solLamports} lamports is below SANDBOX_MIN_SOL_LAMPORTS (${cfg.minSolLamports})`
    );
  }
  if (usdtBal.amount < seedAtoms + betAtoms) {
    throw new Error(
      `Operator collateral balance ${usdtBal.amount} is below required ${seedAtoms + betAtoms}`
    );
  }
  if (!feedInfo) {
    throw new Error(`BTC/USD Chainlink feed account not found: ${cfg.btcFeed.toBase58()}`);
  }

  const feed = decodeChainlinkFeed(Buffer.from(feedInfo.data));
  nowSec = Math.floor(Date.now() / 1000);
  const expiry = computeAlignedExpiry(nowSec, cfg.durationSec);
  const marketId = Array.from(crypto.randomBytes(MARKET_ID_BYTES));
  const prediction = encodePrediction(cfg.title);

  const { pdas, ixs: createIxs } = await buildCreateMarketIxs(program, {
    creator: payer.publicKey,
    collateralMint: cfg.collateralMint,
    ocr2State: cfg.btcOcr2State,
    marketId,
    prediction,
    expiry,
    collateralAmount: seedAtoms,
    threshold: feed.answer,
    settleAbove: true,
    tokenProgram: mintMeta.tokenProgram,
  });

  const createSig = await sendAndConfirm(connection, payer, createIxs);
  const marketAddr = pdas.market.toBase58();
  const entry = {
    address: marketAddr,
    idHex: Buffer.from(marketId).toString("hex"),
    title: cfg.title,
    expiry,
    threshold: feed.answer.toString(),
    priceDecimals: feed.decimals,
    status: "open",
    winner: null,
    createdAt: nowSec,
    createTx: createSig,
    betSide: null,
    betTx: null,
    recycled: false,
  };
  state.markets.push(entry);
  state.dailyCounts[today] = todayCount + 1;
  saveState(cfg.statePath, state);
  console.log(
    `[create] ${marketAddr} expiry=${expiry} threshold=${feed.answer.toString()} tx=${createSig}`
  );

  // 3. Place alternating 2 USDT opening bet on the new market
  const side = state.nextBetSide === "no" ? "no" : "yes";
  const betIxs = await buildUserBetOnIxs(program, {
    market: pdas.market,
    pdas,
    signer: payer.publicKey,
    collateralMint: cfg.collateralMint,
    tokenProgram: mintMeta.tokenProgram,
    collateralAmount: betAtoms,
    side,
    minOut: betAtoms / 2n,
  });
  const betSig = await sendAndConfirm(connection, payer, betIxs);
  entry.betSide = side;
  entry.betTx = betSig;
  state.nextBetSide = side === "yes" ? "no" : "yes";
  saveState(cfg.statePath, state);
  console.log(`[bet] ${marketAddr} side=${side} amount=${cfg.betUsdt} USDT tx=${betSig}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) usage(0);
  if (args.includes("--self-check")) {
    await runSelfCheck();
    return;
  }
  await runTick();
}

main().catch((err) => {
  console.error("SANDBOX_TICK_FAIL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
