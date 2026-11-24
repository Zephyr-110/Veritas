"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseOcr2Transmit, pickStraddlingPair, shouldRecordSnapshot, recordExpirySnapshots } = require("../settle");
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

test("witnesses the last pre and its first consecutive post within the strict window", () => {
  const endTs = 100;
  const decide = (overrides) => shouldRecordSnapshot({
    endTs, chainNow: 92, counter: 10, publishTime: 91, entries: [], attempted: new Set(), ...overrides,
  });
  assert.equal(decide({ chainNow: 90 }), false);
  assert.equal(decide({ chainNow: 110 }), false);
  assert.equal(decide({}), true);
  assert.equal(decide({ attempted: new Set([10]) }), false);
  const pre = [{ counter: 9, ts: 91 }];
  assert.equal(decide({ entries: pre }), false);
  assert.equal(decide({ entries: pre, chainNow: 99 }), true);
  assert.equal(decide({ entries: pre, chainNow: 101, publishTime: 100 }), true);
  assert.equal(decide({ entries: pre, chainNow: 101, publishTime: 100, counter: 11 }), false);
  assert.equal(decide({ entries: [], chainNow: 101, publishTime: 100 }), false);
  assert.equal(decide({ entries: [{ counter: 9, ts: 100 }], chainNow: 101 }), false);
  assert.equal(decide({ chainNow: 99, attempted: new Set([8, 9]) }), false);
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
  t.mock.method(Date, "now", () => (reads > 5 ? endTs + 10 : endTs - 3 + broadcasts * 3) * 1000);
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
      assert.equal(options.maxRetries, 0);
      return String(++broadcasts);
    },
  };
  const program = new Program(idl, new AnchorProvider(connection, new Wallet(payer), {}));
  await recordExpirySnapshots(connection, program, payer, market, { endTs, ocr2State: PublicKey.default }, feed);
  assert.equal(broadcasts, 2);
});
