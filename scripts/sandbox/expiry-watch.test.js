"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseOcr2Transmit,
  pickStraddlingPair,
  shouldRecordSnapshot,
  recordExpirySnapshots,
  createSnapshotCoordinator,
} = require("../settle");
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

test("witnesses strictly increasing counters across the expiry window without pre-expiry reservation locks", () => {
  const endTs = 100;
  const decide = (overrides) => shouldRecordSnapshot({
    endTs, chainNow: 92, counter: 10, publishTime: 91, entries: [], attempted: new Map(), nowMs: 100_000, ...overrides,
  });
  assert.equal(decide({ chainNow: 90 }), false);
  assert.equal(decide({ chainNow: 91 }), false);
  assert.equal(decide({ chainNow: 110 }), false);
  assert.equal(decide({}), true);
  // Allows recording every pre-expiry counter even with 2+ prior entries and before endTs - 2.
  const twoEntries = [{ counter: 8, ts: 88 }, { counter: 9, ts: 91 }];
  assert.equal(decide({ entries: twoEntries, chainNow: 93, counter: 10, publishTime: 92 }), true);
  // Allows recording post even if pre skipped a counter or snapshot was empty.
  assert.equal(decide({ entries: [{ counter: 9, ts: 91 }], chainNow: 101, publishTime: 100, counter: 11 }), true);
  assert.equal(decide({ entries: [], chainNow: 101, publishTime: 100, counter: 11 }), true);
  // Stops once post is recorded, counter stalls, or caps are hit.
  assert.equal(decide({ entries: [{ counter: 9, ts: 100 }], chainNow: 101, counter: 10 }), false);
  assert.equal(decide({ entries: [{ counter: 10, ts: 91 }], chainNow: 95, counter: 10 }), false);
  assert.equal(decide({ entries: Array.from({ length: 16 }, (_, i) => ({ counter: i + 1, ts: 80 + i })), counter: 20 }), false);
  assert.equal(decide({ submissions: 10, counter: 20 }), false);
  // Retry cooldown via Map: blocks < 1500ms, allows >= 1500ms.
  const attempted = new Map([[10, 100_000]]);
  assert.equal(decide({ attempted, nowMs: 101_000 }), false);
  assert.equal(decide({ attempted, nowMs: 101_500 }), true);
});

test("builds signed take_snapshot transactions for two successive feed counters", async (t) => {
  const { Program, AnchorProvider, Wallet } = require("@coral-xyz/anchor");
  const { Keypair, PublicKey, Transaction } = require("@solana/web3.js");
  const idl = require("../../app/src/idl/prediction_market.json");
  const payer = Keypair.generate();
  const market = Keypair.generate().publicKey;
  const feed = Keypair.generate().publicKey;
  const endTs = 1700000000;
  let broadcasts = 0;
  let reads = 0;
  t.mock.method(Date, "now", () => (reads > 5 ? endTs + 12 : endTs - 3 + broadcasts * 3) * 1000);
  const connection = {
    getMultipleAccountsInfo: async () => {
      reads++;
      const head = Buffer.alloc(224);
      const saved = Buffer.alloc(12 + broadcasts * 33 + 1);
      saved.set([107, 32, 221, 188, 130, 114, 104, 28]);
      saved.writeUInt32LE(broadcasts, 8);
      for (let i = 0; i < broadcasts; i++) {
        saved.writeUInt32LE(40 + i, 12 + i * 33 + 5);
        saved.writeBigInt64LE(BigInt(endTs - 3 + i * 3), 12 + i * 33 + 25);
      }
      const clock = Buffer.alloc(40);
      const time = BigInt(Math.floor(Date.now() / 1000));
      clock.writeBigInt64LE(time, 32);
      head.writeBigInt64LE(time, 208);
      head.writeUInt32LE(40 + broadcasts, 143);
      return [head, saved, clock].map(data => ({ data }));
    },
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58() }),
    sendRawTransaction: async (bytes, options) => {
      const tx = Transaction.from(bytes);
      assert.ok(tx.verifySignatures());
      const [ix] = tx.instructions;
      assert.deepEqual([...ix.data], idl.instructions.find(ix => ix.name === "take_snapshot").discriminator);
      assert.ok(ix.keys[1].pubkey.equals(market) && ix.keys[4].pubkey.equals(feed));
      assert.equal(options.maxRetries, 2);
      return String(++broadcasts);
    },
  };
  const program = new Program(idl, new AnchorProvider(connection, new Wallet(payer), {}));
  await recordExpirySnapshots(connection, program, payer, market, { endTs, ocr2State: PublicKey.default }, feed, null, { pollMs: 5 });
  assert.equal(broadcasts, 2);
});

