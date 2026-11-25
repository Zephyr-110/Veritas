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
    resolve_tx_url: "https://solscan.io/tx/sig-resolve-1?cluster=devnet",
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
    post_push_tx_url: "https://solscan.io/tx/sig-post-1?cluster=devnet",
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
    resolve_tx_url: "https://solscan.io/tx/bad",
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
    pre_push_tx_url: "https://solscan.io/tx/sig-pre-1?cluster=devnet",
    post_epoch: 999,
    post_round: 10,
    post_counter: 43,
    post_price: "1",
    post_timestamp: 2,
    post_push_signature: "sig-post-SHOULD-NOT-OVERWRITE",
    post_push_tx_url: "https://solscan.io/tx/bad-post",
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
