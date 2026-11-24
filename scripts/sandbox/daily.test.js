"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseAssets } = require("./tick");
const {
  DAILY_DURATION_SEC,
  computeDailySlot,
  shouldOpenDailySlot,
} = require("./daily");

test("computeDailySlot rotates BTC -> ETH -> SOL -> LINK daily at fixed UTC time", () => {
  const assets = parseAssets("btc,eth,sol,link");
  const baseTs = Date.UTC(2026, 10, 24, 8, 0, 10) / 1000; // 08:00 UTC fixed open

  const seen = [];
  for (let day = 0; day < 5; day += 1) {
    const slot = computeDailySlot(baseTs + day * DAILY_DURATION_SEC, 8, 0, assets, DAILY_DURATION_SEC);
    seen.push(slot);
  }

  const order = ["btc", "eth", "sol", "link"];
  const startIdx = order.indexOf(seen[0].asset.key);
  assert.ok(startIdx >= 0);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(seen[i].asset.key, order[(startIdx + i) % 4]);
    assert.equal(seen[i].expiry - seen[i].slotStartSec, DAILY_DURATION_SEC - 5);
    assert.match(seen[i].slotKey, /^\d{4}-\d{2}-\d{2}@08:00Z$/);
  }
  assert.equal(seen[4].asset.key, seen[0].asset.key);
});

test("shouldOpenDailySlot enforces fixed daily window, single open slot, and live-market guard", () => {
  const assets = parseAssets("btc,eth,sol,link");
  const openTs = Date.UTC(2026, 10, 24, 0, 0, 0) / 1000;
  const slot = computeDailySlot(openTs, 0, 0, assets, DAILY_DURATION_SEC);

  // Inside 10-min fixed opening window -> open
  assert.deepEqual(
    shouldOpenDailySlot({
      nowSec: openTs + 60,
      slot,
      openWindowSec: 600,
      state: { markets: [] },
    }),
    { open: true, reason: "due" }
  );

  // Already opened for this daily slot -> skip
  assert.deepEqual(
    shouldOpenDailySlot({
      nowSec: openTs + 120,
      slot,
      openWindowSec: 600,
      state: { markets: [{ dailySlot: slot.slotKey, status: "open", expiry: slot.expiry }] },
    }),
    { open: false, reason: "slot_already_opened" }
  );

  // Another open 24h market still live -> skip
  assert.deepEqual(
    shouldOpenDailySlot({
      nowSec: openTs + 120,
      slot,
      openWindowSec: 600,
      state: { markets: [{ dailySlot: "prev", status: "open", expiry: openTs + 7200 }] },
    }),
    { open: false, reason: "market_still_live" }
  );

  // Outside fixed opening window -> skip unless --force-open
  assert.deepEqual(
    shouldOpenDailySlot({
      nowSec: openTs + 1800,
      slot,
      openWindowSec: 600,
      state: { markets: [] },
    }),
    { open: false, reason: "outside_open_window" }
  );
  assert.deepEqual(
    shouldOpenDailySlot({
      nowSec: openTs + 1800,
      slot,
      openWindowSec: 600,
      state: { markets: [] },
      forceOpen: true,
    }),
    { open: true, reason: "due" }
  );

  // Too close (<1h) to slot expiry -> refuse even with --force-open
  assert.deepEqual(
    shouldOpenDailySlot({
      nowSec: slot.expiry - 1800,
      slot,
      openWindowSec: 600,
      state: { markets: [] },
      forceOpen: true,
    }),
    { open: false, reason: "too_close_to_expiry" }
  );
});
