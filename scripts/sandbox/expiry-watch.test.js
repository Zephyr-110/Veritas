"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseOcr2Transmit, pickStraddlingPair } = require("../settle");
const { tryLock, watchReports } = require("./expiry-watch");

test("strict epoch rollover, expiry inclusion and rejection of skipped rounds", () => {
  const report = id => parseOcr2Transmit(fs.readFileSync(path.join(__dirname,
    "../../programs/prediction_market/tests/fixtures", id + ".bin")));
  const pre = report("e7190799_r6"), post = report("e7190800_r1");
  assert.ok(pickStraddlingPair([post, pre], post.observationsTimestamp, 6, null)?.adjacent);
  assert.equal(pickStraddlingPair([pre, post], pre.observationsTimestamp, 6, null), null);
  assert.equal(pickStraddlingPair([pre, report("e7190800_r2")], post.observationsTimestamp, 6, null), null);
});

test("an advanced counter retries an unindexed body and broadcasts only once", async () => {
  let reads = 0, submissions = 0;
  const endTs = Math.floor(Date.now() / 1000);
  const log = [];
  const pre = { epoch: 3, round: 2, observationsTimestamp: endTs - 1 };
  const post = { epoch: 3, round: 3, observationsTimestamp: endTs };
  await watchReports({ endTs, log: msg => log.push(msg),
    readHead: async () => ({ id: "3/3", counter: 9 }),
    collect: async () => ++reads === 1 ? [pre] : [post],
    pick: rs => pickStraddlingPair(rs, endTs, 6, null),
    onPair: async () => { submissions++; },
  });
  assert.equal(submissions, 1);
  assert.ok(log.some(m => m.includes("awaiting report body")));
});

test("a late post leaves the window to the fallback", async () => {
  const endTs = Date.now() / 1000 - 24.95;
  await watchReports({ endTs, log: () => {}, readHead: async () => ({ id: "2/3", counter: 5 }),
    collect: async () => [],
    pick: () => ({ adjacent: true, post: { observationsTimestamp: endTs + 11 } }),
    onPair: () => assert.fail("late pair submitted"),
  });
});

test("overlapping settlers exclude each other for a market", async () => {
  const name = "test-" + process.pid;
  const release = await tryLock(name);
  assert.ok(release);
  try { assert.equal(await tryLock(name), null); } finally { release(); }
});
