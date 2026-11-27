#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { PublicKey } = require("@solana/web3.js");

let BetterSqlite3 = null;
function getDatabaseClass() {
  if (!BetterSqlite3) {
    BetterSqlite3 = require("better-sqlite3");
  }
  return BetterSqlite3;
}

const DEFAULT_PROGRAM_ID = "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER";
const MARKET_ACCOUNT_SIZE = 409;
const MARKET_ACCOUNT_SIZE_V2 = 415;
const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154];
const LP_POSITION_DISCRIMINATOR = [105, 241, 37, 200, 224, 2, 252, 90];
const MARKET_SNAPSHOT_DISCRIMINATOR = [107, 32, 221, 188, 130, 114, 104, 28];
const I80F48_SCALE = 1n << 48n;
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);
const SQRT_2 = Math.SQRT2;

const FEEDS = [
  {
    key: "btc",
    symbol: "BTC/USD",
    feed: "6PxBx93S8x3tno1TsFZwT5VqP8drrRCbCXygEXYNkFJe",
    state: "HCKJKQ8xFfqm5BxTA6LaUCWYXNShYXF4eAwC7NhBYXkj",
    decimals: 8,
  },
  {
    key: "eth",
    symbol: "ETH/USD",
    feed: "669U43LNHx7LsVj95uYksnhXUfWKDsdzVqev3V4Jpw3P",
    state: "7zDTDDXiMqwbEEE17ZuFE4A6K5uBQo15tG1gkgdKZQB2",
    decimals: 8,
  },
  {
    key: "sol",
    symbol: "SOL/USD",
    feed: "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR",
    state: "EpFp9mhi9cvZL9Lp59S1mt2twv2dtZGgFUvZEQMZ9Ra8",
    decimals: 8,
  },
  {
    key: "link",
    symbol: "LINK/USD",
    feed: "HXoZZBWv25N4fm2vfSKnHXTeDJ31qaAcWZe3ZKeM6dQv",
    state: "Ghm1a2c2NGPg6pKGG3PP1GLAuJkHm1RKMPqqJwPM7JpJ",
    decimals: 8,
  },
  {
    key: "usdc",
    symbol: "USDC/USD",
    feed: "2EmfL3MqL3YHABudGNmajjCpR13NNEn9Y4LWxbDm6SwR",
    state: "ENVhPWE3nuvwc5qx2MjSwS41SXr33gFgGaWX4ATA9pyV",
    decimals: 8,
  },
  {
    key: "usdt",
    symbol: "USDT/USD",
    feed: "8QQSUPtdRTboa4bKyMftVNRfGFsB4Vp9d7r39hGKi53e",
    state: "DcZuU19fXJSEurnuFh4moeYK5hohvgaBD5KmjvHvYEG1",
    decimals: 8,
  },
];

const FEED_BY_STATE = new Map(FEEDS.map((f) => [f.state, f]));

const DURATION_EN_TITLE =
  /^([A-Z0-9]+\/[A-Z0-9]+)\s+(at or above|at or below|above|below)\s+(opening price|[\d,.]+)\s+in\s+(\d+)\s*(min|mins|minute|minutes|m|hour|hours|hr|hrs|h|day|days|d|sec|secs|second|seconds|s)\s*\??$/i;
const DURATION_ZH_TITLE =
  /^([A-Z0-9]+\/[A-Z0-9]+)\s+(\d+)\s*(分钟|小时|天|秒)(?:后|内)?\s*(能站上|会跌破)\s*(开盘价|[\d,.]+)\s*吗[？?]?$/i;

const UNIT_SECONDS = { sec: 1, min: 60, hour: 3600, day: 86_400 };

function normalizeDurationUnit(raw) {
  const u = String(raw).toLowerCase();
  if (u === "分钟" || u.startsWith("m")) return "min";
  if (u === "小时" || u.startsWith("h")) return "hour";
  if (u === "天" || u.startsWith("d")) return "day";
  return "sec";
}

function marketDurationSec(title) {
  const raw = String(title || "");
  const en = DURATION_EN_TITLE.exec(raw);
  if (en) {
    const sec = Number(en[4]) * UNIT_SECONDS[normalizeDurationUnit(en[5])];
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  }
  const zh = DURATION_ZH_TITLE.exec(raw);
  if (zh) {
    const sec = Number(zh[2]) * UNIT_SECONDS[normalizeDurationUnit(zh[3])];
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  }
  return null;
}

