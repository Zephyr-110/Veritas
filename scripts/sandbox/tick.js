#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
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

const { WAKE_SEC, WATCH_AFTER_SEC, tryLock } = require("./expiry-watch");

function loadOptionalModule(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return require(p);
      } catch {
        return null;
      }
    }
  }
  return null;
}
const dbLib = loadOptionalModule([
  path.resolve(__dirname, "..", "db.js"),
  path.join(__dirname, "db.js"),
]);
const indexerLib = loadOptionalModule([
  path.resolve(__dirname, "..", "index-markets.js"),
  path.join(__dirname, "index-markets.js"),
]);

async function persistCreatedMarketToDb(connection, programId, marketPk, openedAt) {
  if (!dbLib || !indexerLib) return;
  const db = dbLib.tryOpenDb();
  if (!db) return;
  try {
    const info = await connection.getAccountInfo(marketPk, "confirmed");
    if (!info) return;
    const account = dbLib.decodeMarketFull(info.data);
    const rows = await indexerLib.hydrateMarketRows(connection, programId, [
      { address: marketPk, account, openedAt },
    ]);
    dbLib.upsertMarkets(db, rows);
  } catch (err) {
    console.warn(`[db] market upsert skipped for ${marketPk.toBase58()}: ${err.message}`);
  } finally {
    if (db.open) db.close();
  }
}

async function runIncrementalSyncSafe(connection, programId, backfillEvidenceLimit = 2) {
  if (!indexerLib) return;
  let release;
  try {
    release = await tryLock("sqlite-sync");
    if (!release) return;
    await indexerLib.syncIncremental(connection, programId, { backfillEvidenceLimit });
  } catch (err) {
    console.warn(`[db] incremental sync skipped: ${err.message}`);
  } finally {
    release?.();
  }
}

const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_PROGRAM_ID = "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER";
const DEFAULT_COLLATERAL_MINT = "CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG";
const DEFAULT_ASSETS = "btc,eth,sol,link";
const RESOLVE_WINDOW_SEC = 172_800;
const DEFAULT_SETTLE_SLOTS = 4;
const DEFAULT_SETTLE_MAX_TOTAL_PROCS = 12;
const DEFAULT_SETTLE_STALE_MAX_AGE_SEC = 600;
const DEFAULT_RPC_FETCH_TIMEOUT_MS = 15_000;
const SELF_SETTLE_SLOT_PREFIX = "settle-slot-";
const DEFAULT_SEED_MIN_USDT = 120;
const DEFAULT_SEED_MAX_USDT = 180;

const ASSET_CATALOG = {
  btc: {
    key: "btc",
    symbol: "BTC/USD",
    feedEnv: "BTC_FEED_ACCOUNT",
    stateEnv: "BTC_OCR2_STATE",
    defaultFeed: "6PxBx93S8x3tno1TsFZwT5VqP8drrRCbCXygEXYNkFJe",
    defaultOcr2State: "HCKJKQ8xFfqm5BxTA6LaUCWYXNShYXF4eAwC7NhBYXkj",
  },
  eth: {
    key: "eth",
    symbol: "ETH/USD",
    feedEnv: "ETH_FEED_ACCOUNT",
    stateEnv: "ETH_OCR2_STATE",
    defaultFeed: "669U43LNHx7LsVj95uYksnhXUfWKDsdzVqev3V4Jpw3P",
    defaultOcr2State: "7zDTDDXiMqwbEEE17ZuFE4A6K5uBQo15tG1gkgdKZQB2",
  },
  sol: {
    key: "sol",
    symbol: "SOL/USD",
    feedEnv: "SOL_FEED_ACCOUNT",
    stateEnv: "SOL_OCR2_STATE",
    defaultFeed: "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR",
    defaultOcr2State: "EpFp9mhi9cvZL9Lp59S1mt2twv2dtZGgFUvZEQMZ9Ra8",
  },
  link: {
    key: "link",
    symbol: "LINK/USD",
    feedEnv: "LINK_FEED_ACCOUNT",
    stateEnv: "LINK_OCR2_STATE",
    defaultFeed: "HXoZZBWv25N4fm2vfSKnHXTeDJ31qaAcWZe3ZKeM6dQv",
    defaultOcr2State: "Ghm1a2c2NGPg6pKGG3PP1GLAuJkHm1RKMPqqJwPM7JpJ",
  },
};

const MARKET_ACCOUNT_SIZE = 409;
const MARKET_ACCOUNT_SIZE_V2 = 415;
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
  --self-check     Verify dependencies, IDL, settle.js path, feed decoding, stagger math, and tx encoding offline
  -h, --help       Show this help message

