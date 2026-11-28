"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Keypair } = require("@solana/web3.js");
const {
  DEFAULT_SEED_MAX_USDT,
  DEFAULT_SEED_MIN_USDT,
  DEFAULT_SETTLE_MAX_TOTAL_PROCS,
  DEFAULT_SETTLE_SLOTS,
  MARKET_ACCOUNT_SIZE,
  MARKET_ACCOUNT_SIZE_V2,
  MAX_ARCHIVED_MARKETS,
  PLAN_ONLY_PRE_OPEN_LEAD_SEC,
  RESOLVE_WINDOW_SEC,
  SELF_SETTLE_SLOT_PREFIX,
  classifySettleProcess,
  computeStaggeredExpiry,
  defaultTitleForAsset,
  getConfig,
  gridAssetForExpiry,
  isLegacyEntry,
  isLegacyMarketAccount,
  loadState,
  mergeStates,
  parseAssets,
  pickSeedUsdt,
  planMissingMarkets,
  reapStaleSettleProcesses,
  recycleFinalizedEntries,
  resolveAssetForEntry,
  saveState,
  scheduleExpiredSettlements,
  selectExpiredSettleEntries,
  selectWatchEntries,
  settleRetryCooldownSec,
  shouldCreateInRun,
  slotOffsetSec,
  stateLockName,
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

test("getConfig defaults SANDBOX_ACTIVE_WINDOW_SEC to 3600 and honors env override", () => {
  const prev = process.env.SANDBOX_ACTIVE_WINDOW_SEC;
  try {
    delete process.env.SANDBOX_ACTIVE_WINDOW_SEC;
    assert.equal(getConfig().activeWindowSec, 3600);

    process.env.SANDBOX_ACTIVE_WINDOW_SEC = "900";
    assert.equal(getConfig().activeWindowSec, 900);
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_ACTIVE_WINDOW_SEC;
    else process.env.SANDBOX_ACTIVE_WINDOW_SEC = prev;
  }
});

test("slotOffsetSec uses general floor(slotIndex * duration / totalSlots) formula and getConfig defaults slots to assets.length", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((i) => slotOffsetSec(900, i, 6)),
    [0, 150, 300, 450, 600, 750]
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => slotOffsetSec(900, i, 4)),
    [0, 225, 450, 675]
  );

  const prevSlots = process.env.SANDBOX_SLOTS;
  const prevAssets = process.env.SANDBOX_ASSETS;
  try {
    delete process.env.SANDBOX_SLOTS;
    delete process.env.SANDBOX_ASSETS;
    const defCfg = getConfig();
    assert.equal(defCfg.slots, defCfg.assets.length);

    process.env.SANDBOX_SLOTS = "6";
    assert.equal(getConfig().slots, 6);

    process.env.SANDBOX_ASSETS = "btc";
    delete process.env.SANDBOX_SLOTS;
    assert.equal(getConfig().slots, 1);
  } finally {
    if (prevSlots === undefined) delete process.env.SANDBOX_SLOTS;
    else process.env.SANDBOX_SLOTS = prevSlots;
    if (prevAssets === undefined) delete process.env.SANDBOX_ASSETS;
    else process.env.SANDBOX_ASSETS = prevAssets;
  }
});

