"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@solana/web3.js");
const {
  DEFAULT_SEED_MAX_USDT,
  DEFAULT_SEED_MIN_USDT,
  DEFAULT_SETTLE_MAX_TOTAL_PROCS,
  DEFAULT_SETTLE_SLOTS,
  MARKET_ACCOUNT_SIZE,
  MARKET_ACCOUNT_SIZE_V2,
  RESOLVE_WINDOW_SEC,
  SELF_SETTLE_SLOT_PREFIX,
  classifySettleProcess,
  computeStaggeredExpiry,
  defaultTitleForAsset,
  getConfig,
  gridAssetForExpiry,
  isLegacyEntry,
  isLegacyMarketAccount,
  parseAssets,
  pickSeedUsdt,
  planMissingMarkets,
  reapStaleSettleProcesses,
  recycleFinalizedEntries,
  resolveAssetForEntry,
  scheduleExpiredSettlements,
  selectExpiredSettleEntries,
  selectWatchEntries,
  settleRetryCooldownSec,
  slotOffsetSec,
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

test("planMissingMarkets 6-slot phase grid maintains steady-state 6 live 15m markets, 150s spacing, 4-asset rotation, and +-75s dedup", () => {
  const assets = parseAssets("btc,eth,sol,link");
  const cfg = { assets, slots: 6, durationSec: 900 };
  const startNow = 1_763_900_000;

  // Cold start: 6 consecutive grid expiries spaced by 150s
  const live = [];
  const initial = planMissingMarkets(cfg, live, startNow);
  assert.equal(initial.length, 6);
  for (let i = 1; i < initial.length; i += 1) {
    assert.equal(initial[i].expiry - initial[i - 1].expiry, 150);
  }
  for (const item of initial) {
    live.push({ asset: item.asset.key, expiry: item.expiry, status: "open" });
  }

  // +-75s dedup: jittering an existing market by +40s must not trigger a duplicate
  const jittered = live.map((m, idx) => (idx === 2 ? { ...m, expiry: m.expiry + 40 } : m));
  assert.equal(planMissingMarkets(cfg, jittered, startNow).length, 0);

  // Steady-state simulation: tick every 60s across 3 hours (180 ticks)
  const seenKeys = new Set(live.map((m) => `${m.asset}:${m.expiry}`));
  let stateLive = [...live];
  for (let step = 1; step <= 180; step += 1) {
    const now = startNow + step * 60;
    stateLive = stateLive.filter((m) => m.expiry > now);
    const toOpen = planMissingMarkets(cfg, stateLive, now);
    for (const item of toOpen) {
      const key = `${item.asset.key}:${item.expiry}`;
      assert.equal(seenKeys.has(key), false, `duplicate (asset, expiry): ${key}`);
      seenKeys.add(key);
      assert.equal(
        gridAssetForExpiry(assets, item.expiry, 900, 6).key,
        item.asset.key
      );
      stateLive.push({ asset: item.asset.key, expiry: item.expiry, status: "open" });
    }

    // Invariants at every tick after opening missing slots
    stateLive.sort((a, b) => a.expiry - b.expiry);
    assert.equal(stateLive.length, 6, `expected 6 live markets at tick ${step}, got ${stateLive.length}`);
    for (let i = 1; i < stateLive.length; i += 1) {
      assert.equal(stateLive[i].expiry - stateLive[i - 1].expiry, 150);
    }
    const assetCounts = new Map(assets.map((a) => [a.key, 0]));
    for (const m of stateLive) {
      assetCounts.set(m.asset, (assetCounts.get(m.asset) || 0) + 1);
    }
    for (const a of assets) {
      assert.ok(assetCounts.get(a.key) >= 1, `asset ${a.key} missing at tick ${step}`);
    }
    // Same-asset markets are 600s apart (300s overlap on 900s duration)
    for (let i = 0; i < stateLive.length; i += 1) {
      for (let j = i + 1; j < stateLive.length; j += 1) {
        if (stateLive[i].asset === stateLive[j].asset) {
          assert.equal(stateLive[j].expiry - stateLive[i].expiry, 600);
        }
      }
    }
  }
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