Environment variables:
  SOLANA_RPC / RPC_URL         Solana RPC endpoint (default: ${DEFAULT_RPC})
  WALLET_PATH / ANCHOR_WALLET  Operator JSON keypair path (default: ~/.config/solana/id.json)
  PROGRAM_ID                   Program ID (default: ${DEFAULT_PROGRAM_ID})
  COLLATERAL_MINT              Collateral mint (default: ${DEFAULT_COLLATERAL_MINT})
  SANDBOX_ASSETS               Comma-separated staggered feeds (default: ${DEFAULT_ASSETS})
  SANDBOX_DURATION_SEC         Market duration in seconds (default: 900 = 15 min)
  SANDBOX_SEED_USDT            Target mean seed liquidity in USDT (default: 150)
  SANDBOX_SEED_MIN_USDT        Minimum randomized seed in USDT (default: 0.8 * SANDBOX_SEED_USDT = 120)
  SANDBOX_SEED_MAX_USDT        Maximum randomized seed in USDT (default: 1.2 * SANDBOX_SEED_USDT = 180)
  SANDBOX_BET_USDT             Opening bot bet size in USDT (default: 2)
  SANDBOX_TITLE                Optional title override when using a single asset
  SANDBOX_STATE_PATH           State JSON file path (default: scripts/sandbox/state.json)
  SANDBOX_SETTLE_MAX_PER_TICK  Max expired line markets woken per tick (default: 4)
  SANDBOX_RECYCLE_FUNDS        Recycle settled LP + winnings + empty ATAs (default: true)
  SANDBOX_DAILY_MAX_MARKETS    Max markets created per UTC day, 0=unlimited (default: 0)
  SANDBOX_MIN_SOL_LAMPORTS     Minimum operator SOL balance guard (default: 30000000)
  SANDBOX_ACTIVE_FILE          Optional JSON file {lastActiveTs} gating creation to active windows
  SANDBOX_ACTIVE_WINDOW_SEC    Active window duration in seconds (default: 3600)
  BTC_FEED_ACCOUNT / BTC_OCR2_STATE   Override BTC/USD Chainlink feed/state accounts
  ETH_FEED_ACCOUNT / ETH_OCR2_STATE   Override ETH/USD Chainlink feed/state accounts
  SOL_FEED_ACCOUNT / SOL_OCR2_STATE   Override SOL/USD Chainlink feed/state accounts
  LINK_FEED_ACCOUNT / LINK_OCR2_STATE Override LINK/USD Chainlink feed/state accounts
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

function createRpcConnection(
  rpcUrl,
  timeoutMs = envNum("RPC_FETCH_TIMEOUT_MS", DEFAULT_RPC_FETCH_TIMEOUT_MS)
) {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_RPC_FETCH_TIMEOUT_MS;
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    fetch: (url, init) => {
      const t = AbortSignal.timeout(effectiveTimeout);
      const signal =
        init?.signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([init.signal, t])
          : t;
      return fetch(url, { ...init, signal });
    },
  });
}

function parseAssets(rawList) {
  const keys = String(rawList || DEFAULT_ASSETS)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (keys.length === 0) {
    throw new Error("SANDBOX_ASSETS must list at least one asset (btc, eth, sol, link)");
  }
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    const spec = ASSET_CATALOG[key];
    if (!spec) {
      throw new Error(
        `Unknown asset '${key}' in SANDBOX_ASSETS. Supported: ${Object.keys(ASSET_CATALOG).join(", ")}`
      );
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key: spec.key,
      symbol: spec.symbol,
      feed: new PublicKey(envStr([spec.feedEnv], spec.defaultFeed)),
      ocr2State: new PublicKey(envStr([spec.stateEnv], spec.defaultOcr2State)),
    });
  }
  return out;
}

function defaultTitleForAsset(symbol, durationSec) {
  if (durationSec >= 3600 && durationSec % 3600 === 0) {
    const hours = durationSec / 3600;
    return `${symbol} at or above opening price in ${hours} ${hours === 1 ? "hour" : "hours"}?`;
  }
  if (durationSec % 60 === 0) {
    return `${symbol} at or above opening price in ${durationSec / 60} min?`;
  }
  return `${symbol} at or above opening price in ${durationSec} sec?`;
}

function pickSeedUsdt(cfg, rng = Math.random) {
  const min = Math.max(1.01, Number(cfg?.seedMinUsdt ?? DEFAULT_SEED_MIN_USDT));
  const max = Math.max(min, Number(cfg?.seedMaxUsdt ?? DEFAULT_SEED_MAX_USDT));
  if (max <= min) return Number(min.toFixed(2));
  const raw = min + rng() * (max - min);
  return Math.min(max, Math.max(min, Math.round(raw * 100) / 100));
}

function getConfig() {
  const durationSec = Math.max(30, Math.round(envNum("SANDBOX_DURATION_SEC", 900)));
  const assets = parseAssets(envStr(["SANDBOX_ASSETS"], DEFAULT_ASSETS));
  const slots = Math.max(assets.length, Math.round(envNum("SANDBOX_SLOTS", assets.length)));
  const titleOverride = envStr(["SANDBOX_TITLE"], "");
  const seedUsdt = Math.max(1.01, envNum("SANDBOX_SEED_USDT", 150));
  const seedMinUsdt = Math.max(
    1.01,
    envNum("SANDBOX_SEED_MIN_USDT", Number((seedUsdt * 0.8).toFixed(2)))
  );
  const seedMaxUsdt = Math.max(
    seedMinUsdt,
    envNum("SANDBOX_SEED_MAX_USDT", Number((seedUsdt * 1.2).toFixed(2)))
  );
  return {
    rpcUrl: envStr(["SOLANA_RPC", "RPC_URL"], DEFAULT_RPC),
    walletPath: envStr(
      ["WALLET_PATH", "ANCHOR_WALLET"],
      path.join(os.homedir(), ".config", "solana", "id.json")
    ),
    programId: new PublicKey(envStr(["PROGRAM_ID"], DEFAULT_PROGRAM_ID)),
    collateralMint: new PublicKey(envStr(["COLLATERAL_MINT"], DEFAULT_COLLATERAL_MINT)),
    assets,
    slots,
    statePath: envStr(["SANDBOX_STATE_PATH"], path.join(__dirname, "state.json")),
    durationSec,
    seedUsdt,
    seedMinUsdt,
    seedMaxUsdt,
    betUsdt: Math.max(0.01, envNum("SANDBOX_BET_USDT", 2)),
    titleOverride,
    settleMaxPerTick: Math.max(1, Math.round(envNum("SANDBOX_SETTLE_MAX_PER_TICK", 4))),
    settleMaxSlots: Math.max(1, Math.round(envNum("SANDBOX_SETTLE_MAX_SLOTS", DEFAULT_SETTLE_SLOTS))),
    settleMaxTotalProcs: Math.max(
      1,
      Math.round(envNum("SANDBOX_SETTLE_MAX_TOTAL_PROCS", DEFAULT_SETTLE_MAX_TOTAL_PROCS))
    ),
    settleStaleMaxAgeSec: Math.max(
      60,
      Math.round(envNum("SANDBOX_SETTLE_STALE_MAX_AGE_SEC", DEFAULT_SETTLE_STALE_MAX_AGE_SEC))
    ),
    recycleFunds: envBool("SANDBOX_RECYCLE_FUNDS", true),
    dailyMaxMarkets: Math.max(0, Math.round(envNum("SANDBOX_DAILY_MAX_MARKETS", 0))),
    minSolLamports: Math.max(0, Math.round(envNum("SANDBOX_MIN_SOL_LAMPORTS", 30_000_000))),
    activeFile: envStr(["SANDBOX_ACTIVE_FILE"], ""),
    activeWindowSec: Math.max(60, Math.round(envNum("SANDBOX_ACTIVE_WINDOW_SEC", 3600))),
  };
}