test("planMissingMarkets 6-slot phase grid maintains steady-state 6 live 15m markets on 60s ticks, >=840s lifetime, <=10% boundary transient, and +-75s dedup", () => {
  const assets = parseAssets("btc,eth,sol,link");
  const cfg = { assets, slots: 6, durationSec: 900 };
  const startNow = 1_763_900_000;
  const CREATE_COST_SEC = 4; // realistic per-market creation + confirmation time within a tick

  // Cold start + warm-up into steady state (first 15 min)
  let stateLive = [];
  const seenExpiries = new Set();
  const seenKeys = new Set();

  // +-75s dedup check at a specific instant
  const initialPlan = planMissingMarkets(cfg, [], startNow);
  assert.ok(initialPlan.length >= 5);
  for (let i = 1; i < initialPlan.length; i += 1) {
    assert.equal(initialPlan[i].expiry - initialPlan[i - 1].expiry, 150);
  }
  const jittered = initialPlan.map((item, idx) => ({
    asset: item.asset.key,
    expiry: idx === 2 ? item.expiry + 40 : item.expiry,
    status: "open",
  }));
  assert.equal(planMissingMarkets(cfg, jittered, startNow).length, 0);

  // Realistic 180-tick (3-hour) simulation: ticks occur every 60s, creations happen sequentially inside each tick
  const steadyLifetimes = [];
  let steadySamples = 0;
  let transientSamples = 0; // live count === 5 or 7 near phase boundaries

  for (let step = 0; step <= 180; step += 1) {
    const tickStart = startNow + step * 60;

    // Sample every 1 second across the 60s interval between previous tick and this tick (after 15-min warmup)
    if (step >= 16) {
      const prevTick = tickStart - 60;
      for (let t = prevTick; t < tickStart; t += 1) {
        const activeAtT = stateLive.filter((m) => m.createdAt <= t && m.expiry > t);
        steadySamples += 1;
        assert.ok(
          activeAtT.length >= 5 && activeAtT.length <= 7,
          `expected 5..7 live markets at t=${t}, got ${activeAtT.length}`
        );
        if (activeAtT.length !== 6) {
          transientSamples += 1;
        }
      }
    }

    // Expire markets that ended at or before tickStart
    stateLive = stateLive.filter((m) => m.expiry > tickStart);
    const toOpen = planMissingMarkets(cfg, stateLive, tickStart);

    // Execute creations sequentially in expiry order within this tick
    let cursorSec = tickStart;
    for (const item of toOpen) {
      cursorSec += CREATE_COST_SEC;
      const key = `${item.asset.key}:${item.expiry}`;
      assert.equal(seenKeys.has(key), false, `duplicate (asset, expiry): ${key}`);
      assert.equal(seenExpiries.has(item.expiry), false, `duplicate phase instant: ${item.expiry}`);
      seenKeys.add(key);
      seenExpiries.add(item.expiry);
      assert.equal(gridAssetForExpiry(assets, item.expiry, 900, 6).key, item.asset.key);

      const lifetime = item.expiry - cursorSec;
      if (step >= 15) {
        steadyLifetimes.push(lifetime);
        assert.ok(
          lifetime >= 840,
          `steady-state market lifetime ${lifetime}s < 840s (expiry=${item.expiry}, createdAt=${cursorSec})`
        );
      }
      stateLive.push({
        asset: item.asset.key,
        expiry: item.expiry,
        createdAt: cursorSec,
        status: "open",
      });
    }

    // Steady-state structural invariants after warmup
    if (step >= 15) {
      const liveNow = stateLive.filter((m) => m.expiry > cursorSec).sort((a, b) => a.expiry - b.expiry);
      assert.ok(liveNow.length === 6 || liveNow.length === 7, `post-tick live count=${liveNow.length}`);
      for (let i = 1; i < liveNow.length; i += 1) {
        assert.equal(liveNow[i].expiry - liveNow[i - 1].expiry, 150);
      }
      const assetCounts = new Map(assets.map((a) => [a.key, 0]));
      for (const m of liveNow) {
        assetCounts.set(m.asset, (assetCounts.get(m.asset) || 0) + 1);
      }
      for (const a of assets) {
        assert.ok(assetCounts.get(a.key) >= 1, `asset ${a.key} missing at tick ${step}`);
      }
    }
  }

  assert.ok(steadyLifetimes.length >= 60, `expected >= 60 steady-state creations, got ${steadyLifetimes.length}`);
  const minLifetime = Math.min(...steadyLifetimes);
  const avgLifetime = steadyLifetimes.reduce((a, b) => a + b, 0) / steadyLifetimes.length;
  const transientRatio = transientSamples / steadySamples;
  assert.ok(minLifetime >= 840, `minLifetime=${minLifetime}s < 840s`);
  assert.ok(avgLifetime >= 880, `avgLifetime=${avgLifetime.toFixed(1)}s < 880s`);
  assert.ok(
    transientRatio <= 0.1,
    `boundary transient ratio ${(transientRatio * 100).toFixed(2)}% > 10% (${transientSamples}/${steadySamples})`
  );
});

