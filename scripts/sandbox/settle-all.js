#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { AnchorProvider, Program, Wallet, utils } = require("@coral-xyz/anchor");
const { ComputeBudgetProgram, Connection, PublicKey } = require("@solana/web3.js");

const {
  createRpcConnection,
  loadIdl,
  loadKeypair,
  fetchMintMeta,
  ataOf,
  ensureAtaIx,
  runIncrementalSyncSafe,
} = require("./tick");
const { tryLock } = require("./expiry-watch");

function loadOptionalDb() {
  for (const p of [path.resolve(__dirname, "..", "db.js"), path.join(__dirname, "db.js")]) {
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
const dbLib = loadOptionalDb();

const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_PROGRAM_ID = "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER";

const MARKET_ACCOUNT_SIZE = 409;
const MARKET_ACCOUNT_SIZE_V2 = 415;
const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154];
const STATUS_OFFSET = 129;
const CREATOR_OFFSET = 16;
const CLAIM_WINDOW_SEC = 30 * 24 * 60 * 60;
const RESOLVE_WINDOW_SEC = 172_800;

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/sandbox/settle-all.js [options]

Options:
  --self-check     Verify dependencies, settle.js path, filter encoding, and decoding offline
  --dry-run        Scan program markets and print settlement, void and rent-recovery candidates without sending transactions
  --loop           Continuously sweep every SETTLE_LOOP_INTERVAL_SEC seconds
  -h, --help       Show this help message

Environment variables:
  SOLANA_RPC / RPC_URL         Solana RPC endpoint (default: ${DEFAULT_RPC})
  WALLET_PATH / ANCHOR_WALLET  Operator JSON keypair path (default: ~/.config/solana/id.json)
  PROGRAM_ID                   Program ID (default: ${DEFAULT_PROGRAM_ID})
  SETTLE_MIN_AGE_SEC           Minimum seconds past endTs before calling settle.js (default: 4)
  SETTLE_MAX_PER_RUN           Maximum markets settled per sweep (default: 20)
  SETTLE_LOOP_INTERVAL_SEC     Seconds between sweeps in --loop mode (default: 15, min: 5)
  SETTLE_SCRIPT_PATH           Optional explicit path to scripts/settle.js
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

function parseFlags(argv) {
  const flags = { selfCheck: false, dryRun: false, loop: false };
  for (const arg of argv) {
    if (arg === "--self-check") flags.selfCheck = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--loop") flags.loop = true;
    else if (arg === "-h" || arg === "--help") usage(0);
    else {
      console.error(`Unknown argument: ${arg}`);
      usage(1);
    }
  }
  return flags;
}

function getConfig() {
  return {
    rpcUrl: envStr(["SOLANA_RPC", "RPC_URL"], DEFAULT_RPC),
    walletPath: envStr(
      ["WALLET_PATH", "ANCHOR_WALLET"],
      path.join(os.homedir(), ".config", "solana", "id.json")
    ),
    programId: new PublicKey(envStr(["PROGRAM_ID"], DEFAULT_PROGRAM_ID)),
    settleMinAgeSec: Math.max(1, Math.round(envNum("SETTLE_MIN_AGE_SEC", 4))),
    maxPerRun: Math.max(1, Math.round(envNum("SETTLE_MAX_PER_RUN", 20))),
    loopIntervalSec: Math.max(5, Math.round(envNum("SETTLE_LOOP_INTERVAL_SEC", 15))),
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

function decodeTitle(bytes) {
  const buf = Buffer.from(bytes);
  const zeroIdx = buf.indexOf(0);
  const trimmed = zeroIdx >= 0 ? buf.subarray(0, zeroIdx) : buf;
  return trimmed.toString("utf8").trim() || "(untitled)";
}

function decodeMarket(data) {
  const isV2 = Boolean(data) && data.length === MARKET_ACCOUNT_SIZE_V2;
  const isLegacy = Boolean(data) && data.length === MARKET_ACCOUNT_SIZE;
  if ((!isLegacy && !isV2) || !sameDisc(data, MARKET_DISCRIMINATOR)) {
    return null;
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
  const terms = readMarketTerms(c);
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
    ...terms,
    feeBps,
    startTs,
    endTs,
    ocr2State,
    threshold,
    priceDecimals,
    settleAbove,
  };
}

// The optional winner adds a byte on resolved markets, shifting finishTs.
function readMarketTerms(c) {
  const collateralMint = c.pubkey();
  const winnerTag = c.u8();
  const winner = winnerTag === 0 ? null : winnerTag === 1 ? (c.u8() === 0 ? "yes" : "no") : null;
  c.u8(); // marketCollateralBump
  const prediction = c.bytes(64);
  const finishTs = Number(c.u64());
  return { collateralMint, winner, title: decodeTitle(prediction), finishTs };
}

function marketDiscriminatorBase58() {
  return utils.bytes.bs58.encode(Buffer.from(MARKET_DISCRIMINATOR));
}

const loggedLegacyMarkets = new Set();

function isLegacyMarketAccount(data, market) {
  if (data && data.length !== MARKET_ACCOUNT_SIZE_V2) return true;
  if (market && !(Number(market.startTs) > 0)) return true;
  return false;
}

function classifyOpenMarket(market, nowSec, minAgeSec) {
  if (!market || market.status !== "open") return null;
  const targetEndTs = market.endTs > 0 ? market.endTs : market.expiry;
  const age = nowSec - targetEndTs;
  if (nowSec > market.expiry + RESOLVE_WINDOW_SEC) return { kind: "pastWindow", age, targetEndTs };
  if (age < minAgeSec) {
    return { kind: "waiting", age, targetEndTs };
  }
  return { kind: "ready", age, targetEndTs };
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildSyntheticMarketBuffer({
  statusByte = 0,
  expiry = 1_700_000_000,
  startTs = null,
  endTs = 1_700_000_000,
  feeBps = 30,
  title = "BTC/USD test",
  v2 = false,
} = {}) {
  const buf = Buffer.alloc(v2 ? MARKET_ACCOUNT_SIZE_V2 : MARKET_ACCOUNT_SIZE);
  Buffer.from(MARKET_DISCRIMINATOR).copy(buf, 0);
  let off = 8;
  buf.writeBigUInt64LE(BigInt(expiry), off); off += 8;
  off += 32; // creator
  off += 16; // id
  off += 1;  // bump
  off += 32; // yesMint
  off += 32; // noMint
  buf.writeUInt8(statusByte, off); off += 1;
  off += 32; // collateralMint
  buf.writeUInt8(0, off); off += 1; // winner = None
  off += 1;  // marketCollateralBump
  const titleBuf = Buffer.from(title, "utf8");
  titleBuf.copy(buf, off, 0, Math.min(64, titleBuf.length));
  off += 64; // prediction
  off += 8;  // finishTs
  off += 16; // lZero
  off += 8;  // lastAccrualTs
  off += 16; // cumYesPerShare
  off += 16; // cumNoPerShare
  if (!v2) {
    buf.writeUInt16LE(feeBps, off);
    off += 2;  // feeBps
  }
  off += 16; // reserveYes
  off += 16; // reserveNo
  off += 16; // totalLpShares
  if (v2) {
    buf.writeBigInt64LE(BigInt(startTs ?? endTs - 900), off);
    off += 8;  // startTs
  }
  buf.writeBigInt64LE(BigInt(endTs), off);
  return buf;
}

function runSelfCheck(cfg) {
  const settlePath = resolveSettleScript();
  const discB58 = marketDiscriminatorBase58();
  if (!discB58 || typeof discB58 !== "string") {
    throw new Error("Failed to base58-encode MARKET_DISCRIMINATOR");
  }

  const endTs = 1_750_000_000;
  const openBuf = buildSyntheticMarketBuffer({ statusByte: 0, expiry: endTs, endTs, title: "SOL/USD 15 min test" });
  const openV2Buf = buildSyntheticMarketBuffer({ statusByte: 0, expiry: endTs, startTs: endTs - 900, endTs, title: "BTC/USD 15 min v2", v2: true });
  const resolvedBuf = buildSyntheticMarketBuffer({ statusByte: 1, expiry: endTs, endTs, title: "ETH/USD resolved" });

  const openDecoded = decodeMarket(openBuf);
  const openV2Decoded = decodeMarket(openV2Buf);
  const resolvedDecoded = decodeMarket(resolvedBuf);
  if (!openDecoded || openDecoded.status !== "open" || openDecoded.endTs !== endTs || openDecoded.feeBps !== 30 || openDecoded.startTs !== null || openDecoded.title !== "SOL/USD 15 min test") {
    throw new Error("Synthetic v1 open market decode failed");
  }
  if (!openV2Decoded || openV2Decoded.status !== "open" || openV2Decoded.endTs !== endTs || openV2Decoded.startTs !== endTs - 900 || openV2Decoded.title !== "BTC/USD 15 min v2") {
    throw new Error("Synthetic v2 open market decode failed");
  }
  if (!resolvedDecoded || resolvedDecoded.status !== "resolved") {
    throw new Error("Synthetic resolved market decode failed");
  }

  const waiting = classifyOpenMarket(openDecoded, endTs + 2, cfg.settleMinAgeSec);
  const ready = classifyOpenMarket(openDecoded, endTs + cfg.settleMinAgeSec, cfg.settleMinAgeSec);
  const past = classifyOpenMarket(openDecoded, endTs + RESOLVE_WINDOW_SEC + 1, cfg.settleMinAgeSec);
  if (waiting?.kind !== "waiting" || ready?.kind !== "ready" || past?.kind !== "pastWindow") {
    throw new Error("Market classification self-check failed");
  }

  console.log("[self-check] settle.js:", settlePath);
  console.log("[self-check] program:", cfg.programId.toBase58());
  console.log("[self-check] discriminatorFilter:", discB58);
  console.log("[self-check] decode + window classify: OK");
  console.log("[self-check] PASSED");
}

function marketFilters(status, creator) {
  const filters = [
    { memcmp: { offset: 0, bytes: marketDiscriminatorBase58() } },
    { memcmp: { offset: STATUS_OFFSET, bytes: utils.bytes.bs58.encode(Buffer.from([status])) } },
  ];
  if (creator) filters.push({ memcmp: { offset: CREATOR_OFFSET, bytes: creator.toBase58() } });
  return filters;
}

async function maintainMarkets(candidates, action, dryRun, submit, limit) {
  let completed = 0;
  for (const candidate of candidates) {
    const key = candidate.address.toBase58();
    if (dryRun) {
      console.log(`  [dry-run] ${action} ${key}`);
      continue;
    }
    let release;
    try {
      release = await tryLock(key);
      if (!release) continue;
      const sig = await submit(candidate);
      console.log(`[settle-all] ${action} ${key} tx=${sig}`);
      if (++completed >= limit) break;
    } catch (err) {
      console.warn(`[settle-all] ${action} ${key}: ${err.message}`);
    } finally {
      release?.();
    }
  }
}

async function runMaintenance(connection, cfg, dryRun, expired) {
  const payer = dryRun && !fs.existsSync(cfg.walletPath) ? null : loadKeypair(cfg.walletPath);
  const owner = payer?.publicKey;
  const program = dryRun ? null : new Program(loadIdl(cfg.programId).idl,
    new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed", preflightCommitment: "confirmed" }));
  await maintainMarkets(expired, "void", dryRun, ({ address }) =>
    program.methods.voidMarket().accountsPartial({ signer: owner, market: address }).rpc(), cfg.maxPerRun);

  if (!owner) {
    console.log("[dry-run] rent recovery scan requires the operator public key; wallet file absent");
    return;
  }
  let reclaimable = null;
  if (dbLib && process.env.VERITAS_DISABLE_DB_MAINTENANCE !== "1") {
    const dbPath = dbLib.resolveDbPath();
    if (fs.existsSync(dbPath)) {
      let db = null;
      try {
        db = dbLib.openDb(dbPath, { readonly: true });
        if (dbLib.hasIndexedMarkets(db, cfg.programId.toBase58())) {
          const cutoff = Math.floor(Date.now() / 1000) - CLAIM_WINDOW_SEC;
          reclaimable = dbLib
            .getReclaimableMarkets(
              db,
              cfg.programId.toBase58(),
              owner.toBase58(),
              cutoff,
              cfg.maxPerRun * 2
            )
            .map((row) => ({
              address: new PublicKey(row.address),
              collateralMint: new PublicKey(row.collateral_mint),
              finishTs: Number(row.finish_ts),
            }));
        }
      } catch (err) {
        reclaimable = null;
        console.warn(`[settle-all] db maintenance degraded to chain scan: ${err?.message || err}`);
      } finally {
        try {
          if (db?.open) db.close();
        } catch {
          // ignore close errors on degraded db handle
        }
      }
    }
  }
  if (reclaimable === null) {
    reclaimable = [];
    for (const status of [1, 2, 3]) {
      try {
        const rows = await connection.getProgramAccounts(cfg.programId, {
          commitment: "confirmed",
          filters: marketFilters(status, owner),
          // collateralMint through finishTs, including the longest Option<Side> encoding.
          dataSlice: { offset: STATUS_OFFSET + 1, length: 107 },
        });
        const now = Math.floor(Date.now() / 1000);
        for (const row of rows) {
          try {
            const terms = readMarketTerms(new Cursor(row.account.data));
            if (terms.finishTs > 0 && now > terms.finishTs + CLAIM_WINDOW_SEC) {
              reclaimable.push({ address: row.pubkey, ...terms });
            }
          } catch (err) { console.warn(`[settle-all] decode ${row.pubkey}: ${err.message}`); }
        }
      } catch (err) { console.warn(`[settle-all] rent scan status=${status}: ${err.message}`); }
    }
  }
  await maintainMarkets(reclaimable, "burn", dryRun, async ({ address, collateralMint }) => {
    const { tokenProgram } = await fetchMintMeta(connection, collateralMint);
    // The IDL derives the pool, vault, mint and snapshot PDAs from the supplied market address.
    return program.methods.burnAccount().accountsPartial({
      signer: owner, market: address, collateralMint, tokenProgram,
      collateralAta: ataOf(collateralMint, owner, tokenProgram),
    }).preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ensureAtaIx(owner, collateralMint, tokenProgram, owner),
    ]).rpc();
  }, cfg.maxPerRun);
}

async function runSweep(cfg, flags) {
  const settleScriptPath = resolveSettleScript();
  if (!flags.dryRun && !fs.existsSync(cfg.walletPath)) {
    throw new Error(`Operator keypair file not found: ${cfg.walletPath}`);
  }

  const connection = createRpcConnection(cfg.rpcUrl);
  const rawAccounts = await connection.getProgramAccounts(cfg.programId, {
    commitment: "confirmed",
    filters: marketFilters(0),
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const ready = [];
  let openCount = 0;
  let waitingCount = 0;
  const expired = [];

  for (const item of rawAccounts) {
    let market;
    try {
      market = decodeMarket(Buffer.from(item.account.data));
    } catch {
      continue;
    }
    if (!market || market.status !== "open") continue;
    if (isLegacyMarketAccount(item.account.data, market)) {
      const addr = item.pubkey.toBase58();
      if (!loggedLegacyMarkets.has(addr)) {
        loggedLegacyMarkets.add(addr);
        console.log(
          `[settle-all] skip legacy market ${addr} (size=${item.account.data.length}, startTs=${market.startTs})`
        );
      }
      continue;
    }
    openCount += 1;

    const cls = classifyOpenMarket(market, nowSec, cfg.settleMinAgeSec);
    if (!cls) continue;
    if (cls.kind === "waiting") {
      waitingCount += 1;
    } else if (cls.kind === "pastWindow") {
      expired.push({ address: item.pubkey });
    } else if (cls.kind === "ready") {
      ready.push({
        address: item.pubkey.toBase58(),
        title: market.title,
        age: cls.age,
        targetEndTs: cls.targetEndTs,
      });
    }
  }

  // Prioritize the most recently expired markets so active front-page rounds settle immediately.
  ready.sort((a, b) => b.targetEndTs - a.targetEndTs);
  const selected = ready.slice(0, cfg.maxPerRun);

  console.log(
    `[settle-all] total=${rawAccounts.length} open=${openCount} waiting=${waitingCount} pastWindow=${expired.length} ready=${ready.length} processing=${selected.length}`
  );

  if (flags.dryRun) {
    for (const m of selected) {
      console.log(`  [dry-run] ${m.address} age=${m.age}s title="${m.title}"`);
    }
    await runMaintenance(connection, cfg, true, expired);
    return { attempted: selected.length, settled: 0, failed: 0 };
  }

  let settled = 0;
  let failed = 0;
  for (const m of selected) {
    console.log(`[settle-all] settling ${m.address} (age=${m.age}s, "${m.title}")...`);
    let ok = runSettleScript(settleScriptPath, m.address, cfg);
    if (!ok && m.age < 25) {
      console.log(`[settle-all] ${m.address} newly expired; retrying once after 3s...`);
      await pause(3000);
      ok = runSettleScript(settleScriptPath, m.address, cfg);
    }
    if (ok) settled += 1;
    else {
      failed += 1;
      console.warn(`[settle-all] settle.js did not succeed for ${m.address}`);
    }
  }

  await runMaintenance(connection, cfg, false, expired);
  await runIncrementalSyncSafe(connection, cfg.programId, 3);
  console.log(`[settle-all] sweep done: settled=${settled} failed=${failed}`);
  return { attempted: selected.length, settled, failed };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const cfg = getConfig();

  if (flags.selfCheck) {
    runSelfCheck(cfg);
    return;
  }

  if (!flags.loop) {
    await runSweep(cfg, flags);
    return;
  }

  let stopping = false;
  const onStop = (sig) => {
    console.log(`[settle-all] received ${sig}, exiting after current step...`);
    stopping = true;
  };
  process.on("SIGINT", () => onStop("SIGINT"));
  process.on("SIGTERM", () => onStop("SIGTERM"));

  console.log(`[settle-all] loop started (interval=${cfg.loopIntervalSec}s, minAge=${cfg.settleMinAgeSec}s)`);
  while (!stopping) {
    try {
      await runSweep(cfg, flags);
    } catch (err) {
      console.error(`[settle-all] sweep error: ${err?.message || err}`);
    }
    if (!stopping) {
      await pause(cfg.loopIntervalSec * 1000);
    }
  }
}

if (require.main === module) main().catch((err) => {
  console.error(`[settle-all] fatal: ${err?.stack || err}`);
  process.exit(1);
});

module.exports = {
  MARKET_ACCOUNT_SIZE,
  MARKET_ACCOUNT_SIZE_V2,
  classifyOpenMarket,
  decodeMarket,
  isLegacyMarketAccount,
  marketFilters,
  runMaintenance,
};