function titleForAsset(cfg, asset) {
  if (cfg.titleOverride && cfg.assets.length === 1) return cfg.titleOverride;
  return defaultTitleForAsset(asset.symbol, cfg.durationSec);
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
  const fallback = { version: 2, nextBetSide: "yes", dailyCounts: {}, markets: [] };
  if (!fs.existsSync(statePath)) return fallback;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      version: Number(raw.version || 2),
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
  const isV2 = Boolean(data) && data.length === MARKET_ACCOUNT_SIZE_V2;
  const isLegacy = Boolean(data) && data.length === MARKET_ACCOUNT_SIZE;
  if ((!isLegacy && !isV2) || !sameDisc(data, MARKET_DISCRIMINATOR)) {
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
  const feeBps = isLegacy ? c.u16() : 0;
  c.i128(); // reserveYes
  c.i128(); // reserveNo
  c.i128(); // totalLpShares
  const startTs = isV2 ? Number(c.i64()) : null;
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
    feeBps,
    startTs,
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

function resolveAssetForEntry(cfg, entry) {
  const configured = cfg?.assets?.find((a) => a.key === entry?.asset);
  if (configured) return configured;
  const spec = ASSET_CATALOG[entry?.asset];
  if (!spec) return null;
  return {
    key: spec.key,
    symbol: spec.symbol,
    feed: new PublicKey(envStr([spec.feedEnv], spec.defaultFeed)),
    ocr2State: new PublicKey(envStr([spec.stateEnv], spec.defaultOcr2State)),
  };
}

function entryTargetEndTs(entry) {
  return Number(entry.endTs > 0 ? entry.endTs : entry.expiry);
}

function isLegacyMarketAccount(info, decoded) {
  if (info && info.data && info.data.length !== MARKET_ACCOUNT_SIZE_V2) return true;
  if (decoded && !(Number(decoded.startTs) > 0)) return true;
  return false;
}

function isLegacyEntry(entry) {
  if (!entry) return false;
  if (entry.legacy === true) return true;
  if (entry.accountSize != null && Number(entry.accountSize) !== MARKET_ACCOUNT_SIZE_V2) return true;
  if (entry.startTs !== undefined && !(Number(entry.startTs) > 0)) return true;
  return false;
}

function selectWatchEntries(entries, nowSec = Date.now() / 1000) {
  return (entries || [])
    .filter((e) => {
      if (e.status !== "open" || !e.address || isLegacyEntry(e)) return false;
      const targetEndTs = entryTargetEndTs(e);
      return targetEndTs > nowSec - WATCH_AFTER_SEC && targetEndTs <= nowSec + 60 + WAKE_SEC;
    })
    .sort((a, b) => entryTargetEndTs(a) - entryTargetEndTs(b))
    .slice(0, 2);
}

function settleRetryCooldownSec(ageSec) {
  if (ageSec < 600) return 0;
  if (ageSec < 3600) return 300;
  return 900;
}

function selectExpiredSettleEntries(
  entries,
  nowSec = Math.floor(Date.now() / 1000),
  maxPerTick = 4,
  excludedAddresses = new Set()
) {
  return (entries || [])
    .filter((e) => {
      if (e.status !== "open" || !e.address || excludedAddresses.has(e.address) || isLegacyEntry(e)) {
        return false;
      }
      const targetEndTs = entryTargetEndTs(e);
      if (!Number.isFinite(targetEndTs) || targetEndTs <= 0) return false;
      const pastWatchWindow = targetEndTs <= nowSec - WATCH_AFTER_SEC;
      const pastMinAge = targetEndTs <= nowSec - 4;
      const inResolveWindow = nowSec <= Number(e.expiry || targetEndTs) + RESOLVE_WINDOW_SEC;
      if (!inResolveWindow || !(pastWatchWindow || pastMinAge)) return false;
      const ageSec = Math.max(0, nowSec - targetEndTs);
      const cooldown = settleRetryCooldownSec(ageSec);
      const lastAttempt = Number(e.lastSettleAttemptAt || 0);
      if (cooldown > 0 && lastAttempt > 0 && nowSec - lastAttempt < cooldown) return false;
      return true;
    })
    .sort((a, b) => entryTargetEndTs(b) - entryTargetEndTs(a))
    .slice(0, maxPerTick);
}

const NODE_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-e",
  "--eval",
  "-p",
  "--print",
  "-C",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--max-old-space-size",
  "--title",
  "--redirect-warnings",
  "--diagnostic-dir",
  "--heapsnapshot-signal",
]);