test("planMissingMarkets preserves legacy 1-asset-per-slot behavior when slots === assets.length", () => {
  const assets = parseAssets("btc,eth,sol,link");
  const cfg = { assets, slots: 4, durationSec: 120 };
  const now = 1_763_900_000;
  const live = [
    { asset: "btc", expiry: now + 30, status: "open" },
    { asset: "eth", expiry: now + 60, status: "open" },
  ];
  const missing = planMissingMarkets(cfg, live, now);
  assert.deepEqual(
    missing.map((m) => m.asset.key),
    ["sol", "link"]
  );
  // Expiry matches computeStaggeredExpiry for each slot
  assert.equal(missing[0].expiry, computeStaggeredExpiry(now, 120, 2, 4));
  assert.equal(missing[1].expiry, computeStaggeredExpiry(now, 120, 3, 4));
});

test("legacy 409-byte / missing-startTs markets are excluded from watch, self-settle, and recycle", async () => {
  const now = 1_800_000_000;
  assert.equal(isLegacyMarketAccount({ data: Buffer.alloc(MARKET_ACCOUNT_SIZE) }, { startTs: null }), true);
  assert.equal(isLegacyMarketAccount({ data: Buffer.alloc(MARKET_ACCOUNT_SIZE_V2) }, { startTs: 0 }), true);
  assert.equal(isLegacyMarketAccount({ data: Buffer.alloc(MARKET_ACCOUNT_SIZE_V2) }, { startTs: now - 900 }), false);

  const watchEntries = [
    { address: "legacySize", status: "open", expiry: now + 10, endTs: now + 10, accountSize: MARKET_ACCOUNT_SIZE },
    { address: "legacyStart", status: "open", expiry: now + 12, endTs: now + 12, startTs: null },
    { address: "legacyFlag", status: "open", expiry: now + 14, endTs: now + 14, legacy: true },
    { address: "v2Ok", status: "open", expiry: now + 20, endTs: now + 20, accountSize: MARKET_ACCOUNT_SIZE_V2, startTs: now - 880 },
  ];
  assert.deepEqual(
    selectWatchEntries(watchEntries, now).map((e) => e.address),
    ["v2Ok"]
  );

  const settleEntries = [
    { address: "legacyExpired", status: "open", expiry: now - 60, endTs: now - 60, accountSize: MARKET_ACCOUNT_SIZE, startTs: null },
    { address: "v2Expired", status: "open", expiry: now - 60, endTs: now - 60, accountSize: MARKET_ACCOUNT_SIZE_V2, startTs: now - 960 },
  ];
  assert.deepEqual(
    selectExpiredSettleEntries(settleEntries, now, 4, new Set()).map((e) => e.address),
    ["v2Expired"]
  );
  assert.equal(isLegacyEntry(settleEntries[0]), true);
  assert.equal(isLegacyEntry(settleEntries[1]), false);
});

test("single-market failure in scheduleExpiredSettlements and recycleFinalizedEntries is isolated and does not abort batch", async () => {
  const now = 1_800_000_000;
  const entries = [
    { address: "bad1", status: "open", expiry: now - 60, endTs: now - 60, startTs: now - 960 },
    { address: "good2", status: "open", expiry: now - 70, endTs: now - 70, startTs: now - 970 },
  ];

  const spawned = [];
  const res = await scheduleExpiredSettlements(makeTestCfg(), "/opt/veritas/scripts/settle.js", entries, now, new Set(), {
    listProcesses: () => [],
    tryLockFn: async () => () => {},
    spawnFn: (cmd, args) => {
      if (args[1] === "bad1") throw new Error("simulated spawn failure");
      spawned.push(args[1]);
      return { on() {}, unref() {} };
    },
  });
  assert.deepEqual(spawned, ["good2"]);
  assert.deepEqual(res.map((e) => e.address), ["good2"]);

  // recycleFinalizedEntries: throwing on badAddr must not stop recycling goodAddr, and legacy entry is skipped & marked recycled
  const badAddr = Keypair.generate().publicKey.toBase58();
  const legacyAddr = Keypair.generate().publicKey.toBase58();
  const goodAddr = Keypair.generate().publicKey.toBase58();
  const tmpStatePath = require("path").join(require("os").tmpdir(), `veritas-tick-iso-${process.pid}.json`);
  const state = {
    version: 2,
    markets: [
      { address: badAddr, status: "resolved", recycled: false, startTs: now - 900 },
      { address: legacyAddr, status: "windowBurn", recycled: false, accountSize: MARKET_ACCOUNT_SIZE, startTs: null },
      { address: goodAddr, status: "resolved", recycled: false, startTs: now - 900 },
    ],
  };
  const queried = [];
  const fakeConn = {
    async getAccountInfo(pk) {
      const addr = pk.toBase58();
      queried.push(addr);
      if (addr === badAddr) throw new Error("simulated RPC error");
      return null; // closed/already burned -> marks recycled = true cleanly
    },
  };
  try {
    await recycleFinalizedEntries(fakeConn, {}, { publicKey: Keypair.generate().publicKey }, { statePath: tmpStatePath }, state);
    assert.deepEqual(queried, [badAddr, goodAddr]);
    assert.equal(state.markets[0].recycled, false);
    assert.equal(state.markets[1].recycled, true);
    assert.equal(state.markets[1].legacy, true);
    assert.equal(state.markets[2].recycled, true);
  } finally {
    const fs = require("fs");
    if (fs.existsSync(tmpStatePath)) fs.unlinkSync(tmpStatePath);
  }
});

