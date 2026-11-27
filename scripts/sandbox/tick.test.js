"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@solana/web3.js");
const {
  DEFAULT_SEED_MAX_USDT,
  DEFAULT_SEED_MIN_USDT,
  DEFAULT_SETTLE_MAX_TOTAL_PROCS,
  DEFAULT_SETTLE_SLOTS,
  RESOLVE_WINDOW_SEC,
  SELF_SETTLE_SLOT_PREFIX,
  classifySettleProcess,
  defaultTitleForAsset,
  getConfig,
  parseAssets,
  pickSeedUsdt,
  reapStaleSettleProcesses,
  resolveAssetForEntry,
  scheduleExpiredSettlements,
  selectExpiredSettleEntries,
  selectWatchEntries,
  settleRetryCooldownSec,
} = require("./tick");
const { tryLock } = require("./expiry-watch");

test("defaultTitleForAsset formats minute and hour/day durations compatibly", () => {
  assert.equal(defaultTitleForAsset("BTC/USD", 120), "BTC/USD at or above opening price in 2 min?");
  assert.equal(defaultTitleForAsset("BTC/USD", 900), "BTC/USD at or above opening price in 15 min?");
  assert.equal(defaultTitleForAsset("ETH/USD", 3600), "ETH/USD at or above opening price in 1 hour?");
  assert.equal(defaultTitleForAsset("SOL/USD", 86_400), "SOL/USD at or above opening price in 24 hours?");
});

test("selectWatchEntries and selectExpiredSettleEntries cover expired line markets for self-sweep settlement", () => {
  const now = 1_800_000_000;
  const entries = [
    { address: "upcoming", status: "open", expiry: now + 300, endTs: now + 300 },
    { address: "watch1", status: "open", expiry: now + 30, endTs: now + 30 },
    { address: "watch2", status: "open", expiry: now - 10, endTs: now - 10 },
    { address: "watchOverflow", status: "open", expiry: now - 12, endTs: now - 12 },
    { address: "expired1m", status: "open", expiry: now - 60, endTs: now - 60 },
    { address: "expiredOld", status: "open", expiry: now - 400, endTs: now - 400 },
    { address: "pastWindow", status: "open", expiry: now - RESOLVE_WINDOW_SEC - 5, endTs: now - RESOLVE_WINDOW_SEC - 5 },
    { address: "resolved", status: "resolved", expiry: now - 60, endTs: now - 60 },
  ];

  const watchDue = selectWatchEntries(entries, now);
  assert.deepEqual(watchDue.map((e) => e.address), ["watchOverflow", "watch2"]);

  const watchedSet = new Set(watchDue.map((e) => e.address));
  const settleDue = selectExpiredSettleEntries(entries, now, 4, watchedSet);
  // Both recently expired (>25s) and overflow expired (>4s, not in top-2 watch batch) are self-swept newest-first.
  assert.deepEqual(settleDue.map((e) => e.address), ["expired1m", "expiredOld"]);

  // Past-window (>48h) and non-open markets are excluded (left to settle-all voiding).
  assert.equal(settleDue.some((e) => e.address === "pastWindow" || e.address === "resolved"), false);
});

test("selectExpiredSettleEntries picks up newly expired markets left out when watch cap is full", () => {
  const now = 1_800_000_000;
  const entries = [
    { address: "w1", status: "open", expiry: now - 15, endTs: now - 15 },
    { address: "w2", status: "open", expiry: now - 10, endTs: now - 10 },
    { address: "w3", status: "open", expiry: now - 5, endTs: now - 5 },
  ];
  const watchDue = selectWatchEntries(entries, now);
  const settleDue = selectExpiredSettleEntries(
    entries,
    now,
    4,
    new Set(watchDue.map((e) => e.address))
  );
  assert.deepEqual(watchDue.map((e) => e.address), ["w1", "w2"]);
  assert.deepEqual(settleDue.map((e) => e.address), ["w3"]);
});

test("resolveAssetForEntry falls back to ASSET_CATALOG when cfg.assets omits an asset", () => {
  const btcOnly = parseAssets("btc");
  const resolved = resolveAssetForEntry({ assets: btcOnly }, { asset: "link" });
  assert.ok(resolved);
  assert.equal(resolved.symbol, "LINK/USD");
});