function classifySettleProcess(argvTokens) {
  if (!Array.isArray(argvTokens) || argvTokens.length < 2) return null;
  const binName = path.basename(String(argvTokens[0] || "")).toLowerCase();
  if (!/^node(\d+)?(\.exe)?$/.test(binName)) return null;

  for (const tok of argvTokens) {
    const normalized = String(tok || "").replace(/\\/g, "/");
    if (/(?:^|\/)settle-all\.js$/.test(normalized) || normalized.includes("/node_modules/")) {
      return null;
    }
  }

  let scriptArg = null;
  let scriptIndex = -1;
  for (let i = 1; i < argvTokens.length; i += 1) {
    const tok = String(argvTokens[i] || "");
    if (tok === "--") break;
    if (tok.startsWith("-")) {
      if (!tok.includes("=") && NODE_VALUE_FLAGS.has(tok)) {
        i += 1;
      }
      continue;
    }
    scriptArg = tok;
    scriptIndex = i;
    break;
  }

  if (!scriptArg) return null;
  const normalizedScript = scriptArg.replace(/\\/g, "/");
  if (!/(?:^|\/)settle\.js$/.test(normalizedScript)) return null;

  const scriptArgs = argvTokens.slice(scriptIndex + 1);
  const isWatch = scriptArgs.includes("--watch");
  const isSelfSettle = scriptArgs.includes("--self-settle");
  return {
    isSettle: true,
    isWatch,
    isOrdinary: !isWatch,
    isSelfSettle,
    scriptArg,
  };
}

function listSettleProcesses({ platform = process.platform, myPid = process.pid } = {}) {
  if (platform !== "linux" || !fs.existsSync("/proc/uptime")) return [];
  let uptimeSec;
  try {
    uptimeSec = Number(fs.readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0]);
  } catch {
    return [];
  }
  if (!Number.isFinite(uptimeSec) || uptimeSec <= 0) return [];

  let procEntries;
  try {
    procEntries = fs.readdirSync("/proc");
  } catch {
    return [];
  }

  const out = [];
  for (const name of procEntries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0 || pid === myPid) continue;
    try {
      const rawCmd = fs.readFileSync(`/proc/${name}/cmdline`);
      const argv = rawCmd.toString("utf8").split("\0").filter(Boolean);
      const classified = classifySettleProcess(argv);
      if (!classified) continue;

      const statRaw = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const rparen = statRaw.lastIndexOf(")");
      if (rparen < 0) continue;
      const fields = statRaw.slice(rparen + 2).trim().split(/\s+/);
      const startTicks = Number(fields[19]);
      if (!Number.isFinite(startTicks) || startTicks < 0) continue;
      const elapsedSec = Math.max(0, uptimeSec - startTicks / 100);
      const uid = fs.statSync(`/proc/${name}`).uid;
      out.push({ pid, uid, elapsedSec, argv, ...classified });
    } catch {
      // Ignore processes that vanished or cannot be inspected
    }
  }
  return out;
}

function reapStaleSettleProcesses({
  maxAgeSec = DEFAULT_SETTLE_STALE_MAX_AGE_SEC,
  myUid = typeof process.getuid === "function" ? process.getuid() : null,
  listProcesses = listSettleProcesses,
  killProcess = (pid, sig) => process.kill(pid, sig),
} = {}) {
  const procs = listProcesses();
  const killedPids = [];
  const killedSet = new Set();

  for (const proc of procs) {
    if (!proc || !proc.isSettle || !proc.isOrdinary || proc.isWatch) continue;
    if (!(proc.elapsedSec > maxAgeSec)) continue;
    if (myUid != null && proc.uid !== myUid) continue;
    try {
      killProcess(proc.pid, "SIGTERM");
      killedPids.push(proc.pid);
      killedSet.add(proc.pid);
      console.log(
        `[self-settle] reaped stale settle.js pid=${proc.pid} age=${Math.round(proc.elapsedSec)}s script=${proc.scriptArg}`
      );
    } catch (err) {
      if (err && err.code !== "ESRCH") {
        console.warn(`[self-settle] failed to reap pid=${proc.pid}: ${err.message}`);
      }
    }
  }

  return {
    killedPids,
    remainingProcs: procs.filter((p) => !killedSet.has(p.pid)),
  };
}

async function releaseLockAndWait(releaseFn) {
  if (typeof releaseFn !== "function") return;
  const ret = releaseFn();
  if (ret && typeof ret.then === "function") {
    await ret;
    return;
  }
  if (ret && typeof ret.once === "function") {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 50);
      timer.unref?.();
      ret.once("close", done);
    });
  }
}

async function probeFreeSettleSlots(slotCount = DEFAULT_SETTLE_SLOTS, lockFn = tryLock) {
  let free = 0;
  for (let i = 0; i < slotCount; i += 1) {
    const rel = await lockFn(`${SELF_SETTLE_SLOT_PREFIX}${i}`);
    if (rel) {
      free += 1;
      await releaseLockAndWait(rel);
    }
  }
  return free;
}