test("shouldCreateInRun restricts grid creation to --plan-only while preserving non-grid full tick, and mergeStates avoids dual-process clobber", () => {
  assert.equal(shouldCreateInRun({ planOnly: true, gridMode: true }), true);
  assert.equal(shouldCreateInRun({ planOnly: false, gridMode: true }), false);
  assert.equal(shouldCreateInRun({ planOnly: false, gridMode: false }), true);
  assert.equal(shouldCreateInRun({ planOnly: true, gridMode: false }), true);

  // Simulate --plan-only adding M_new to disk while full tick marks M_old recycled in memory
  const disk = {
    version: 2,
    nextBetSide: "no",
    dailyCounts: { "2026-11-28": 10 },
    markets: [
      { address: "M_old", status: "resolved", recycled: false },
      { address: "M_new", status: "open", recycled: false, betTx: "sig-new" },
    ],
  };
  const local = {
    version: 2,
    nextBetSide: "yes",
    dailyCounts: { "2026-11-28": 9 },
    markets: [{ address: "M_old", status: "resolved", recycled: true }],
  };
  const merged = mergeStates(disk, local);
  assert.equal(merged.dailyCounts["2026-11-28"], 10);
  const byAddr = new Map(merged.markets.map((m) => [m.address, m]));
  assert.equal(byAddr.size, 2);
  assert.equal(byAddr.get("M_old").recycled, true);
  assert.equal(byAddr.get("M_new").betTx, "sig-new");
});

test("planMissingMarkets with 30s --plan-only cadence achieves >=840s steady lifetime and 6 live markets with <=10% boundary transient", () => {
  const assets = parseAssets("btc,eth,sol,link");
  const cfg = { assets, slots: 6, durationSec: 900 };
  const startNow = 1_763_900_000;
  const CREATE_COST_SEC = 4;

  let stateLive = [];
  const seenExpiries = new Set();
  const steadyLifetimes = [];
  let steadySamples = 0;
  let transientSamples = 0;

  // 360 ticks * 30s = 3 hours
  for (let step = 0; step <= 360; step += 1) {
    const tickStart = startNow + step * 30;
    if (step >= 32) {
      const prevTick = tickStart - 30;
      for (let t = prevTick; t < tickStart; t += 1) {
        const active = stateLive.filter((m) => m.createdAt <= t && m.expiry > t);
        steadySamples += 1;
        assert.ok(active.length >= 5 && active.length <= 7, `live=${active.length} at t=${t}`);
        if (active.length !== 6) transientSamples += 1;
      }
    }

    stateLive = stateLive.filter((m) => m.expiry > tickStart);
    const toOpen = planMissingMarkets(cfg, stateLive, tickStart, {
      preOpenLeadSec: PLAN_ONLY_PRE_OPEN_LEAD_SEC,
    });
    let cursorSec = tickStart;
    for (const item of toOpen) {
      cursorSec += CREATE_COST_SEC;
      assert.equal(seenExpiries.has(item.expiry), false, `duplicate expiry ${item.expiry}`);
      seenExpiries.add(item.expiry);
      const lifetime = item.expiry - cursorSec;
      if (step >= 30) {
        steadyLifetimes.push(lifetime);
        assert.ok(lifetime >= 840, `30s --plan-only lifetime ${lifetime}s < 840s`);
      }
      stateLive.push({ asset: item.asset.key, expiry: item.expiry, createdAt: cursorSec, status: "open" });
    }
  }

  const minLifetime = Math.min(...steadyLifetimes);
  const avgLifetime = steadyLifetimes.reduce((a, b) => a + b, 0) / steadyLifetimes.length;
  const transientRatio = transientSamples / steadySamples;
  assert.ok(minLifetime >= 880, `minLifetime=${minLifetime}s < 880s`);
  assert.ok(avgLifetime >= 890, `avgLifetime=${avgLifetime.toFixed(1)}s < 890s`);
  assert.ok(transientRatio <= 0.1, `transientRatio=${(transientRatio * 100).toFixed(2)}% > 10%`);
});

