"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  RESOLVE_WINDOW_SEC,
  defaultTitleForAsset,
  parseAssets,
  resolveAssetForEntry,
  selectExpiredSettleEntries,
  selectWatchEntries,
} = require("./tick");

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
