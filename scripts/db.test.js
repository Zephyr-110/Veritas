"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Keypair, PublicKey } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID } = require("@solana/spl-token");

const dbLib = require("./db");

function makeTempDbPath(label) {
  return path.join(
    os.tmpdir(),
    `veritas-db-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

function cleanupDb(filePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = filePath + suffix;
    if (fs.existsSync(target)) {
      try {
        fs.unlinkSync(target);
      } catch {
        // ignore transient cleanup lock
      }
    }
  }
}

function makeSyntheticMarketBuffer({
  expiry = 1_800_000_900n,
  endTs = 1_800_000_900n,
  creator = Keypair.generate().publicKey,
  id = Array.from({ length: 16 }, (_, i) => i + 1),
  yesMint = Keypair.generate().publicKey,
  noMint = Keypair.generate().publicKey,
  collateralMint = Keypair.generate().publicKey,
  statusByte = 0,
  winnerTag = 0,
  winnerSide = 0,
  title = "BTC/USD at or above opening price in 15 min?",
  finishTs = 0n,
  ocr2State = new PublicKey(dbLib.FEEDS[0].state),
  threshold = 95_000_00000000n,
  settledPrice = 0n,
  settledPublishTime = 0n,
} = {}) {
  const buf = Buffer.alloc(dbLib.MARKET_ACCOUNT_SIZE);
  Buffer.from(dbLib.MARKET_DISCRIMINATOR).copy(buf, 0);
  let off = 8;
  buf.writeBigUInt64LE(expiry, off); off += 8;
  creator.toBuffer().copy(buf, off); off += 32;
  Buffer.from(id).copy(buf, off); off += 16;
  buf.writeUInt8(254, off); off += 1; // bump
  yesMint.toBuffer().copy(buf, off); off += 32;
  noMint.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(statusByte, off); off += 1;
  collateralMint.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(winnerTag, off); off += 1;
  if (winnerTag === 1) {
    buf.writeUInt8(winnerSide, off); off += 1;
  }
  buf.writeUInt8(253, off); off += 1; // marketCollateralBump
  const titleBuf = Buffer.from(title, "utf8");
  titleBuf.copy(buf, off, 0, Math.min(64, titleBuf.length));
  off += 64;
  buf.writeBigUInt64LE(finishTs, off); off += 8;
  // lZero = 100 << 48
  const lZero = 100n << 48n;
  buf.writeBigUInt64LE(lZero & ((1n << 64n) - 1n), off);
  buf.writeBigInt64LE(lZero >> 64n, off + 8);
  off += 16;
  buf.writeBigInt64LE(endTs - 900n, off); off += 8; // lastAccrualTs
  off += 16; // cumYesPerShare
  off += 16; // cumNoPerShare
  buf.writeUInt16LE(30, off); off += 2; // feeBps
  const rYes = 150_000_000n << 48n;
  const rNo = 150_000_000n << 48n;
  buf.writeBigUInt64LE(rYes & ((1n << 64n) - 1n), off);
  buf.writeBigInt64LE(rYes >> 64n, off + 8);
  off += 16;
  buf.writeBigUInt64LE(rNo & ((1n << 64n) - 1n), off);
  buf.writeBigInt64LE(rNo >> 64n, off + 8);
  off += 16;
  buf.writeBigUInt64LE(rYes & ((1n << 64n) - 1n), off);
  buf.writeBigInt64LE(rYes >> 64n, off + 8);
  off += 16;
  buf.writeBigInt64LE(endTs, off); off += 8;
  ocr2State.toBuffer().copy(buf, off); off += 32;
  buf.writeBigInt64LE(threshold, off); off += 8;
  buf.writeUInt8(8, off); off += 1; // priceDecimals
  buf.writeUInt8(1, off); off += 1; // settleAbove
  buf.writeBigInt64LE(settledPrice, off); off += 8;
  buf.writeBigInt64LE(settledPublishTime, off);
  return buf;
}

test("openDb configures WAL + memory-capped pragmas and schema", (t) => {
  const dbPath = makeTempDbPath("pragmas");
  const db = dbLib.openDb(dbPath);
  t.after(() => {
    if (db.open) db.close();
    cleanupDb(dbPath);
  });

  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("cache_size", { simple: true }), -8000);
  assert.equal(db.pragma("mmap_size", { simple: true }), 0);
  assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes("markets"));
  assert.ok(tables.includes("settlement_evidence"));
  assert.ok(tables.includes("wallet_positions"));
  assert.ok(tables.includes("wallet_sync_state"));
});

test("decodeMarketFull, upsertMarkets preserves opened_at, and refreshClaimableForMarket updates on resolution", (t) => {
  const dbPath = makeTempDbPath("markets");
  const db = dbLib.openDb(dbPath);
  t.after(() => {
    if (db.open) db.close();
    cleanupDb(dbPath);
  });

  const marketPk = Keypair.generate().publicKey;
  const walletPk = Keypair.generate().publicKey;
  const creatorPk = Keypair.generate().publicKey;

  const openBuf = makeSyntheticMarketBuffer({
    creator: creatorPk,
    statusByte: 0,
    winnerTag: 0,
  });
  const decodedOpen = dbLib.decodeMarketFull(openBuf);
  assert.equal(decodedOpen.status, "open");
  assert.equal(decodedOpen.winner, null);
  assert.equal(decodedOpen.feedKey, undefined);

  const rowOpen = dbLib.buildMarketRow({
    programId: dbLib.DEFAULT_PROGRAM_ID,
    address: marketPk,
    account: decodedOpen,
    tokenProgram: TOKEN_PROGRAM_ID,
    decimals: 6,
    vault: 152_000_000n,
    openedAt: 1_800_000_005,
  });
  assert.equal(rowOpen.duration_sec, 900);
  assert.equal(rowOpen.duration_bucket, "15m");
  assert.equal(rowOpen.opened_at, 1_800_000_005);

  dbLib.upsertMarkets(db, [rowOpen]);

  // Simulate wallet holding YES tokens while market is still open
  dbLib.replaceWalletPositions(db, walletPk.toBase58(), dbLib.DEFAULT_PROGRAM_ID, [
    {
      wallet: walletPk.toBase58(),
      market_address: marketPk.toBase58(),
      program_id: dbLib.DEFAULT_PROGRAM_ID,
      yes_amount: "4000000",
      no_amount: "0",
      lp_shares: "0",
      pending_yes: "0",
      pending_no: "0",
      claimable_amount: "0",
      can_claim: 0,
      collateral_amount: "25000000",
      updated_at: 1_800_000_100,
    },
  ]);

  // Now market resolves YES won, and subsequent upsert omits openedAt
  const resolvedBuf = makeSyntheticMarketBuffer({
    creator: creatorPk,
    statusByte: 1,
    winnerTag: 1,
    winnerSide: 0,
    finishTs: 1_800_000_903n,
    settledPrice: 96_000_00000000n,
    settledPublishTime: 1_800_000_901n,
  });
  const decodedResolved = dbLib.decodeMarketFull(resolvedBuf);
  const rowResolved = dbLib.buildMarketRow({
    programId: dbLib.DEFAULT_PROGRAM_ID,
    address: marketPk,
    account: decodedResolved,
    tokenProgram: TOKEN_PROGRAM_ID,
    decimals: 6,
    vault: 152_000_000n,
    openedAt: null,
  });
  dbLib.upsertMarkets(db, [rowResolved]);
  const updatedCount = dbLib.refreshClaimableForMarket(db, rowResolved);
  assert.equal(updatedCount, 1);

  const savedMarket = db
    .prepare("SELECT opened_at, status, winner, settled_price FROM markets WHERE address = ?")
    .get(marketPk.toBase58());
  assert.equal(savedMarket.opened_at, 1_800_000_005);
  assert.equal(savedMarket.status, "resolved");
  assert.equal(savedMarket.winner, "yes");
  assert.equal(savedMarket.settled_price, "9600000000000");

  const savedPos = db
    .prepare("SELECT claimable_amount, can_claim FROM wallet_positions WHERE wallet = ? AND market_address = ?")
    .get(walletPk.toBase58(), marketPk.toBase58());
  assert.equal(savedPos.claimable_amount, "4000000");
  assert.equal(savedPos.can_claim, 1);

  // Check getReclaimableMarkets respects cutoff
  const reclaimEarly = dbLib.getReclaimableMarkets(
    db,
    dbLib.DEFAULT_PROGRAM_ID,
    creatorPk.toBase58(),
    1_800_000_900,
    10
  );
  assert.equal(reclaimEarly.length, 0);

  const reclaimDue = dbLib.getReclaimableMarkets(
    db,
    dbLib.DEFAULT_PROGRAM_ID,
    creatorPk.toBase58(),
    1_800_000_905,
    10
  );
  assert.equal(reclaimDue.length, 1);
  assert.equal(reclaimDue[0].address, marketPk.toBase58());
});

test("upsertSettlementEvidence is immutable once set and only fills missing push/counter fields", (t) => {
  const dbPath = makeTempDbPath("evidence");
  const db = dbLib.openDb(dbPath);
  t.after(() => {
    if (db.open) db.close();
    cleanupDb(dbPath);
  });

  const marketAddr = Keypair.generate().publicKey.toBase58();
  dbLib.upsertSettlementEvidence(db, {
    market_address: marketAddr,
    program_id: dbLib.DEFAULT_PROGRAM_ID,
    feed_address: dbLib.FEEDS[0].feed,
    snapshot_address: Keypair.generate().publicKey.toBase58(),
    resolve_signature: "sig-resolve-1",
    resolve_tx_url: "https://explorer.solana.com/tx/sig-resolve-1?cluster=devnet",
    settled_price: "9600000000000",
    price_decimals: 8,
    winner: "yes",
    status: "resolved",
    pre_epoch: 100,
    pre_round: 2,
    pre_counter: null,
    pre_price: "9490000000000",
    pre_timestamp: 1800000898,
    pre_push_signature: null,
    pre_push_tx_url: null,
    post_epoch: 100,
    post_round: 3,
    post_counter: null,
    post_price: "9600000000000",
    post_timestamp: 1800000901,
    post_push_signature: "sig-post-1",
    post_push_tx_url: "https://explorer.solana.com/tx/sig-post-1?cluster=devnet",
    missing_count: null,
    created_at: 1800000905,
  });

  // Attempt overwrite of resolve_signature & settled_price while filling missing pre_push & counters
  dbLib.upsertSettlementEvidence(db, {
    market_address: marketAddr,
    program_id: dbLib.DEFAULT_PROGRAM_ID,
    feed_address: dbLib.FEEDS[0].feed,
    snapshot_address: Keypair.generate().publicKey.toBase58(),
    resolve_signature: "sig-resolve-SHOULD-NOT-OVERWRITE",
    resolve_tx_url: "https://explorer.solana.com/tx/bad",
    settled_price: "1",
    price_decimals: 8,
    winner: "no",
    status: "resolved",
    pre_epoch: 999,
    pre_round: 9,
    pre_counter: 42,
    pre_price: "1",
    pre_timestamp: 1,
    pre_push_signature: "sig-pre-1",
    pre_push_tx_url: "https://explorer.solana.com/tx/sig-pre-1?cluster=devnet",
    post_epoch: 999,
    post_round: 10,
    post_counter: 43,
    post_price: "1",
    post_timestamp: 2,
    post_push_signature: "sig-post-SHOULD-NOT-OVERWRITE",
    post_push_tx_url: "https://explorer.solana.com/tx/bad-post",
    missing_count: 0,
    created_at: 1999999999,
  });

  const saved = db
    .prepare("SELECT * FROM settlement_evidence WHERE market_address = ?")
    .get(marketAddr);
  assert.equal(saved.resolve_signature, "sig-resolve-1");
  assert.equal(saved.settled_price, "9600000000000");
  assert.equal(saved.winner, "yes");
  assert.equal(saved.pre_epoch, 100);
  assert.equal(saved.pre_push_signature, "sig-pre-1");
  assert.equal(saved.post_push_signature, "sig-post-1");
  assert.equal(saved.pre_counter, 42);
  assert.equal(saved.post_counter, 43);
  assert.equal(saved.missing_count, 0);

  const counts = dbLib.witnessCounts(
    {
      entries: [
        { epoch: 100, round: 2, counter: 42, price: 9490000000000n, ts: 1800000898n },
        { epoch: 100, round: 3, counter: 43, price: 9600000000000n, ts: 1800000901n },
      ],
    },
    { epoch: 100, round: 2, observationsTimestamp: 1800000898, median: 9490000000000n },
    { epoch: 100, round: 3, observationsTimestamp: 1800000901, median: 9600000000000n }
  );
  assert.deepEqual(counts, [42, 43]);
});

test("claimableOf floors voided YES and NO independently and indexer extracts failed OCR2 push payloads", async () => {
  // Double-odd void balances: floor(3/2) + floor(3/2) = 2, not floor((3+3)/2) = 3
  assert.equal(dbLib.claimableOf("staleBurn", null, 3n, 3n), 2n);
  assert.equal(dbLib.claimableOf("windowBurn", null, 1n, 1n), 0n);
  assert.equal(dbLib.claimableOf("resolved", "yes", 7n, 9n), 7n);

  const indexer = require("./index-markets");
  const ocr2Program = new PublicKey("cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ");
  const digest = Buffer.alloc(32, 0xab);
  const makeRawReport = (epoch, round, ts, median) => {
    const raw = Buffer.alloc(1 + 96 + 61 + 65 * 2);
    digest.copy(raw, 1);
    raw.writeUInt32BE(epoch, 1 + 59);
    raw[1 + 63] = round;
    raw.writeUInt32BE(ts, 1 + 96);
    raw[1 + 96 + 4] = 4;
    raw.writeBigInt64BE(median >> 64n, 1 + 96 + 37);
    raw.writeBigUInt64BE(BigInt.asUintN(64, median), 1 + 96 + 45);
    return raw;
  };
  const preRaw = makeRawReport(500, 1, 1_800_000_000, 95_000_00000000n);
  const postRaw = makeRawReport(500, 2, 1_800_000_003, 95_100_00000000n);

  const failedPushTx = {
    transaction: {
      signatures: ["sig-failed-post-push"],
      message: {
        getAccountKeys: () => ({ get: () => ocr2Program }),
        compiledInstructions: [{ programIdIndex: 0, accountKeyIndexes: [], data: postRaw }],
      },
    },
    meta: { err: { InstructionError: [0, { Custom: 1 }] }, innerInstructions: [] },
  };
  const okPushTx = {
    transaction: {
      signatures: ["sig-ok-pre-push"],
      message: {
        getAccountKeys: () => ({ get: () => ocr2Program }),
        compiledInstructions: [{ programIdIndex: 0, accountKeyIndexes: [], data: preRaw }],
      },
    },
    meta: { err: null, innerInstructions: [] },
  };

  // extractOcr2Instructions must extract payloads from failed push transactions too
  assert.equal(indexer.extractOcr2Instructions(failedPushTx).length, 1);

  const mockConn = {
    getSignaturesForAddress: async () => [
      { signature: "sig-failed-post-push", blockTime: 1_800_000_003, err: { InstructionError: [0, { Custom: 1 }] } },
      { signature: "sig-ok-pre-push", blockTime: 1_800_000_000, err: null },
    ],
    getTransactions: async () => [failedPushTx, okPushTx],
  };

  const pushes = await indexer.findPushSignaturesForRuling(
    mockConn,
    new PublicKey(dbLib.FEEDS[0].feed),
    {
      signature: "sig-resolve",
      pre: { configDigest: digest, raw: preRaw, observationsTimestamp: 1_800_000_000 },
      post: { configDigest: digest, raw: postRaw, observationsTimestamp: 1_800_000_003 },
    }
  );
  assert.deepEqual(pushes, { pre: "sig-ok-pre-push", post: "sig-failed-post-push" });
});

test("dual-layout 409 (v1) and 415 (v2) Market buffers decode consistently across db, settle, settle-all, tick, and indexer", async (t) => {
  const settleLib = require("./settle");
  const settleAllLib = require("./sandbox/settle-all");
  const tickLib = require("./sandbox/tick");
  const indexerLib = require("./index-markets");

  function makeV2MarketBuffer({
    expiry = 1_800_000_900n,
    startTs = 1_800_000_000n,
    endTs = 1_800_000_900n,
    creator = Keypair.generate().publicKey,
    id = Array.from({ length: 16 }, (_, i) => i + 21),
    yesMint = Keypair.generate().publicKey,
    noMint = Keypair.generate().publicKey,
    collateralMint = Keypair.generate().publicKey,
    statusByte = 0,
    title = "ETH/USD at or above opening price in 15 min?",
    ocr2State = new PublicKey(dbLib.FEEDS[1].state),
    threshold = 3_200_00000000n,
  } = {}) {
    const buf = Buffer.alloc(dbLib.MARKET_ACCOUNT_SIZE_V2);
    Buffer.from(dbLib.MARKET_DISCRIMINATOR).copy(buf, 0);
    let off = 8;
    buf.writeBigUInt64LE(expiry, off); off += 8;
    creator.toBuffer().copy(buf, off); off += 32;
    Buffer.from(id).copy(buf, off); off += 16;
    buf.writeUInt8(254, off); off += 1;
    yesMint.toBuffer().copy(buf, off); off += 32;
    noMint.toBuffer().copy(buf, off); off += 32;
    buf.writeUInt8(statusByte, off); off += 1;
    collateralMint.toBuffer().copy(buf, off); off += 32;
    buf.writeUInt8(0, off); off += 1; // winner = None
    buf.writeUInt8(253, off); off += 1; // marketCollateralBump
    const titleBuf = Buffer.from(title, "utf8");
    titleBuf.copy(buf, off, 0, Math.min(64, titleBuf.length));
    off += 64;
    buf.writeBigUInt64LE(0n, off); off += 8; // finishTs
    const lZero = 100n << 48n;
    buf.writeBigUInt64LE(lZero & ((1n << 64n) - 1n), off);
    buf.writeBigInt64LE(lZero >> 64n, off + 8);
    off += 16;
    buf.writeBigInt64LE(startTs, off); off += 8; // lastAccrualTs
    off += 16; // cumYesPerShare
    off += 16; // cumNoPerShare
    // v2: no fee_bps (u16)
    const r = 150_000_000n << 48n;
    for (let i = 0; i < 3; i += 1) {
      buf.writeBigUInt64LE(r & ((1n << 64n) - 1n), off);
      buf.writeBigInt64LE(r >> 64n, off + 8);
      off += 16;
    }
    buf.writeBigInt64LE(startTs, off); off += 8; // v2 startTs
    buf.writeBigInt64LE(endTs, off); off += 8;
    ocr2State.toBuffer().copy(buf, off); off += 32;
    buf.writeBigInt64LE(threshold, off); off += 8;
    buf.writeUInt8(8, off); off += 1; // priceDecimals
    buf.writeUInt8(1, off); off += 1; // settleAbove
    buf.writeBigInt64LE(0n, off); off += 8; // settledPrice
    buf.writeBigInt64LE(0n, off); // settledPublishTime
    return buf;
  }

  const v1Buf = makeSyntheticMarketBuffer({
    expiry: 1_800_000_900n,
    endTs: 1_800_000_900n,
    threshold: 95_000_00000000n,
  });
  const v2Buf = makeV2MarketBuffer({
    expiry: 1_800_001_800n,
    startTs: 1_800_000_900n,
    endTs: 1_800_001_800n,
    threshold: 3_200_00000000n,
  });
  assert.equal(v1Buf.length, 409);
  assert.equal(v2Buf.length, 415);

  // 1. db.js
  const dbV1 = dbLib.decodeMarketFull(v1Buf);
  const dbV2 = dbLib.decodeMarketFull(v2Buf);
  assert.equal(dbV1.endTs, 1_800_000_900n);
  assert.equal(dbV1.threshold, 95_000_00000000n);
  assert.equal(dbV1.feeBps, 30);
  assert.equal(dbV1.startTs, null);
  assert.equal(dbV2.endTs, 1_800_001_800n);
  assert.equal(dbV2.threshold, 3_200_00000000n);
  assert.equal(dbV2.startTs, 1_800_000_900n);
  assert.equal(dbV2.feeBps, 0);

  // 2. settle.js
  const sV1 = settleLib.decodeMarket(v1Buf);
  const sV2 = settleLib.decodeMarket(v2Buf);
  assert.equal(sV1.endTs, 1_800_000_900);
  assert.equal(sV1.threshold, 95_000_00000000n);
  assert.equal(sV1.feeBps, 30);
  assert.equal(sV1.startTs, null);
  assert.equal(sV2.endTs, 1_800_001_800);
  assert.equal(sV2.threshold, 3_200_00000000n);
  assert.equal(sV2.startTs, 1_800_000_900);
  assert.equal(sV2.feeBps, 0);

  // 3. sandbox/settle-all.js
  const saV1 = settleAllLib.decodeMarket(v1Buf);
  const saV2 = settleAllLib.decodeMarket(v2Buf);
  assert.equal(saV1.endTs, 1_800_000_900);
  assert.equal(saV1.threshold, 95_000_00000000n);
  assert.equal(saV1.feeBps, 30);
  assert.equal(saV1.startTs, null);
  assert.equal(saV2.endTs, 1_800_001_800);
  assert.equal(saV2.threshold, 3_200_00000000n);
  assert.equal(saV2.startTs, 1_800_000_900);
  assert.equal(saV2.feeBps, 0);

  // 4. sandbox/tick.js
  const tV1 = tickLib.decodeMarket(v1Buf);
  const tV2 = tickLib.decodeMarket(v2Buf);
  assert.equal(tV1.endTs, 1_800_000_900);
  assert.equal(tV1.threshold, 95_000_00000000n);
  assert.equal(tV1.feeBps, 30);
  assert.equal(tV1.startTs, null);
  assert.equal(tV2.endTs, 1_800_001_800);
  assert.equal(tV2.threshold, 3_200_00000000n);
  assert.equal(tV2.startTs, 1_800_000_900);
  assert.equal(tV2.feeBps, 0);

  // 5. Indexer dual-size scan persists v2 start_ts and leaves v1 start_ts NULL
  const dbPath = makeTempDbPath("dual-layout-reindex");
  t.after(() => cleanupDb(dbPath));
  const v1Pk = Keypair.generate().publicKey;
  const v2Pk = Keypair.generate().publicKey;
  let capturedFilters = null;
  const fakeConnection = {
    rpcEndpoint: "https://api.devnet.solana.com",
    async getProgramAccounts(_pid, opts) {
      capturedFilters = opts.filters;
      return [
        { pubkey: v1Pk, account: { data: v1Buf } },
        { pubkey: v2Pk, account: { data: v2Buf } },
      ];
    },
    async getMultipleAccountsInfo(keys) {
      return keys.map(() => null);
    },
  };
  const summary = await indexerLib.reindexFull(fakeConnection, dbLib.DEFAULT_PROGRAM_ID, {
    dbPath,
    withEvidence: false,
  });
  assert.equal(summary.totalScanned, 2);
  assert.equal(summary.upserted, 2);
  assert.ok(!capturedFilters.some((f) => "dataSize" in f), "indexer must not hardcode dataSize=409");

  const db = dbLib.openDb(dbPath, { readonly: true });
  t.after(() => { if (db.open) db.close(); });
  const rowV1 = db.prepare("SELECT start_ts, fee_bps, end_ts FROM markets WHERE address = ?").get(v1Pk.toBase58());
  const rowV2 = db.prepare("SELECT start_ts, fee_bps, end_ts FROM markets WHERE address = ?").get(v2Pk.toBase58());
  assert.equal(rowV1.start_ts, null);
  assert.equal(rowV1.fee_bps, 30);
  assert.equal(rowV1.end_ts, 1_800_000_900);
  assert.equal(rowV2.start_ts, 1_800_000_900);
  assert.equal(rowV2.fee_bps, 0);
  assert.equal(rowV2.end_ts, 1_800_001_800);
});

test("legacy v1 backfill marks only past-48h open v1 markets as windowBurn and keeps claimable=0", (t) => {
  const dbPath = makeTempDbPath("v1-window-burn-backfill");
  const db = dbLib.openDb(dbPath);
  t.after(() => {
    if (db.open) db.close();
    cleanupDb(dbPath);
  });

  const endTs = 1_800_000_000;
  const atWindowEdge = endTs + dbLib.RESOLVE_WINDOW_SEC;
  const pastWindow = atWindowEdge + 1;

  // 1. v1 inside 48h window (even at exact boundary end_ts + 172800) stays open
  const v1Buf = makeSyntheticMarketBuffer({
    expiry: BigInt(endTs),
    endTs: BigInt(endTs),
    statusByte: 0,
    finishTs: 0n,
  });
  const decodedV1 = dbLib.decodeMarketFull(v1Buf);
  const v1Pk = Keypair.generate().publicKey;
  const rowV1Edge = dbLib.buildMarketRow({
    programId: dbLib.DEFAULT_PROGRAM_ID,
    address: v1Pk,
    account: decodedV1,
    tokenProgram: TOKEN_PROGRAM_ID,
    updatedAt: atWindowEdge,
  });
  assert.equal(rowV1Edge.status, "open");

  // 2. v1 past 48h window (now > end_ts + 172800) becomes windowBurn with finish_ts=0
  const rowV1Past = dbLib.buildMarketRow({
    programId: dbLib.DEFAULT_PROGRAM_ID,
    address: v1Pk,
    account: decodedV1,
    tokenProgram: TOKEN_PROGRAM_ID,
    updatedAt: pastWindow,
  });
  assert.equal(rowV1Past.status, "windowBurn");
  assert.equal(rowV1Past.finish_ts, 0);

  // Idempotent on subsequent rescan
  dbLib.upsertMarkets(db, [rowV1Past]);
  dbLib.upsertMarkets(db, [rowV1Past]);
  const savedV1 = db.prepare("SELECT status, finish_ts FROM markets WHERE address = ?").get(v1Pk.toBase58());
  assert.equal(savedV1.status, "windowBurn");
  assert.equal(savedV1.finish_ts, 0);

  // Backfilled v1 void (finish_ts=0) must NOT mark wallet positions claimable
  const walletPk = Keypair.generate().publicKey;
  dbLib.replaceWalletPositions(db, walletPk.toBase58(), dbLib.DEFAULT_PROGRAM_ID, [
    {
      wallet: walletPk.toBase58(),
      market_address: v1Pk.toBase58(),
      program_id: dbLib.DEFAULT_PROGRAM_ID,
      yes_amount: "4000000",
      no_amount: "2000000",
      lp_shares: "1000000",
      pending_yes: "0",
      pending_no: "0",
      claimable_amount: "0",
      can_claim: 0,
      collateral_amount: "0",
      updated_at: pastWindow,
    },
  ]);
  dbLib.refreshClaimableForMarket(db, rowV1Past);
  const pos = db
    .prepare("SELECT claimable_amount, can_claim FROM wallet_positions WHERE wallet = ? AND market_address = ?")
    .get(walletPk.toBase58(), v1Pk.toBase58());
  assert.equal(pos.claimable_amount, "0");
  assert.equal(pos.can_claim, 0);

  // 3. v2 past 48h window NEVER backfills (stays open; on-chain state is sole truth)
  const v2Account = { ...decodedV1, startTs: BigInt(endTs - 900) };
  const rowV2Past = dbLib.buildMarketRow({
    programId: dbLib.DEFAULT_PROGRAM_ID,
    address: Keypair.generate().publicKey,
    account: v2Account,
    tokenProgram: TOKEN_PROGRAM_ID,
    updatedAt: pastWindow,
  });
  assert.equal(rowV2Past.status, "open");
});

test("marketDurationBucket maps non-standard parseable durations to 'other' and unparseable titles to null", () => {
  assert.equal(dbLib.marketDurationBucket("BTC/USD at or above opening price in 2 min?"), "2m");
  assert.equal(dbLib.marketDurationBucket("ETH/USD at or above opening price in 15 min?"), "15m");
  assert.equal(dbLib.marketDurationBucket("SOL/USD at or above opening price in 24 hours?"), "24h");
  assert.equal(dbLib.marketDurationBucket("LINK/USD above 20 in 1 hour?"), "other");
  assert.equal(dbLib.marketDurationBucket("BTC/USD above 95,000 in 10 min?"), "other");
  assert.equal(dbLib.marketDurationBucket("BTC/USD >= 73,479 @ 2026-01-01"), null);
  assert.equal(dbLib.marketDurationBucket("Custom freeform title"), null);
});

test("explorerTxUrl builds explorer.solana.com links with cluster query", () => {
  assert.equal(
    dbLib.explorerTxUrl("sig123", "devnet"),
    "https://explorer.solana.com/tx/sig123?cluster=devnet"
  );
  assert.equal(
    dbLib.explorerTxUrl("sig123", "mainnet-beta"),
    "https://explorer.solana.com/tx/sig123"
  );
  assert.equal(dbLib.explorerTxUrl("sig123", "localnet"), null);
  assert.equal(dbLib.explorerTxUrl("", "devnet"), null);
});