test("saveState serializes interleaved concurrent writes via tryLock so both new market records survive", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veritas-savestate-race-"));
  const statePath = path.join(tmpDir, "state.json");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await saveState(statePath, {
    version: 2,
    nextBetSide: "yes",
    dailyCounts: { "2026-11-28": 1 },
    markets: [{ address: "M_base", asset: "btc", status: "open", recycled: false }],
  });

  // Deterministic interleaving: writer A enters critical section, pauses 100ms before writing,
  // while writer B starts 15ms later carrying a distinct new market record from the stale snapshot.
  const order = [];
  const staleA = loadState(statePath);
  const staleB = loadState(statePath);
  staleA.markets.push({ address: "M_plan", asset: "eth", status: "open", recycled: false });
  staleA.dailyCounts["2026-11-28"] = 2;
  staleB.markets.push({ address: "M_tick", asset: "sol", status: "open", recycled: false });
  staleB.dailyCounts["2026-11-28"] = 2;

  const pA = saveState(statePath, staleA, {
    _onLockedBeforeWrite: async () => {
      order.push("A:enter");
      await new Promise((r) => setTimeout(r, 100));
      order.push("A:write");
    },
  });
  await new Promise((r) => setTimeout(r, 15));
  const pB = saveState(statePath, staleB, {
    _onLockedBeforeWrite: async () => {
      order.push("B:enter");
    },
  });

  await Promise.all([pA, pB]);
  assert.deepEqual(order, ["A:enter", "A:write", "B:enter"]);

  const finalState = loadState(statePath);
  const addrs = new Set(finalState.markets.map((m) => m.address));
  assert.equal(addrs.has("M_base"), true);
  assert.equal(addrs.has("M_plan"), true);
  assert.equal(addrs.has("M_tick"), true);
  assert.equal(finalState.markets.length, 3);

  // Real cross-process concurrent saveState verification
  const tickModulePath = path.resolve(__dirname, "tick.js");
  const runWorker = (addr, delayMs) =>
    new Promise((resolve, reject) => {
      const script = `
        const { loadState, saveState } = require(${JSON.stringify(tickModulePath)});
        (async () => {
          const s = loadState(${JSON.stringify(statePath)});
          s.markets.push({ address: ${JSON.stringify(addr)}, asset: "link", status: "open", recycled: false });
          await saveState(${JSON.stringify(statePath)}, s, {
            _onLockedBeforeWrite: () => new Promise((r) => setTimeout(r, ${delayMs})),
          });
        })().catch((e) => { console.error(e); process.exit(1); });
      `;
      execFile(process.execPath, ["-e", script], (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });

  await Promise.all([runWorker("M_proc_1", 60), runWorker("M_proc_2", 60)]);
  const crossProcState = loadState(statePath);
  const crossAddrs = new Set(crossProcState.markets.map((m) => m.address));
  assert.equal(crossAddrs.has("M_proc_1"), true);
  assert.equal(crossAddrs.has("M_proc_2"), true);
  assert.equal(crossProcState.markets.length, 5);
});

test("saveState degrades to unlocked write with warning on lock timeout or error without throwing", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veritas-savestate-timeout-"));
  const statePath = path.join(tmpDir, "state.json");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const held = await tryLock(stateLockName(statePath));
  assert.ok(held);
  t.after(async () => releaseLock(held));

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await saveState(
      statePath,
      {
        version: 2,
        nextBetSide: "no",
        dailyCounts: {},
        markets: [{ address: "M_timeout_fallback", asset: "btc", status: "open", recycled: false }],
      },
      { maxWaitMs: 60, retryMs: 15 }
    );
    assert.equal(warnings.some((w) => /timed out/i.test(w) && /unlocked write/i.test(w)), true);
    assert.equal(loadState(statePath).markets[0].address, "M_timeout_fallback");

    warnings.length = 0;
    await saveState(
      statePath,
      {
        version: 2,
        nextBetSide: "yes",
        dailyCounts: {},
        markets: [{ address: "M_error_fallback", asset: "eth", status: "open", recycled: false }],
      },
      {
        tryLockFn: async () => {
          throw new Error("simulated lock permission error");
        },
      }
    );
    assert.equal(warnings.some((w) => /simulated lock permission error/i.test(w)), true);
    const saved = loadState(statePath);
    assert.deepEqual(
      saved.markets.map((m) => m.address),
      ["M_timeout_fallback", "M_error_fallback"]
    );
  } finally {
    console.warn = origWarn;
  }
});