function scheduleWatches(cfg, settleScriptPath, entries, nowSec = Date.now() / 1000) {
  const due = selectWatchEntries(entries, nowSec);
  const scheduled = [];
  for (const entry of due) {
    try {
      const asset = resolveAssetForEntry(cfg, entry);
      if (!asset) continue;
      const child = spawn(
        process.execPath,
        [settleScriptPath, entry.address, "--watch", asset.feed.toBase58()],
        {
          env: {
            ...process.env,
            PROGRAM_ID: cfg.programId.toBase58(),
            SOLANA_RPC: cfg.rpcUrl,
            ANCHOR_WALLET: cfg.walletPath,
          },
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "inherit", "inherit"],
        }
      );
      child.on("error", (err) => console.warn(`[wake] ${entry.address}: ${err.message}`));
      child.unref();
      scheduled.push(entry);
    } catch (err) {
      console.warn(`[wake] failed to schedule ${entry.address}: ${err?.message || err}`);
    }
  }
  return scheduled;
}

async function scheduleExpiredSettlements(
  cfg,
  settleScriptPath,
  entries,
  nowSec = Math.floor(Date.now() / 1000),
  excludedAddresses = new Set(),
  deps = {}
) {
  const {
    listProcesses = listSettleProcesses,
    killProcess = (pid, sig) => process.kill(pid, sig),
    tryLockFn = tryLock,
    spawnFn = spawn,
    myUid = typeof process.getuid === "function" ? process.getuid() : null,
  } = deps;

  const { remainingProcs } = reapStaleSettleProcesses({
    maxAgeSec: cfg.settleStaleMaxAgeSec ?? DEFAULT_SETTLE_STALE_MAX_AGE_SEC,
    myUid,
    listProcesses,
    killProcess,
  });

  const totalRunning = remainingProcs.length;
  const maxTotal = cfg.settleMaxTotalProcs ?? DEFAULT_SETTLE_MAX_TOTAL_PROCS;
  if (totalRunning >= maxTotal) {
    console.log(
      `[self-settle] total settle.js guardrail reached (${totalRunning}/${maxTotal}); skipping spawns`
    );
    return [];
  }

  const maxSlots = cfg.settleMaxSlots ?? DEFAULT_SETTLE_SLOTS;
  const freeSlots = await probeFreeSettleSlots(maxSlots, tryLockFn);
  if (freeSlots <= 0) {
    console.log(`[self-settle] all ${maxSlots} settle slots busy; deferring to next tick`);
    return [];
  }

  const budget = Math.min(cfg.settleMaxPerTick ?? 4, freeSlots, maxTotal - totalRunning);
  const due = selectExpiredSettleEntries(entries, nowSec, budget, excludedAddresses);
  const scheduled = [];
  for (const entry of due) {
    try {
      const ageSec = Math.max(0, Math.round(nowSec - entryTargetEndTs(entry)));
      console.log(`[self-settle] waking ${entry.address} (expired ${ageSec}s ago)`);
      const child = spawnFn(
        process.execPath,
        [settleScriptPath, entry.address, "--self-settle", "--keypair", cfg.walletPath, "--rpc", cfg.rpcUrl],
        {
          env: {
            ...process.env,
            PROGRAM_ID: cfg.programId.toBase58(),
            SOLANA_RPC: cfg.rpcUrl,
            ANCHOR_WALLET: cfg.walletPath,
          },
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "inherit", "inherit"],
        }
      );
      child.on("error", (err) => console.warn(`[self-settle] ${entry.address}: ${err.message}`));
      child.unref();
      entry.lastSettleAttemptAt = nowSec;
      scheduled.push(entry);
    } catch (err) {
      console.warn(`[self-settle] failed to wake ${entry.address}: ${err?.message || err}`);
    }
  }
  return scheduled;
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
  entry.accountSize = info.data.length;
  entry.startTs = market.startTs;
  if (isLegacyMarketAccount(info, market)) {
    entry.legacy = true;
    entry.recycled = true;
    if (!entry.legacyLogged) {
      entry.legacyLogged = true;
      console.log(
        `[recycle] skip legacy market ${entry.address} (size=${info.data.length}, startTs=${market.startTs})`
      );
    }
    return;
  }
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