function buildMockAccounts({ feedHead, entries, chainNow }) {
  const head = Buffer.alloc(232);
  head.writeUInt32LE(feedHead.counter, 143);
  head.writeBigInt64LE(BigInt(feedHead.ts), 208);

  const saved = Buffer.alloc(12 + entries.length * 33 + 1);
  saved.set([107, 32, 221, 188, 130, 114, 104, 28]);
  saved.writeUInt32LE(entries.length, 8);
  entries.forEach((e, i) => {
    const off = 12 + i * 33;
    saved.writeUInt32LE(e.epoch ?? 7210354, off);
    saved.writeUInt8(e.round ?? i + 1, off + 4);
    saved.writeUInt32LE(e.counter, off + 5);
    saved.writeBigInt64LE(BigInt(e.ts), off + 25);
  });

  const clock = Buffer.alloc(40);
  clock.writeBigInt64LE(BigInt(chainNow), 32);
  return [head, saved, clock].map((data) => ({ data }));
}

test("Case 1 timeline: records pre landing after endTs-2 and consecutive post even with lagging local clock", async (t) => {
  const { Program, AnchorProvider, Wallet } = require("@coral-xyz/anchor");
  const { Keypair, PublicKey } = require("@solana/web3.js");
  const idl = require("../../app/src/idl/prediction_market.json");
  const payer = Keypair.generate();
  const market = Keypair.generate().publicKey;
  const feed = Keypair.generate().publicKey;
  const endTs = 1795606195;

  const timeline = [
    { chainNow: 1795606187, counter: 41974797, ts: 1795606184, epoch: 7210353, round: 5 },
    { chainNow: 1795606190, counter: 41974798, ts: 1795606187, epoch: 7210353, round: 6 },
    { chainNow: 1795606193, counter: 41974799, ts: 1795606190, epoch: 7210354, round: 1 },
    // True pre arrives at endTs - 1 (after endTs - 2 threshold).
    { chainNow: 1795606194, counter: 41974800, ts: 1795606193, epoch: 7210354, round: 2 },
    // True post arrives at endTs + 2.
    { chainNow: 1795606197, counter: 41974801, ts: 1795606196, epoch: 7210354, round: 3 },
  ];

  const onChainEntries = [];
  let idx = 0;
  let initialNowCalls = 0;
  t.mock.method(Date, "now", () => {
    // Initial waitMs check sees endTs - 10 so loop starts immediately;
    // first poll simulates VPS clock 1s behind endTs - 10 while chainNow = endTs - 8.
    initialNowCalls++;
    if (initialNowCalls <= 1) return (endTs - 10) * 1000;
    if (idx === 0 && onChainEntries.length === 0) return (endTs - 11) * 1000;
    const cur = timeline[Math.min(idx, timeline.length - 1)];
    return cur.chainNow * 1000;
  });

  const submittedCounters = [];
  const connection = {
    getMultipleAccountsInfo: async () => {
      const cur = timeline[Math.min(idx, timeline.length - 1)];
      return buildMockAccounts({ feedHead: cur, entries: onChainEntries, chainNow: cur.chainNow });
    },
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58() }),
    sendRawTransaction: async (_bytes, options) => {
      assert.equal(options.maxRetries, 2);
      const cur = timeline[idx];
      submittedCounters.push(cur.counter);
      onChainEntries.push({ epoch: cur.epoch, round: cur.round, counter: cur.counter, ts: cur.ts });
      if (idx < timeline.length - 1) idx++;
      return `sig-${cur.counter}`;
    },
  };
  const program = new Program(idl, new AnchorProvider(connection, new Wallet(payer), {}));
  await recordExpirySnapshots(
    connection,
    program,
    payer,
    market,
    { endTs, ocr2State: PublicKey.default },
    feed,
    null,
    { pollMs: 5, fastPollMs: 5 }
  );

  assert.deepEqual(submittedCounters, [41974797, 41974798, 41974799, 41974800, 41974801]);
  const preIdx = onChainEntries.findIndex((e) => e.counter === 41974800 && e.ts === 1795606193);
  assert.ok(preIdx >= 0, "true pre must be recorded");
  assert.equal(onChainEntries[preIdx + 1]?.counter, 41974801);
  assert.equal(onChainEntries[preIdx + 1]?.ts, 1795606196);
});