test("saveState prunes recycled terminal history to MAX_ARCHIVED_MARKETS on disk and pruned entries do not revive", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veritas-savestate-prune-"));
  const statePath = path.join(tmpDir, "state.json");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  assert.equal(MAX_ARCHIVED_MARKETS, 200);

  // Seed disk directly with 205 recycled terminal entries + 2 open + 1 unrecycled resolved entry
  const initialMarkets = [];
  for (let i = 0; i < 205; i += 1) {
    initialMarkets.push({
      address: `R_${i}`,
      asset: "btc",
      status: i % 2 === 0 ? "resolved" : "windowBurn",
      recycled: true,
    });
  }
  initialMarkets.push(
    { address: "OPEN_1", asset: "eth", status: "open", recycled: false },
    { address: "UNRECYCLED_1", asset: "sol", status: "resolved", recycled: false },
    { address: "OPEN_2", asset: "link", status: "open", recycled: false }
  );
  fs.writeFileSync(
    statePath,
    JSON.stringify({ version: 2, nextBetSide: "yes", dailyCounts: {}, markets: initialMarkets }, null, 2),
    "utf8"
  );

  // Round 1: load full unpruned state, add 1 more recycled entry -> saveState merges then prunes to 200 archived + 3 active
  const round1 = loadState(statePath);
  round1.markets.push({ address: "R_205", asset: "btc", status: "resolved", recycled: true });
  await saveState(statePath, round1);

  const afterRound1 = loadState(statePath);
  const archived1 = afterRound1.markets.filter((m) => m.status !== "open" && m.recycled);
  const active1 = afterRound1.markets.filter((m) => m.status === "open" || !m.recycled);
  assert.equal(archived1.length, 200);
  assert.equal(archived1[0].address, "R_6");
  assert.equal(archived1[archived1.length - 1].address, "R_205");
  assert.deepEqual(
    active1.map((m) => m.address),
    ["OPEN_1", "UNRECYCLED_1", "OPEN_2"]
  );
  assert.equal(afterRound1.markets.some((m) => m.address === "R_0" || m.address === "R_5"), false);

  // Same-process subsequent save using round1 object must not resurrect R_0..R_5
  round1.markets.push({ address: "OPEN_3", asset: "btc", status: "open", recycled: false });
  await saveState(statePath, round1);
  const afterSameProc = loadState(statePath);
  const archivedSame = afterSameProc.markets.filter((m) => m.status !== "open" && m.recycled);
  assert.equal(archivedSame.length, 200);
  assert.equal(archivedSame[0].address, "R_6");
  assert.equal(afterSameProc.markets.some((m) => m.address === "R_0" || m.address === "R_5"), false);

  // Round 2 (next process): load from disk, add 1 more recycled entry -> stays capped at 200, R_0..R_6 never revive
  const round2 = loadState(statePath);
  round2.markets.push({ address: "R_206", asset: "eth", status: "staleBurn", recycled: true });
  await saveState(statePath, round2);

  const afterRound2 = loadState(statePath);
  const archived2 = afterRound2.markets.filter((m) => m.status !== "open" && m.recycled);
  const active2 = afterRound2.markets.filter((m) => m.status === "open" || !m.recycled);
  assert.equal(archived2.length, 200);
  assert.equal(archived2[0].address, "R_7");
  assert.equal(archived2[archived2.length - 1].address, "R_206");
  assert.deepEqual(
    active2.map((m) => m.address),
    ["OPEN_1", "UNRECYCLED_1", "OPEN_2", "OPEN_3"]
  );
  assert.equal(afterRound2.markets.some((m) => m.address === "R_0" || m.address === "R_6"), false);
});