function marketDurationBucket(title) {
  const sec = marketDurationSec(title);
  if (sec === 120) return "2m";
  if (sec === 900) return "15m";
  if (sec === 86_400) return "24h";
  return null;
}

function feedByState(ocr2State) {
  const addr = typeof ocr2State === "string" ? ocr2State.trim() : ocr2State.toBase58();
  return FEED_BY_STATE.get(addr) || null;
}

function resolveDbPath(explicitPath) {
  const envPath = process.env.VERITAS_DB_PATH && process.env.VERITAS_DB_PATH.trim();
  const chosen = explicitPath || envPath || path.resolve(__dirname, "..", "data", "veritas.db");
  return path.resolve(chosen);
}

function applyPragmas(db, readonly) {
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
  }
  db.pragma("busy_timeout = 5000");
  db.pragma("cache_size = -8000");
  db.pragma("mmap_size = 0");
  db.pragma("temp_store = FILE");
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      address TEXT PRIMARY KEY,
      program_id TEXT NOT NULL,
      id_hex TEXT NOT NULL,
      bump INTEGER NOT NULL,
      creator TEXT NOT NULL,
      title TEXT NOT NULL,
      feed_key TEXT,
      feed_symbol TEXT NOT NULL,
      ocr2_state TEXT NOT NULL,
      collateral_mint TEXT NOT NULL,
      token_program TEXT NOT NULL,
      decimals INTEGER NOT NULL DEFAULT 6,
      yes_mint TEXT NOT NULL,
      no_mint TEXT NOT NULL,
      opened_at INTEGER,
      start_ts INTEGER,
      expiry INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      finish_ts INTEGER NOT NULL DEFAULT 0,
      duration_sec INTEGER,
      duration_bucket TEXT,
      status TEXT NOT NULL,
      winner TEXT,
      threshold TEXT NOT NULL,
      price_decimals INTEGER NOT NULL DEFAULT 8,
      settle_above INTEGER NOT NULL DEFAULT 1,
      settled_price TEXT NOT NULL DEFAULT '0',
      settled_publish_time INTEGER NOT NULL DEFAULT 0,
      fee_bps INTEGER NOT NULL DEFAULT 30,
      l_zero TEXT NOT NULL DEFAULT '0',
      last_accrual_ts INTEGER NOT NULL DEFAULT 0,
      cum_yes_per_share TEXT NOT NULL DEFAULT '0',
      cum_no_per_share TEXT NOT NULL DEFAULT '0',
      reserve_yes TEXT NOT NULL DEFAULT '0',
      reserve_no TEXT NOT NULL DEFAULT '0',
      total_lp_shares TEXT NOT NULL DEFAULT '0',
      yes_pool TEXT NOT NULL DEFAULT '0',
      no_pool TEXT NOT NULL DEFAULT '0',
      vault TEXT NOT NULL DEFAULT '0',
      yes_price REAL NOT NULL DEFAULT 0.5,
      no_price REAL NOT NULL DEFAULT 0.5,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_markets_status_expiry
      ON markets (program_id, status, expiry DESC);
    CREATE INDEX IF NOT EXISTS idx_markets_status_bucket_expiry
      ON markets (program_id, status, duration_bucket, expiry DESC);
    CREATE INDEX IF NOT EXISTS idx_markets_expiry
      ON markets (program_id, expiry DESC, status);
    CREATE INDEX IF NOT EXISTS idx_markets_bucket_expiry
      ON markets (program_id, duration_bucket, expiry DESC, status);
    CREATE INDEX IF NOT EXISTS idx_markets_yes_mint
      ON markets (yes_mint);
    CREATE INDEX IF NOT EXISTS idx_markets_no_mint
      ON markets (no_mint);
    CREATE INDEX IF NOT EXISTS idx_markets_creator_status_finish
      ON markets (program_id, creator, status, finish_ts);

    CREATE TABLE IF NOT EXISTS settlement_evidence (
      market_address TEXT PRIMARY KEY,
      program_id TEXT NOT NULL,
      feed_address TEXT,
      snapshot_address TEXT NOT NULL,
      resolve_signature TEXT NOT NULL,
      resolve_tx_url TEXT,
      settled_price TEXT NOT NULL,
      price_decimals INTEGER NOT NULL DEFAULT 8,
      winner TEXT,
      status TEXT NOT NULL DEFAULT 'resolved',
      pre_epoch INTEGER NOT NULL,
      pre_round INTEGER NOT NULL,
      pre_counter INTEGER,
      pre_price TEXT NOT NULL,
      pre_timestamp INTEGER NOT NULL,
      pre_push_signature TEXT,
      pre_push_tx_url TEXT,
      post_epoch INTEGER NOT NULL,
      post_round INTEGER NOT NULL,
      post_counter INTEGER,
      post_price TEXT NOT NULL,
      post_timestamp INTEGER NOT NULL,
      post_push_signature TEXT,
      post_push_tx_url TEXT,
      missing_count INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_positions (
      wallet TEXT NOT NULL,
      market_address TEXT NOT NULL,
      program_id TEXT NOT NULL,
      yes_amount TEXT NOT NULL DEFAULT '0',
      no_amount TEXT NOT NULL DEFAULT '0',
      lp_shares TEXT NOT NULL DEFAULT '0',
      pending_yes TEXT NOT NULL DEFAULT '0',
      pending_no TEXT NOT NULL DEFAULT '0',
      claimable_amount TEXT NOT NULL DEFAULT '0',
      can_claim INTEGER NOT NULL DEFAULT 0,
      collateral_amount TEXT NOT NULL DEFAULT '0',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (wallet, market_address)
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_positions_wallet
      ON wallet_positions (program_id, wallet, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_positions_market
      ON wallet_positions (market_address);

    CREATE TABLE IF NOT EXISTS wallet_sync_state (
      wallet TEXT NOT NULL,
      program_id TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (wallet, program_id)
    );
  `);

  const marketCols = db.prepare("PRAGMA table_info(markets)").all();
  if (!marketCols.some((c) => c.name === "start_ts")) {
    db.exec("ALTER TABLE markets ADD COLUMN start_ts INTEGER");
  }
}

function openDb(dbPath, { readonly = false, skipInit = false } = {}) {
  const resolved = resolveDbPath(dbPath);
  if (!readonly) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }
  const Database = getDatabaseClass();
  const db = new Database(
    resolved,
    readonly ? { readonly: true, fileMustExist: true } : undefined
  );
  try {
    applyPragmas(db, readonly);
    if (!readonly && !skipInit) {
      initSchema(db);
    }
    return db;
  } catch (err) {
    try {
      if (db.open) db.close();
    } catch {
      // ignore close errors when opening a corrupted DB
    }
    throw err;
  }
}

function tryOpenDb(dbPath, opts = {}) {
  try {
    return openDb(dbPath, opts);
  } catch {
    return null;
  }
}

function sameDisc(actual, expected) {
  if (!actual || actual.length < expected.length) return false;
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
  u32() {
    return this.take(4).readUInt32LE(0);
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

function decodePrediction(bytes) {
  const buf = Buffer.from(bytes);
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString("utf8").replace(/\0/g, "").trim();
}

function decodeMarketFull(data) {
  const buf = Buffer.from(data);
  const isV2 = buf.length === MARKET_ACCOUNT_SIZE_V2;
  const isLegacy = buf.length === MARKET_ACCOUNT_SIZE;
  if ((!isLegacy && !isV2) || !sameDisc(buf, MARKET_DISCRIMINATOR)) {
    throw new Error("Invalid PredictionMarket Market account");
  }
  const c = new Cursor(buf, 8);
  const expiry = c.u64();
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
  const winner =
    winnerTag === 0 ? null : winnerTag === 1 ? (c.u8() === 0 ? "yes" : "no") : null;
  if (winnerTag !== 0 && winnerTag !== 1) {
    throw new Error(`Invalid winner tag: ${winnerTag}`);
  }
  const marketCollateralBump = c.u8();
  const prediction = c.bytes(64);
  const finishTs = c.u64();
  const lZero = c.i128();
  const lastAccrualTs = c.i64();
  const cumYesPerShare = c.i128();
  const cumNoPerShare = c.i128();
  const feeBps = isLegacy ? c.u16() : 0;
  const reserveYes = c.i128();
  const reserveNo = c.i128();
  const totalLpShares = c.i128();
  const startTs = isV2 ? c.i64() : null;
  const endTs = c.i64();
  const ocr2State = c.pubkey();
  const threshold = c.i64();
  const priceDecimals = c.u8();
  const settleAbove = c.bool();
  const settledPrice = c.i64();
  const settledPublishTime = c.i64();

  return {
    expiry,
    creator,
    id,
    idHex: Buffer.from(id).toString("hex"),
    bump,
    yesMint,
    noMint,
    status,
    collateralMint,
    winner,
    marketCollateralBump,
    prediction,
    title: decodePrediction(prediction),
    finishTs,
    lZero,
    lastAccrualTs,
    cumYesPerShare,
    cumNoPerShare,
    feeBps,
    reserveYes,
    reserveNo,
    totalLpShares,
    startTs,
    endTs,
    ocr2State,
    threshold,
    priceDecimals,
    settleAbove,
    settledPrice,
    settledPublishTime,
  };
}

function decodeLpPosition(data) {
  const buf = Buffer.from(data);
  if (!sameDisc(buf, LP_POSITION_DISCRIMINATOR)) return null;
  const c = new Cursor(buf, 8);
  return {
    owner: c.pubkey(),
    shares: c.i128(),
    checkpointYes: c.i128(),
    checkpointNo: c.i128(),
    bump: c.u8(),
  };
}

function decodeMarketSnapshot(data) {
  const buf = Buffer.from(data);
  if (!sameDisc(buf, MARKET_SNAPSHOT_DISCRIMINATOR)) return null;
  const c = new Cursor(buf, 8);
  const len = c.u32();
  if (len > 16) return null;
  const entries = [];
  for (let i = 0; i < len; i += 1) {
    entries.push({
      epoch: c.u32(),
      round: c.u8(),
      counter: c.u32(),
      price: c.i128(),
      ts: c.i64(),
    });
  }
  const bump = c.u8();
  return { entries, bump };
}

function i80f48ToNumber(bits) {
  return Number(bits) / Number(I80F48_SCALE);
}

function i80f48ToAmount(bits) {
  if (bits >= 0n) return bits / I80F48_SCALE;
  return -((-bits) / I80F48_SCALE);
}

function computePending(sharesBits, checkpointYes, checkpointNo, cumYes, cumNo) {
  const shares = i80f48ToNumber(sharesBits);
  if (shares <= 0) return { yes: 0n, no: 0n };
  const dy = Math.max(0, i80f48ToNumber(cumYes - checkpointYes) * shares);
  const dn = Math.max(0, i80f48ToNumber(cumNo - checkpointNo) * shares);
  return { yes: BigInt(Math.floor(dy)), no: BigInt(Math.floor(dn)) };
}

function erfApprox(x) {
  const neg = x < 0;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const res = 1 - poly * Math.exp(-ax * ax);
  return neg ? -res : res;
}

function normalCdf(z) {
  if (z < -8) return 0;
  if (z > 8) return 1;
  return 0.5 * (1 + erfApprox(z / SQRT_2));
}

function pmAmmLeff(lZeroBits, remainingSecs) {
  if (lZeroBits <= 0n || remainingSecs <= 0) return 0;
  return i80f48ToNumber(lZeroBits) * Math.sqrt(remainingSecs);
}

function computeYesPrice(account) {
  const rYes = i80f48ToAmount(account.reserveYes);
  const rNo = i80f48ToAmount(account.reserveNo);
  const reserveYes = rYes > 0n ? rYes : 0n;
  const reserveNo = rNo > 0n ? rNo : 0n;
  const lEff =
    account.lZero > 0n && account.endTs > account.lastAccrualTs
      ? pmAmmLeff(account.lZero, Number(account.endTs - account.lastAccrualTs))
      : 0;
  const y = Number(reserveYes);
  const n = Number(reserveNo);
  if (Number.isFinite(lEff) && lEff > 0) {
    return normalCdf((n - y) / lEff);
  }
  const sum = y + n;
  if (!Number.isFinite(sum) || sum <= 0) return 0.5;
  return n / sum;
}

function findMarketPdas(programId, marketId) {
  const pid = typeof programId === "string" ? new PublicKey(programId) : programId;
  const idBuf = Buffer.from(marketId);
  const [market, marketBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), idBuf],
    pid
  );
  const [snapshot] = PublicKey.findProgramAddressSync(
    [Buffer.from("snapshot"), market.toBuffer()],
    pid
  );
  const [yesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_mint"), market.toBuffer()],
    pid
  );
  const [noMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("no_mint"), market.toBuffer()],
    pid
  );
  const [collateralVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_vault"), market.toBuffer()],
    pid
  );
  const [yesPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_pool"), market.toBuffer()],
    pid
  );
  const [noPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("no_pool"), market.toBuffer()],
    pid
  );
  return { market, marketBump, snapshot, yesMint, noMint, collateralVault, yesPool, noPool };
}

function findLpPosition(programId, market, owner) {
  const pid = typeof programId === "string" ? new PublicKey(programId) : programId;
  const mPk = typeof market === "string" ? new PublicKey(market) : market;
  const oPk = typeof owner === "string" ? new PublicKey(owner) : owner;
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), mPk.toBuffer(), oPk.toBuffer()],
    pid
  )[0];
}

function explorerTxUrl(sig, cluster = "devnet") {
  if (!sig || cluster === "localnet") return null;
  const q = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${sig}${q}`;
}

function isVoidedStatus(status) {
  return status === "windowBurn" || status === "staleBurn";
}

function isFinalizedStatus(status) {
  return status === "resolved" || isVoidedStatus(status);
}

function claimableOf(status, winner, yesAmount, noAmount) {
  const yes = BigInt(yesAmount || 0);
  const no = BigInt(noAmount || 0);
  if (status === "resolved") {
    return winner === "yes" ? yes : winner === "no" ? no : 0n;
  }
  if (isVoidedStatus(status)) {
    return yes / 2n + no / 2n;
  }
  return 0n;
}

function witnessCounts(snapshot, pre, post) {
  if (!snapshot || !Array.isArray(snapshot.entries)) return null;
  const match = (r) =>
    snapshot.entries.find(
      (e) =>
        Number(e.epoch) === Number(r.epoch) &&
        Number(e.round) === Number(r.round) &&
        BigInt(e.ts) === BigInt(r.observationsTimestamp) &&
        BigInt(e.price) === BigInt(r.median)
    );
  const a = match(pre);
  const b = match(post);
  return a && b && Number(b.counter) > Number(a.counter)
    ? [Number(a.counter), Number(b.counter)]
    : null;
}

function buildMarketRow({
  programId,
  address,
  account,
  tokenProgram,
  decimals = 6,
  yesPool = 0n,
  noPool = 0n,
  vault = 0n,
  openedAt = null,
  updatedAt = Math.floor(Date.now() / 1000),
}) {
  const title = account.title;
  const durationSec = marketDurationSec(title);
  const durationBucket = marketDurationBucket(title);
  const endTs = Number(account.endTs);
  const startTs =
    account.startTs != null && BigInt(account.startTs) > 0n
      ? Number(account.startTs)
      : null;
  const inferredOpen =
    openedAt != null
      ? Number(openedAt)
      : startTs != null
        ? startTs
        : durationSec != null && endTs > durationSec
          ? endTs - durationSec
          : null;
  const rYes = i80f48ToAmount(account.reserveYes);
  const rNo = i80f48ToAmount(account.reserveNo);
  const reserveYes = rYes > 0n ? rYes : 0n;
  const reserveNo = rNo > 0n ? rNo : 0n;
  const lpShares = i80f48ToAmount(account.totalLpShares);
  const totalLpShares = lpShares > 0n ? lpShares : 0n;
  const yesPrice = computeYesPrice(account);
  const preset = feedByState(account.ocr2State);
  const ocr2Str = account.ocr2State.toBase58();

  return {
    address: typeof address === "string" ? address : address.toBase58(),
    program_id: typeof programId === "string" ? programId : programId.toBase58(),
    id_hex: account.idHex,
    bump: account.bump,
    creator: account.creator.toBase58(),
    title,
    feed_key: preset ? preset.key : null,
    feed_symbol: preset ? preset.symbol : ocr2Str.slice(0, 8),
    ocr2_state: ocr2Str,
    collateral_mint: account.collateralMint.toBase58(),
    token_program:
      typeof tokenProgram === "string"
        ? tokenProgram
        : tokenProgram.toBase58(),
    decimals: Number(decimals),
    yes_mint: account.yesMint.toBase58(),
    no_mint: account.noMint.toBase58(),
    opened_at: inferredOpen,
    start_ts: startTs,
    expiry: Number(account.expiry),
    end_ts: endTs,
    finish_ts: Number(account.finishTs),
    duration_sec: durationSec,
    duration_bucket: durationBucket,
    status: account.status,
    winner: account.winner || null,
    threshold: account.threshold.toString(),
    price_decimals: Number(account.priceDecimals),
    settle_above: account.settleAbove ? 1 : 0,
    settled_price: account.settledPrice.toString(),
    settled_publish_time: Number(account.settledPublishTime),
    fee_bps: Number(account.feeBps),
    l_zero: account.lZero.toString(),
    last_accrual_ts: Number(account.lastAccrualTs),
    cum_yes_per_share: account.cumYesPerShare.toString(),
    cum_no_per_share: account.cumNoPerShare.toString(),
    reserve_yes: reserveYes.toString(),
    reserve_no: reserveNo.toString(),
    total_lp_shares: totalLpShares.toString(),
    yes_pool: BigInt(yesPool || 0n).toString(),
    no_pool: BigInt(noPool || 0n).toString(),
    vault: BigInt(vault || 0n).toString(),
    yes_price: yesPrice,
    no_price: 1 - yesPrice,
    updated_at: Number(updatedAt),
  };
}

const UPSERT_MARKET_SQL = `
  INSERT INTO markets (
    address, program_id, id_hex, bump, creator, title, feed_key, feed_symbol,
    ocr2_state, collateral_mint, token_program, decimals, yes_mint, no_mint,
    opened_at, start_ts, expiry, end_ts, finish_ts, duration_sec, duration_bucket,
    status, winner, threshold, price_decimals, settle_above, settled_price,
    settled_publish_time, fee_bps, l_zero, last_accrual_ts, cum_yes_per_share,
    cum_no_per_share, reserve_yes, reserve_no, total_lp_shares, yes_pool,
    no_pool, vault, yes_price, no_price, updated_at
  ) VALUES (
    @address, @program_id, @id_hex, @bump, @creator, @title, @feed_key, @feed_symbol,
    @ocr2_state, @collateral_mint, @token_program, @decimals, @yes_mint, @no_mint,
    @opened_at, @start_ts, @expiry, @end_ts, @finish_ts, @duration_sec, @duration_bucket,
    @status, @winner, @threshold, @price_decimals, @settle_above, @settled_price,
    @settled_publish_time, @fee_bps, @l_zero, @last_accrual_ts, @cum_yes_per_share,
    @cum_no_per_share, @reserve_yes, @reserve_no, @total_lp_shares, @yes_pool,
    @no_pool, @vault, @yes_price, @no_price, @updated_at
  )
  ON CONFLICT(address) DO UPDATE SET
    program_id = excluded.program_id,
    id_hex = excluded.id_hex,
    bump = excluded.bump,
    creator = excluded.creator,
    title = excluded.title,
    feed_key = excluded.feed_key,
    feed_symbol = excluded.feed_symbol,
    ocr2_state = excluded.ocr2_state,
    collateral_mint = excluded.collateral_mint,
    token_program = excluded.token_program,
    decimals = excluded.decimals,
    yes_mint = excluded.yes_mint,
    no_mint = excluded.no_mint,
    opened_at = COALESCE(markets.opened_at, excluded.opened_at),
    start_ts = COALESCE(excluded.start_ts, markets.start_ts),
    expiry = excluded.expiry,
    end_ts = excluded.end_ts,
    finish_ts = excluded.finish_ts,
    duration_sec = excluded.duration_sec,
    duration_bucket = excluded.duration_bucket,
    status = excluded.status,
    winner = excluded.winner,
    threshold = excluded.threshold,
    price_decimals = excluded.price_decimals,
    settle_above = excluded.settle_above,
    settled_price = excluded.settled_price,
    settled_publish_time = excluded.settled_publish_time,
    fee_bps = excluded.fee_bps,
    l_zero = excluded.l_zero,
    last_accrual_ts = excluded.last_accrual_ts,
    cum_yes_per_share = excluded.cum_yes_per_share,
    cum_no_per_share = excluded.cum_no_per_share,
    reserve_yes = excluded.reserve_yes,
    reserve_no = excluded.reserve_no,
    total_lp_shares = excluded.total_lp_shares,
    yes_pool = excluded.yes_pool,
    no_pool = excluded.no_pool,
    vault = excluded.vault,
    yes_price = excluded.yes_price,
    no_price = excluded.no_price,
    updated_at = excluded.updated_at
`;

function upsertMarkets(db, rows) {
  if (!rows || !rows.length) return 0;
  const stmt = db.prepare(UPSERT_MARKET_SQL);
  const runBatch = db.transaction((items) => {
    for (const row of items) {
      stmt.run(row);
    }
  });
  runBatch(rows);
  return rows.length;
}

const UPSERT_EVIDENCE_SQL = `
  INSERT INTO settlement_evidence (
    market_address, program_id, feed_address, snapshot_address,
    resolve_signature, resolve_tx_url, settled_price, price_decimals,
    winner, status, pre_epoch, pre_round, pre_counter, pre_price,
    pre_timestamp, pre_push_signature, pre_push_tx_url,
    post_epoch, post_round, post_counter, post_price,
    post_timestamp, post_push_signature, post_push_tx_url,
    missing_count, created_at
  ) VALUES (
    @market_address, @program_id, @feed_address, @snapshot_address,
    @resolve_signature, @resolve_tx_url, @settled_price, @price_decimals,
    @winner, @status, @pre_epoch, @pre_round, @pre_counter, @pre_price,
    @pre_timestamp, @pre_push_signature, @pre_push_tx_url,
    @post_epoch, @post_round, @post_counter, @post_price,
    @post_timestamp, @post_push_signature, @post_push_tx_url,
    @missing_count, @created_at
  )
  ON CONFLICT(market_address) DO UPDATE SET
    feed_address = COALESCE(settlement_evidence.feed_address, excluded.feed_address),
    pre_counter = COALESCE(settlement_evidence.pre_counter, excluded.pre_counter),
    post_counter = COALESCE(settlement_evidence.post_counter, excluded.post_counter),
    pre_push_signature = COALESCE(settlement_evidence.pre_push_signature, excluded.pre_push_signature),
    pre_push_tx_url = COALESCE(settlement_evidence.pre_push_tx_url, excluded.pre_push_tx_url),
    post_push_signature = COALESCE(settlement_evidence.post_push_signature, excluded.post_push_signature),
    post_push_tx_url = COALESCE(settlement_evidence.post_push_tx_url, excluded.post_push_tx_url),
    missing_count = COALESCE(settlement_evidence.missing_count, excluded.missing_count)
`;

function upsertSettlementEvidence(db, evidence) {
  db.prepare(UPSERT_EVIDENCE_SQL).run({
    market_address: evidence.market_address,
    program_id: evidence.program_id,
    feed_address: evidence.feed_address ?? null,
    snapshot_address: evidence.snapshot_address,
    resolve_signature: evidence.resolve_signature,
    resolve_tx_url: evidence.resolve_tx_url ?? null,
    settled_price: String(evidence.settled_price),
    price_decimals: Number(evidence.price_decimals ?? 8),
    winner: evidence.winner ?? null,
    status: evidence.status ?? "resolved",
    pre_epoch: Number(evidence.pre_epoch),
    pre_round: Number(evidence.pre_round),
    pre_counter: evidence.pre_counter != null ? Number(evidence.pre_counter) : null,
    pre_price: String(evidence.pre_price),
    pre_timestamp: Number(evidence.pre_timestamp),
    pre_push_signature: evidence.pre_push_signature ?? null,
    pre_push_tx_url: evidence.pre_push_tx_url ?? null,
    post_epoch: Number(evidence.post_epoch),
    post_round: Number(evidence.post_round),
    post_counter: evidence.post_counter != null ? Number(evidence.post_counter) : null,
    post_price: String(evidence.post_price),
    post_timestamp: Number(evidence.post_timestamp),
    post_push_signature: evidence.post_push_signature ?? null,
    post_push_tx_url: evidence.post_push_tx_url ?? null,
    missing_count: evidence.missing_count != null ? Number(evidence.missing_count) : null,
    created_at: Number(evidence.created_at ?? Math.floor(Date.now() / 1000)),
  });
}

function replaceWalletPositions(db, wallet, programId, rows, syncedAt = Math.floor(Date.now() / 1000)) {
  const deleteStmt = db.prepare(
    "DELETE FROM wallet_positions WHERE wallet = ? AND program_id = ?"
  );
  const insertStmt = db.prepare(`
    INSERT INTO wallet_positions (
      wallet, market_address, program_id, yes_amount, no_amount, lp_shares,
      pending_yes, pending_no, claimable_amount, can_claim, collateral_amount, updated_at
    ) VALUES (
      @wallet, @market_address, @program_id, @yes_amount, @no_amount, @lp_shares,
      @pending_yes, @pending_no, @claimable_amount, @can_claim, @collateral_amount, @updated_at
    )
  `);
  const syncStmt = db.prepare(`
    INSERT INTO wallet_sync_state (wallet, program_id, synced_at)
    VALUES (?, ?, ?)
    ON CONFLICT(wallet, program_id) DO UPDATE SET synced_at = excluded.synced_at
  `);
  const tx = db.transaction((items) => {
    deleteStmt.run(wallet, programId);
    for (const row of items) {
      insertStmt.run(row);
    }
    syncStmt.run(wallet, programId, syncedAt);
  });
  tx(rows);
}

function refreshClaimableForMarket(db, marketRow) {
  const rows = db
    .prepare(
      "SELECT wallet, yes_amount, no_amount, lp_shares, pending_yes, pending_no FROM wallet_positions WHERE market_address = ?"
    )
    .all(marketRow.address);
  if (!rows.length) return 0;
  const updateStmt = db.prepare(
    "UPDATE wallet_positions SET claimable_amount = ?, can_claim = ?, updated_at = ? WHERE wallet = ? AND market_address = ?"
  );
  const finalized = isFinalizedStatus(marketRow.status);
  const nowSec = Math.floor(Date.now() / 1000);
  const run = db.transaction(() => {
    for (const row of rows) {
      const claimable = claimableOf(
        marketRow.status,
        marketRow.winner,
        row.yes_amount,
        row.no_amount
      );
      const hasLp =
        BigInt(row.lp_shares) > 0n ||
        BigInt(row.pending_yes) > 0n ||
        BigInt(row.pending_no) > 0n;
      const canClaim = finalized && (claimable > 0n || hasLp) ? 1 : 0;
      updateStmt.run(claimable.toString(), canClaim, nowSec, row.wallet, marketRow.address);
    }
  });
  run();
  return rows.length;
}

function getOpenMarketAddresses(db, programId) {
  return db
    .prepare("SELECT address FROM markets WHERE program_id = ? AND status = 'open'")
    .all(programId)
    .map((r) => r.address);
}

function getResolvedMarketsMissingEvidence(db, programId, limit = 10) {
  const sql = `
    SELECT m.*
    FROM markets m
    LEFT JOIN settlement_evidence e ON e.market_address = m.address
    WHERE m.program_id = ?
      AND m.status = 'resolved'
      AND (
        e.market_address IS NULL
        OR e.pre_push_signature IS NULL
        OR e.post_push_signature IS NULL
      )
    ORDER BY m.finish_ts DESC, m.expiry DESC
    ${limit > 0 ? "LIMIT ?" : ""}
  `;
  const stmt = db.prepare(sql);
  return limit > 0 ? stmt.all(programId, limit) : stmt.all(programId);
}

function hasIndexedMarkets(db, programId) {
  const row = db
    .prepare("SELECT 1 AS hit FROM markets WHERE program_id = ? LIMIT 1")
    .get(programId);
  return Boolean(row);
}

function getReclaimableMarkets(db, programId, creator, cutoffSec, limit = 40) {
  return db
    .prepare(`
      SELECT address, collateral_mint, finish_ts, status
      FROM markets
      WHERE program_id = ?
        AND creator = ?
        AND status IN ('resolved', 'windowBurn', 'staleBurn')
        AND finish_ts > 0
        AND finish_ts < ?
      ORDER BY finish_ts ASC
      LIMIT ?
    `)
    .all(programId, creator, cutoffSec, limit);
}

function deleteMissingMarkets(db, addresses) {
  if (!addresses || !addresses.length) return 0;
  const delMarket = db.prepare("DELETE FROM markets WHERE address = ?");
  const delPos = db.prepare("DELETE FROM wallet_positions WHERE market_address = ?");
  const run = db.transaction((items) => {
    for (const addr of items) {
      delPos.run(addr);
      delMarket.run(addr);
    }
  });
  run(addresses);
  return addresses.length;
}

module.exports = {
  DEFAULT_PROGRAM_ID,
  FEEDS,
  LP_POSITION_DISCRIMINATOR,
  MARKET_ACCOUNT_SIZE,
  MARKET_ACCOUNT_SIZE_V2,
  MARKET_DISCRIMINATOR,
  MARKET_SNAPSHOT_DISCRIMINATOR,
  applyPragmas,
  buildMarketRow,
  claimableOf,
  computePending,
  computeYesPrice,
  decodeLpPosition,
  decodeMarketFull,
  decodeMarketSnapshot,
  decodePrediction,
  deleteMissingMarkets,
  explorerTxUrl,
  feedByState,
  findLpPosition,
  findMarketPdas,
  getOpenMarketAddresses,
  getReclaimableMarkets,
  getResolvedMarketsMissingEvidence,
  hasIndexedMarkets,
  i80f48ToAmount,
  i80f48ToNumber,
  initSchema,
  isFinalizedStatus,
  isVoidedStatus,
  marketDurationBucket,
  marketDurationSec,
  openDb,
  refreshClaimableForMarket,
  replaceWalletPositions,
  resolveDbPath,
  tryOpenDb,
  upsertMarkets,
  upsertSettlementEvidence,
  witnessCounts,
};