function releaseLock(rel) {
  if (typeof rel !== "function") return Promise.resolve();
  const ret = rel();
  if (ret && typeof ret.once === "function") {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
      ret.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return Promise.resolve();
}

function makeTestCfg(overrides = {}) {
  return {
    programId: Keypair.generate().publicKey,
    rpcUrl: "http://127.0.0.1:8899",
    walletPath: "/tmp/operator.json",
    settleMaxPerTick: 4,
    settleMaxSlots: DEFAULT_SETTLE_SLOTS,
    settleMaxTotalProcs: DEFAULT_SETTLE_MAX_TOTAL_PROCS,
    settleStaleMaxAgeSec: 600,
    ...overrides,
  };
}

test("3-tier retry backoff throttles old stuck markets while retrying fresh ones every minute", () => {
  assert.equal(settleRetryCooldownSec(0), 0);
  assert.equal(settleRetryCooldownSec(599), 0);
  assert.equal(settleRetryCooldownSec(600), 300);
  assert.equal(settleRetryCooldownSec(3599), 300);
  assert.equal(settleRetryCooldownSec(3600), 900);

  const now = 1_800_000_000;
  const entries = [
    { address: "fresh", status: "open", expiry: now - 120, endTs: now - 120, lastSettleAttemptAt: now - 60 },
    { address: "midCool", status: "open", expiry: now - 900, endTs: now - 900, lastSettleAttemptAt: now - 120 },
    { address: "midReady", status: "open", expiry: now - 900, endTs: now - 900, lastSettleAttemptAt: now - 300 },
    { address: "oldCool", status: "open", expiry: now - 4000, endTs: now - 4000, lastSettleAttemptAt: now - 600 },
    { address: "oldReady", status: "open", expiry: now - 4000, endTs: now - 4000, lastSettleAttemptAt: now - 900 },
  ];
  const due = selectExpiredSettleEntries(entries, now, 10);
  assert.deepEqual(
    due.map((e) => e.address),
    ["fresh", "midReady", "oldReady"]
  );
});

test("scheduleExpiredSettlements stops spawning when settle slots are full and caps to free slots", async (t) => {
  const held = [];
  t.after(async () => {
    for (const rel of held) await releaseLock(rel);
  });

  for (let i = 0; i < DEFAULT_SETTLE_SLOTS; i += 1) {
    const rel = await tryLock(`${SELF_SETTLE_SLOT_PREFIX}${i}`);
    assert.ok(rel);
    held.push(rel);
  }

  const now = 1_800_000_000;
  const makeEntries = () => [
    { address: "m1", status: "open", expiry: now - 60, endTs: now - 60 },
    { address: "m2", status: "open", expiry: now - 70, endTs: now - 70 },
    { address: "m3", status: "open", expiry: now - 80, endTs: now - 80 },
    { address: "m4", status: "open", expiry: now - 90, endTs: now - 90 },
  ];

  const spawnedFull = [];
  const fullEntries = makeEntries();
  const resFull = await scheduleExpiredSettlements(makeTestCfg(), "/app/scripts/settle.js", fullEntries, now, new Set(), {
    listProcesses: () => [],
    spawnFn: (cmd, args) => {
      spawnedFull.push({ cmd, args });
      return { on() {}, unref() {} };
    },
  });
  assert.equal(resFull.length, 0);
  assert.equal(spawnedFull.length, 0);
  assert.equal(fullEntries[0].lastSettleAttemptAt, undefined);

  // Release 2 of the 4 slots -> should spawn at most 2 with --self-settle flag
  await releaseLock(held.pop());
  await releaseLock(held.pop());

  const spawnedPartial = [];
  const partialEntries = makeEntries();
  const resPartial = await scheduleExpiredSettlements(makeTestCfg(), "/app/scripts/settle.js", partialEntries, now, new Set(), {
    listProcesses: () => [],
    spawnFn: (cmd, args) => {
      spawnedPartial.push({ cmd, args });
      return { on() {}, unref() {} };
    },
  });
  assert.deepEqual(
    resPartial.map((e) => e.address),
    ["m1", "m2"]
  );
  assert.equal(spawnedPartial.length, 2);
  assert.ok(spawnedPartial.every((s) => s.args.includes("--self-settle")));
  assert.equal(partialEntries[0].lastSettleAttemptAt, now);
  assert.equal(partialEntries[1].lastSettleAttemptAt, now);
  assert.equal(partialEntries[2].lastSettleAttemptAt, undefined);
});

test("scheduleExpiredSettlements respects total settle.js process guardrail", async () => {
  const now = 1_800_000_000;
  const entries = [{ address: "m1", status: "open", expiry: now - 60, endTs: now - 60 }];
  const fakeProcs = Array.from({ length: DEFAULT_SETTLE_MAX_TOTAL_PROCS }, (_, idx) => ({
    pid: 1000 + idx,
    uid: 1000,
    elapsedSec: 30,
    isSettle: true,
    isWatch: false,
    isOrdinary: true,
    scriptArg: "/opt/veritas/scripts/settle.js",
  }));

  let spawns = 0;
  const res = await scheduleExpiredSettlements(makeTestCfg(), "/opt/veritas/scripts/settle.js", entries, now, new Set(), {
    myUid: 1000,
    listProcesses: () => fakeProcs,
    tryLockFn: async () => () => {},
    spawnFn: () => {
      spawns += 1;
      return { on() {}, unref() {} };
    },
  });
  assert.equal(res.length, 0);
  assert.equal(spawns, 0);
});

test("classifySettleProcess and reapStaleSettleProcesses strictly target old ordinary settle.js only", () => {
  assert.deepEqual(
    classifySettleProcess(["/usr/bin/node", "/opt/veritas/scripts/settle.js", "MKT1", "--self-settle"]),
    {
      isSettle: true,
      isWatch: false,
      isOrdinary: true,
      isSelfSettle: true,
      scriptArg: "/opt/veritas/scripts/settle.js",
    }
  );
  assert.deepEqual(
    classifySettleProcess(["node", "scripts/settle.js", "MKT1", "--watch", "FEED1"]),
    {
      isSettle: true,
      isWatch: true,
      isOrdinary: false,
      isSelfSettle: false,
      scriptArg: "scripts/settle.js",
    }
  );
  assert.equal(classifySettleProcess(["/usr/bin/node", "/opt/veritas/scripts/sandbox/settle-all.js"]), null);
  assert.equal(classifySettleProcess(["/usr/bin/node", "-e", "require('./settle.js')"]), null);

  const killed = [];
  const fakeList = [
    { pid: 101, uid: 1000, elapsedSec: 650, isSettle: true, isWatch: false, isOrdinary: true, scriptArg: "/opt/veritas/scripts/settle.js" },
    { pid: 102, uid: 1000, elapsedSec: 590, isSettle: true, isWatch: false, isOrdinary: true, scriptArg: "/opt/veritas/scripts/settle.js" },
    { pid: 103, uid: 1000, elapsedSec: 900, isSettle: true, isWatch: true, isOrdinary: false, scriptArg: "/opt/veritas/scripts/settle.js" },
    { pid: 104, uid: 9999, elapsedSec: 900, isSettle: true, isWatch: false, isOrdinary: true, scriptArg: "/opt/veritas/scripts/settle.js" },
  ];
  const out = reapStaleSettleProcesses({
    maxAgeSec: 600,
    myUid: 1000,
    listProcesses: () => fakeList,
    killProcess: (pid, sig) => killed.push({ pid, sig }),
  });
  assert.deepEqual(killed, [{ pid: 101, sig: "SIGTERM" }]);
  assert.deepEqual(out.killedPids, [101]);
  assert.deepEqual(
    out.remainingProcs.map((p) => p.pid),
    [102, 103, 104]
  );
});

test("pickSeedUsdt randomizes within 120-180 USDT by default with ~150 mean and respects bounds", () => {
  assert.equal(DEFAULT_SEED_MIN_USDT, 120);
  assert.equal(DEFAULT_SEED_MAX_USDT, 180);

  const cfg = getConfig();
  assert.equal(cfg.seedMinUsdt, 120);
  assert.equal(cfg.seedMaxUsdt, 180);

  assert.equal(pickSeedUsdt(cfg, () => 0), 120);
  assert.equal(pickSeedUsdt(cfg, () => 0.5), 150);
  assert.equal(pickSeedUsdt(cfg, () => 1), 180);

  const samples = [];
  for (let i = 0; i < 200; i += 1) {
    const v = pickSeedUsdt(cfg);
    assert.ok(v >= 120 && v <= 180, `seed ${v} out of [120, 180]`);
    samples.push(v);
  }
  const uniqueCount = new Set(samples).size;
  assert.ok(uniqueCount > 20, `expected randomized seeds, got only ${uniqueCount} distinct values`);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(mean > 135 && mean < 165, `expected mean near 150, got ${mean}`);
});