async function recycleFinalizedEntries(connection, program, payer, cfg, state) {
  for (const entry of state.markets) {
    if (entry.recycled) continue;
    if (!["resolved", "windowBurn", "staleBurn"].includes(entry.status)) continue;
    if (isLegacyEntry(entry)) {
      entry.legacy = true;
      entry.recycled = true;
      if (!entry.legacyLogged) {
        entry.legacyLogged = true;
        console.log(
          `[recycle] skip legacy market ${entry.address} (size=${entry.accountSize ?? "unknown"}, startTs=${entry.startTs ?? null})`
        );
      }
      saveState(cfg.statePath, state);
      continue;
    }
    try {
      await recycleMarketFunds(connection, program, payer, cfg, entry);
      saveState(cfg.statePath, state);
    } catch (err) {
      console.error(`[recycle] error on ${entry.address}:`, err.message || err);
    }
  }
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

function slotOffsetSec(durationSec, slotIndex, totalSlots) {
  if (totalSlots <= 1) return 0;
  return Math.floor((slotIndex * durationSec) / totalSlots);
}

function computeStaggeredExpiry(nowSec, durationSec, slotIndex, totalSlots) {
  if (durationSec < 120 || totalSlots <= 1) {
    return computeAlignedExpiry(nowSec, durationSec);
  }
  const offset = slotOffsetSec(durationSec, slotIndex, totalSlots);
  const phase = (offset - 5 + durationSec) % durationSec;
  const minLead = Math.min(
    Math.floor(durationSec * 0.4),
    Math.max(60, Math.floor(durationSec / totalSlots))
  );
  const minTarget = nowSec + minLead;
  const cycle = Math.ceil((minTarget - phase) / durationSec);
  return cycle * durationSec + phase;
}

function gridAssetForExpiry(assets, expiry, durationSec, totalSlots) {
  const stepSec = Math.max(1, Math.floor(durationSec / totalSlots));
  const gridIndex = Math.round((expiry + 5) / stepSec);
  const idx = ((gridIndex % assets.length) + assets.length) % assets.length;
  return assets[idx];
}

const GRID_PRE_OPEN_LEAD_SEC = 30;

function planMissingMarkets(cfg, liveMarkets, nowSec) {
  const totalSlots = Math.max(cfg.assets.length, Number(cfg.slots || cfg.assets.length));
  const gridMode = totalSlots > cfg.assets.length;

  if (!gridMode) {
    const liveAssets = new Set(liveMarkets.map((m) => m.asset));
    return cfg.assets
      .map((asset, slotIndex) => ({
        asset,
        slotIndex,
        expiry: computeStaggeredExpiry(nowSec, cfg.durationSec, slotIndex, cfg.assets.length),
      }))
      .filter(({ asset }) => !liveAssets.has(asset.key));
  }

  const stepSec = Math.max(1, Math.floor(cfg.durationSec / totalSlots));
  const toleranceSec = Math.floor(stepSec / 2);
  const preOpenLeadSec = Math.min(GRID_PRE_OPEN_LEAD_SEC, Math.floor(stepSec / 2));
  const maxOpenExpiry = nowSec + cfg.durationSec + preOpenLeadSec;
  const candidates = [];
  for (let slotIndex = 0; slotIndex < totalSlots; slotIndex += 1) {
    const expiry = computeStaggeredExpiry(nowSec, cfg.durationSec, slotIndex, totalSlots);
    if (expiry > maxOpenExpiry) continue;
    const asset = gridAssetForExpiry(cfg.assets, expiry, cfg.durationSec, totalSlots);
    candidates.push({ asset, slotIndex, expiry });
  }
  candidates.sort((a, b) => a.expiry - b.expiry);

  return candidates.filter(
    ({ asset, expiry }) =>
      !liveMarkets.some(
        (m) => m.asset === asset.key && Math.abs(m.expiry - expiry) <= toleranceSec
      )
  );
}

function inferAssetKey(entry, ocr2State) {
  if (entry.asset && ASSET_CATALOG[entry.asset]) return entry.asset;
  if (ocr2State) {
    const stateStr = ocr2State.toBase58();
    for (const spec of Object.values(ASSET_CATALOG)) {
      const configured = envStr([spec.stateEnv], spec.defaultOcr2State);
      if (stateStr === spec.defaultOcr2State || stateStr === configured) return spec.key;
    }
  }
  const title = String(entry.title || "").toUpperCase();
  for (const spec of Object.values(ASSET_CATALOG)) {
    if (title.startsWith(spec.symbol)) return spec.key;
  }
  return "btc";
}

async function batchSyncOpenMarkets(connection, state, nowSec) {
  const openEntries = state.markets.filter((m) => m.status === "open");
  const liveAssets = new Set();
  for (let i = 0; i < openEntries.length; i += 100) {
    const chunk = openEntries.slice(i, i + 100);
    const pubkeys = chunk.map((e) => new PublicKey(e.address));
    const infos = await connection.getMultipleAccountsInfo(pubkeys, "confirmed");
    for (let j = 0; j < chunk.length; j += 1) {
      const entry = chunk[j];
      const info = infos[j];
      if (!info) {
        entry.status = "closed";
        entry.recycled = true;
        continue;
      }
      try {
        const decoded = decodeMarket(Buffer.from(info.data));
        entry.asset = inferAssetKey(entry, decoded.ocr2State);
        entry.expiry = decoded.expiry;
        entry.endTs = decoded.endTs;
        entry.accountSize = info.data.length;
        entry.startTs = decoded.startTs;
        if (isLegacyMarketAccount(info, decoded)) {
          entry.legacy = true;
          if (!entry.legacyLogged) {
            entry.legacyLogged = true;
            console.log(
              `[tick] skip legacy market ${entry.address} (size=${info.data.length}, startTs=${decoded.startTs})`
            );
          }
          if (decoded.status !== "open") {
            entry.status = decoded.status;
            entry.winner = decoded.winner;
            entry.recycled = true;
          }
          continue;
        }
        if (decoded.status !== "open") {
          entry.status = decoded.status;
          entry.winner = decoded.winner;
          continue;
        }
        if (decoded.expiry > nowSec) {
          liveAssets.add(entry.asset);
        }
      } catch (err) {
        console.warn(`[tick] failed to sync market ${entry.address}: ${err?.message || err}`);
      }
    }
  }
  return liveAssets;
}

async function runSelfCheck() {
  const cfg = getConfig();
  const { idl, idlPath } = loadIdl(cfg.programId);
  const settleScriptPath = resolveSettleScript();

  const titles = cfg.assets.map((asset) => {
    const t = titleForAsset(cfg, asset);
    encodePrediction(t);
    return t;
  });

  // Check staggered expiry spacing across all configured slots
  const sampleNow = 1_763_900_000;
  const totalSlots = Math.max(cfg.assets.length, Number(cfg.slots || cfg.assets.length));
  const expiries = Array.from({ length: totalSlots }, (_, idx) =>
    computeStaggeredExpiry(sampleNow, cfg.durationSec, idx, totalSlots)
  ).sort((a, b) => a - b);
  if (new Set(expiries).size !== expiries.length) {
    throw new Error(`Staggered expiries collided: ${expiries.join(", ")}`);
  }

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
    ocr2State: cfg.assets[0].ocr2State,
    marketId,
    prediction: encodePrediction(titles[0]),
    expiry: expiries[0],
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
      version: 2,
      nextBetSide: "no",
      dailyCounts: {},
      markets: [{ address: createRes.pdas.market.toBase58(), asset: cfg.assets[0].key, status: "open" }],
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
    durationSec: cfg.durationSec,
    slots: totalSlots,
    assets: cfg.assets.map((a) => a.key),
    staggeredExpiries: expiries,
    sampleMarketPda: createRes.pdas.market.toBase58(),
  });
}