test("resolve waits for post snapshot before submitting, and times out cleanly without stalling", async () => {
  const { Program, AnchorProvider, Wallet } = require("@coral-xyz/anchor");
  const { Keypair, PublicKey } = require("@solana/web3.js");
  const idl = require("../../app/src/idl/prediction_market.json");
  const payer = Keypair.generate();
  const market = Keypair.generate().publicKey;
  const feed = Keypair.generate().publicKey;

  // Subcase A: post lands after waitForPost starts -> resolve waits until post is recorded.
  {
    const endTs = Math.floor(Date.now() / 1000) - 1;
    const events = [];
    const onChainEntries = [{ epoch: 7210354, round: 2, counter: 41974800, ts: endTs - 2 }];
    let pollCount = 0;
    const coord = createSnapshotCoordinator(endTs, { maxWaitMs: 2000 });

    const connection = {
      getMultipleAccountsInfo: async () => {
        pollCount++;
        const feedHead =
          pollCount >= 2
            ? { counter: 41974801, ts: endTs + 1, epoch: 7210354, round: 3 }
            : { counter: 41974800, ts: endTs - 2, epoch: 7210354, round: 2 };
        return buildMockAccounts({ feedHead, entries: onChainEntries, chainNow: endTs + 2 });
      },
      getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58() }),
      sendRawTransaction: async () => {
        onChainEntries.push({ epoch: 7210354, round: 3, counter: 41974801, ts: endTs + 1 });
        events.push("snapshot:post");
        return "sig-post";
      },
    };
    const program = new Program(idl, new AnchorProvider(connection, new Wallet(payer), {}));
    const witness = recordExpirySnapshots(
      connection,
      program,
      payer,
      market,
      { endTs, ocr2State: PublicKey.default },
      feed,
      coord,
      { pollMs: 15, fastPollMs: 10 }
    );
    const waitResult = await coord.waitForPost((endTs + 25) * 1000);
    events.push("resolve:sent");
    coord.stop();
    await witness;

    assert.equal(waitResult, true);
    assert.deepEqual(events, ["snapshot:post", "resolve:sent"]);
  }

  // Subcase B: post never arrives -> waitForPost times out and does not block resolve.
  {
    const endTs = Math.floor(Date.now() / 1000) - 1;
    const onChainEntries = [{ epoch: 7210354, round: 2, counter: 41974800, ts: endTs - 2 }];
    const coord = createSnapshotCoordinator(endTs, { maxWaitMs: 60 });

    const connection = {
      getMultipleAccountsInfo: async () =>
        buildMockAccounts({
          feedHead: { counter: 41974800, ts: endTs - 2 },
          entries: onChainEntries,
          chainNow: endTs + 2,
        }),
      getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58() }),
      sendRawTransaction: async () => assert.fail("no new counter to send"),
    };
    const program = new Program(idl, new AnchorProvider(connection, new Wallet(payer), {}));
    const witness = recordExpirySnapshots(
      connection,
      program,
      payer,
      market,
      { endTs, ocr2State: PublicKey.default },
      feed,
      coord,
      { pollMs: 25, fastPollMs: 15 }
    );
    const waitResult = await coord.waitForPost((endTs + 25) * 1000);
    coord.stop();
    await witness;

    assert.equal(waitResult, false);
    assert.equal(coord.stopped, true);
  }
});

test("retries a counter on send failure and on dropped confirmation without blacklisting", async (t) => {
  const { Program, AnchorProvider, Wallet } = require("@coral-xyz/anchor");
  const { Keypair, PublicKey } = require("@solana/web3.js");
  const idl = require("../../app/src/idl/prediction_market.json");
  const payer = Keypair.generate();
  const market = Keypair.generate().publicKey;
  const feed = Keypair.generate().publicKey;
  const endTs = 1795606195;

  const onChainEntries = [{ epoch: 7210354, round: 1, counter: 41974799, ts: 1795606190 }];
  let nowSec = 1795606194;
  let preSendAttempts = 0;
  let postSendAttempts = 0;
  let phase = "pre";
  let dropPending = false;

  t.mock.method(Date, "now", () => nowSec * 1000);

  const connection = {
    getMultipleAccountsInfo: async () => {
      if (dropPending) {
        nowSec += 2;
        dropPending = false;
      }
      const feedHead =
        phase === "pre"
          ? { counter: 41974800, ts: 1795606193, epoch: 7210354, round: 2 }
          : { counter: 41974801, ts: 1795606196, epoch: 7210354, round: 3 };
      return buildMockAccounts({ feedHead, entries: onChainEntries, chainNow: nowSec });
    },
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58() }),
    sendRawTransaction: async () => {
      if (phase === "pre") {
        preSendAttempts++;
        if (preSendAttempts === 1) {
          throw new Error("preflight failed");
        }
        onChainEntries.push({ epoch: 7210354, round: 2, counter: 41974800, ts: 1795606193 });
        phase = "post";
        nowSec = 1795606197;
        return "sig-pre-retry";
      }
      postSendAttempts++;
      if (postSendAttempts === 1) {
        // Simulates a dropped tx after sendRawTransaction succeeded; advance clock >= 1500ms on next poll.
        dropPending = true;
        return "sig-post-dropped";
      }
      onChainEntries.push({ epoch: 7210354, round: 3, counter: 41974801, ts: 1795606196 });
      return "sig-post-retry";
    },
  };
  const program = new Program(idl, new AnchorProvider(connection, new Wallet(payer), {}));
  await recordExpirySnapshots(
    connection,
    program,
    payer,
    market,
    { endTs, ocr2State: PublicKey.default },
    feed,
    null,
    { pollMs: 5, fastPollMs: 5 }
  );

  assert.equal(preSendAttempts, 2, "failed pre send must be retried");
  assert.equal(postSendAttempts, 2, "dropped post send must be retried after cooldown");
  assert.deepEqual(
    onChainEntries.map((e) => e.counter),
    [41974799, 41974800, 41974801]
  );
});