async function runTick() {
  const cfg = getConfig();
  const { idl } = loadIdl(cfg.programId);
  const settleScriptPath = resolveSettleScript();
  const payer = loadKeypair(cfg.walletPath);
  const connection = createRpcConnection(cfg.rpcUrl);
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const state = loadState(cfg.statePath);
  let nowSec = Math.floor(Date.now() / 1000);

  // 1. Batch-sync open tracked markets, infer asset keys, and self-sweep settlement
  try {
    await batchSyncOpenMarkets(connection, state, nowSec);
    saveState(cfg.statePath, state);
  } catch (err) {
    console.warn(`[tick] batchSyncOpenMarkets error (continuing): ${err?.message || err}`);
  }
  let watchedAddrs = new Set();
  try {
    const watchDue = scheduleWatches(cfg, settleScriptPath, state.markets, nowSec);
    watchedAddrs = new Set(watchDue.map((e) => e.address));
  } catch (err) {
    console.warn(`[tick] scheduleWatches error (continuing): ${err?.message || err}`);
  }
  try {
    const settledDue = await scheduleExpiredSettlements(
      cfg,
      settleScriptPath,
      state.markets,
      nowSec,
      watchedAddrs
    );
    if (settledDue.length > 0) saveState(cfg.statePath, state);
  } catch (err) {
    console.warn(`[tick] scheduleExpiredSettlements error (continuing): ${err?.message || err}`);
  }

  // 2. Open missing staggered markets FIRST (guarantees zero gap even if settlement RPC stalls)
  nowSec = Math.floor(Date.now() / 1000);
  const liveMarkets = state.markets.filter((m) => m.status === "open" && Number(m.expiry) > nowSec);
  const missingSlots = planMissingMarkets(cfg, liveMarkets, nowSec);

  if (missingSlots.length === 0) {
    console.log(
      `[tick] All staggered slots (${cfg.slots} slots across ${cfg.assets.map((a) => a.key).join(",")}) already live.`
    );
  } else if (!isActiveWindowOpen(cfg, nowSec)) {
    console.log("[tick] Outside SANDBOX_ACTIVE_FILE activity window; skipping creation.");
  } else {
    const mintMeta = await fetchMintMeta(connection, cfg.collateralMint);
    const scale = 10 ** mintMeta.decimals;
    const minSeedAtoms = BigInt(Math.round(cfg.seedMinUsdt * scale));
    const maxSeedAtoms = BigInt(Math.round(cfg.seedMaxUsdt * scale));
    const betAtoms = BigInt(Math.round(cfg.betUsdt * scale));
    if (minSeedAtoms <= 1_000_000n) {
      throw new Error("SANDBOX_SEED_MIN_USDT must produce > 1,000,000 raw collateral units");
    }

    const creatorCollateralAta = ataOf(cfg.collateralMint, payer.publicKey, mintMeta.tokenProgram);
    let [solLamports, usdtBal] = await Promise.all([
      connection.getBalance(payer.publicKey, "confirmed"),
      safeTokenAmount(connection, creatorCollateralAta, mintMeta.tokenProgram),
    ]);

    // If SOL or collateral is tight because resolved markets haven't been reclaimed yet, reclaim once on-demand.
    if (
      cfg.recycleFunds &&
      (usdtBal.amount < maxSeedAtoms + betAtoms || solLamports < cfg.minSolLamports)
    ) {
      await recycleFinalizedEntries(connection, program, payer, cfg, state);
      [solLamports, usdtBal] = await Promise.all([
        connection.getBalance(payer.publicKey, "confirmed"),
        safeTokenAmount(connection, creatorCollateralAta, mintMeta.tokenProgram),
      ]);
    }

    for (const { asset, slotIndex, expiry: plannedExpiry } of missingSlots) {
      nowSec = Math.floor(Date.now() / 1000);
      if (solLamports < cfg.minSolLamports) {
        console.warn(
          `[tick] Operator SOL balance ${solLamports} lamports is below SANDBOX_MIN_SOL_LAMPORTS (${cfg.minSolLamports}); skipping creation and continuing settlement & recycling.`
        );
        break;
      }

      const today = utcDayKey(nowSec);
      const todayCount = Number(state.dailyCounts[today] || 0);
      if (cfg.dailyMaxMarkets > 0 && todayCount >= cfg.dailyMaxMarkets) {
        console.log(`[tick] Daily cap (${cfg.dailyMaxMarkets}) reached for ${today}; skipping ${asset.key}.`);
        break;
      }

      const marketSeedUsdt = pickSeedUsdt(cfg);
      const seedAtoms = BigInt(Math.round(marketSeedUsdt * scale));

      if (usdtBal.amount < seedAtoms + betAtoms) {
        console.warn(
          `[tick] Collateral balance ${usdtBal.amount} below ${seedAtoms + betAtoms}; cannot open ${asset.key}; continuing settlement & recycling.`
        );
        break;
      }

      try {
        const feedInfo = await connection.getAccountInfo(asset.feed, "confirmed");
        if (!feedInfo) {
          console.warn(`[tick] Chainlink feed account not found for ${asset.symbol}: ${asset.feed.toBase58()}`);
          continue;
        }

        const feed = decodeChainlinkFeed(Buffer.from(feedInfo.data));
        const title = titleForAsset(cfg, asset);
        const expiry =
          cfg.slots > cfg.assets.length
            ? plannedExpiry
            : computeStaggeredExpiry(nowSec, cfg.durationSec, slotIndex, cfg.assets.length);
        const marketId = Array.from(crypto.randomBytes(MARKET_ID_BYTES));
        const prediction = encodePrediction(title);

        const { pdas, ixs: createIxs } = await buildCreateMarketIxs(program, {
          creator: payer.publicKey,
          collateralMint: cfg.collateralMint,
          ocr2State: asset.ocr2State,
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
          asset: asset.key,
          idHex: Buffer.from(marketId).toString("hex"),
          title,
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
        scheduleWatches(cfg, settleScriptPath, [entry]);
        state.dailyCounts[today] = todayCount + 1;
        saveState(cfg.statePath, state);
        console.log(
          `[create] (${asset.symbol}) ${marketAddr} seed=${marketSeedUsdt.toFixed(2)} USDT expiry=${expiry} threshold=${feed.answer.toString()} tx=${createSig}`
        );
        await persistCreatedMarketToDb(connection, cfg.programId, pdas.market, nowSec);

        // Place alternating 2 USDT opening bet on the new market
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
        console.log(`[bet] (${asset.symbol}) ${marketAddr} side=${side} amount=${cfg.betUsdt} USDT tx=${betSig}`);
        await persistCreatedMarketToDb(connection, cfg.programId, pdas.market, nowSec);

        [solLamports, usdtBal] = await Promise.all([
          connection.getBalance(payer.publicKey, "confirmed"),
          safeTokenAmount(connection, creatorCollateralAta, mintMeta.tokenProgram),
        ]);
      } catch (err) {
        console.error(`[create] error on ${asset.symbol} (continuing): ${err?.message || err}`);
      }
    }
  }

  // Expiry watchers and the global sweep run independently of fund recycling.
  if (cfg.recycleFunds) {
    await recycleFinalizedEntries(connection, program, payer, cfg, state);
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

  await runIncrementalSyncSafe(connection, cfg.programId, 2);
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

if (require.main === module) main().catch((err) => {
  console.error("SANDBOX_TICK_FAIL:", err && err.stack ? err.stack : err);
  process.exit(1);
});

module.exports = {
  ASSET_CATALOG,
  DEFAULT_RPC,
  DEFAULT_PROGRAM_ID,
  DEFAULT_COLLATERAL_MINT,
  DEFAULT_ASSETS,
  MARKET_ACCOUNT_SIZE,
  MARKET_ACCOUNT_SIZE_V2,
  MARKET_ID_BYTES,
  FEED_MIN_LEN,
  FEED_DECIMALS_OFFSET,
  FEED_COUNTER_OFFSET,
  FEED_TS_OFFSET,
  FEED_ANSWER_OFFSET,
  RESOLVE_WINDOW_SEC,
  envStr,
  envNum,
  envBool,
  parseAssets,
  defaultTitleForAsset,
  resolveSettleScript,
  loadIdl,
  loadKeypair,
  utcDayKey,
  loadState,
  saveState,
  encodePrediction,
  decodeMarket,
  decodeChainlinkFeed,
  fetchMintMeta,
  ataOf,
  ensureAtaIx,
  safeTokenAmount,
  sendAndConfirm,
  buildCreateMarketIxs,
  buildUserBetOnIxs,
  resolveAssetForEntry,
  selectWatchEntries,
  selectExpiredSettleEntries,
  scheduleWatches,
  scheduleExpiredSettlements,
  batchSyncOpenMarkets,
  recycleFinalizedEntries,
  isActiveWindowOpen,
  persistCreatedMarketToDb,
  runIncrementalSyncSafe,
  createRpcConnection,
  settleRetryCooldownSec,
  classifySettleProcess,
  listSettleProcesses,
  reapStaleSettleProcesses,
  probeFreeSettleSlots,
  DEFAULT_SETTLE_SLOTS,
  DEFAULT_SETTLE_MAX_TOTAL_PROCS,
  DEFAULT_SETTLE_STALE_MAX_AGE_SEC,
  SELF_SETTLE_SLOT_PREFIX,
  DEFAULT_SEED_MIN_USDT,
  DEFAULT_SEED_MAX_USDT,
  getConfig,
  pickSeedUsdt,
  slotOffsetSec,
  computeStaggeredExpiry,
  gridAssetForExpiry,
  planMissingMarkets,
  isLegacyMarketAccount,
  isLegacyEntry,
};
