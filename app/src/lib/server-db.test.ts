// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DEFAULT_PROGRAM_ID, MARKET_SNAPSHOT_DISCRIMINATOR } from "@/lib/constants";
import { FEEDS } from "@/lib/feeds";

const fetchRulingSpy = vi.hoisted(() => vi.fn());
const findPushSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ruling-evidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ruling-evidence")>();
  return {
    ...actual,
    fetchRuling: fetchRulingSpy,
    findPushSignatures: findPushSpy,
  };
});

import {
  backfillExpiredV1Markets,
  clearEvidenceHealStateForTests,
  closeServerDb,
  deriveIndexedMarketStatus,
  getServerDb,
  healSettlementEvidenceOnDemand,
  queryMarketsPage,
  querySettlementEvidence,
  queryWalletPositionsPage,
  syncWalletPositionsOnDemand,
  upsertSettlementEvidence,
} from "@/lib/server-db";
import { GET as getMarketsApi } from "@/app/api/markets/route";
import { GET as getEvidenceApi } from "@/app/api/evidence/[address]/route";
import { GET as getPositionsApi } from "@/app/api/positions/route";

function tempDbPath(name: string): string {
  return path.join(
    os.tmpdir(),
    `veritas-server-db-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

function cleanupDb(filePath: string) {
  closeServerDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = filePath + suffix;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore transient file lock
      }
    }
  }
}

function seedMarkets(dbPath: string, totalRows: number, nowSec: number) {
  const db = getServerDb(dbPath);
  const insert = db.prepare(`
    INSERT INTO markets (
      address, program_id, id_hex, bump, creator, title, feed_key, feed_symbol,
      ocr2_state, collateral_mint, token_program, decimals, yes_mint, no_mint,
      opened_at, expiry, end_ts, finish_ts, duration_sec, duration_bucket,
      status, winner, threshold, price_decimals, settle_above, settled_price,
      settled_publish_time, fee_bps, l_zero, last_accrual_ts, cum_yes_per_share,
      cum_no_per_share, reserve_yes, reserve_no, total_lp_shares, yes_pool,
      no_pool, vault, yes_price, no_price, updated_at
    ) VALUES (
      @address, @program_id, @id_hex, 254, @creator, @title, 'btc', 'BTC/USD',
      @ocr2_state, @collateral_mint, @token_program, 6, @yes_mint, @no_mint,
      @opened_at, @expiry, @expiry, @finish_ts, @duration_sec, @duration_bucket,
      @status, @winner, '9500000000000', 8, 1, @settled_price,
      @settled_publish_time, 30, '0', 0, '0',
      '0', '150000000', '150000000', '150000000', '150000000',
      '150000000', '152000000', 0.5, 0.5, @updated_at
    )
  `);
  const creator = Keypair.generate().publicKey.toBase58();
  const collateralMint = Keypair.generate().publicKey.toBase58();
  const buckets = [
    { sec: 120, bucket: "2m", title: "BTC/USD at or above opening price in 2 min?" },
    { sec: 900, bucket: "15m", title: "BTC/USD at or above opening price in 15 min?" },
    { sec: 86_400, bucket: "24h", title: "BTC/USD at or above opening price in 24 hours?" },
  ];
  const addresses: string[] = [];

  const run = db.transaction(() => {
    for (let i = 0; i < totalRows; i += 1) {
      const addr = Keypair.generate().publicKey.toBase58();
      addresses.push(addr);
      const isLive = i < 12;
      const spec = buckets[i % buckets.length];
      const expiry = isLive ? nowSec + (i + 1) * 60 : nowSec - (i + 1) * 60;
      insert.run({
        address: addr,
        program_id: DEFAULT_PROGRAM_ID,
        id_hex: i.toString(16).padStart(32, "0"),
        creator,
        title: spec.title,
        ocr2_state: FEEDS[0].state,
        collateral_mint: collateralMint,
        token_program: TOKEN_PROGRAM_ID.toBase58(),
        yes_mint: Keypair.generate().publicKey.toBase58(),
        no_mint: Keypair.generate().publicKey.toBase58(),
        opened_at: expiry - spec.sec,
        expiry,
        finish_ts: isLive ? 0 : expiry + 4,
        duration_sec: spec.sec,
        duration_bucket: spec.bucket,
        status: isLive ? "open" : "resolved",
        winner: isLive ? null : i % 2 === 0 ? "yes" : "no",
        settled_price: isLive ? "0" : "9600000000000",
        settled_publish_time: isLive ? 0 : expiry + 1,
        updated_at: nowSec,
      });
    }
  });
  run();
  return addresses;
}

describe("server-db & API routes", () => {
  let dbPath = "";
  const prevEnv = process.env.VERITAS_DB_PATH;
  const prevSyncEnv = process.env.VERITAS_DISABLE_ON_DEMAND_SYNC;

  beforeEach(() => {
    dbPath = tempDbPath("suite");
    process.env.VERITAS_DB_PATH = dbPath;
    process.env.VERITAS_DISABLE_ON_DEMAND_SYNC = "1";
    clearEvidenceHealStateForTests();
    fetchRulingSpy.mockReset();
    findPushSpy.mockReset();
  });

  afterEach(() => {
    clearEvidenceHealStateForTests();
    cleanupDb(dbPath);
    if (prevEnv === undefined) delete process.env.VERITAS_DB_PATH;
    else process.env.VERITAS_DB_PATH = prevEnv;
    if (prevSyncEnv === undefined) delete process.env.VERITAS_DISABLE_ON_DEMAND_SYNC;
    else process.env.VERITAS_DISABLE_ON_DEMAND_SYNC = prevSyncEnv;
  });

  it("applies WAL + memory-capped pragmas and uses indexes on paginated queries", () => {
    const nowSec = 1_800_000_000;
    seedMarkets(dbPath, 550, nowSec);
    const db = getServerDb(dbPath);

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("cache_size", { simple: true })).toBe(-8000);
    expect(db.pragma("mmap_size", { simple: true })).toBe(0);

    const livePage = queryMarketsPage({
      programId: DEFAULT_PROGRAM_ID,
      section: "live",
      duration: "all",
      page: 1,
      pageSize: 20,
      nowSec,
      dbPath,
    });
    expect(livePage.items).toHaveLength(12);
    expect(livePage.total).toBe(12);
    expect(livePage.hasMore).toBe(false);
    expect(livePage.items[0].expiry).toBeLessThan(livePage.items[1].expiry);

    const endedPage1 = queryMarketsPage({
      programId: DEFAULT_PROGRAM_ID,
      section: "ended",
      duration: "all",
      page: 1,
      pageSize: 30,
      nowSec,
      dbPath,
    });
    expect(endedPage1.items).toHaveLength(30);
    expect(endedPage1.total).toBe(538);
    expect(endedPage1.hasMore).toBe(true);
    expect(endedPage1.items[0].expiry).toBeGreaterThan(endedPage1.items[1].expiry);

    const ended15m = queryMarketsPage({
      programId: DEFAULT_PROGRAM_ID,
      section: "ended",
      duration: "15m",
      page: 1,
      pageSize: 15,
      nowSec,
      dbPath,
    });
    expect(ended15m.items).toHaveLength(15);
    expect(ended15m.items.every((m) => m.durationBucket === "15m")).toBe(true);

    const planLive = db
      .prepare<unknown[], { detail: string }>(
        "EXPLAIN QUERY PLAN SELECT * FROM markets WHERE program_id = ? AND status = 'open' AND expiry > ? ORDER BY expiry ASC LIMIT 20 OFFSET 0"
      )
      .all(DEFAULT_PROGRAM_ID, nowSec)
      .map((r) => r.detail)
      .join(" ");
    expect(planLive).toMatch(/USING INDEX idx_markets_status_expiry/);

    const planEndedCount = db
      .prepare<unknown[], { detail: string }>(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM markets WHERE program_id = ? AND status != 'open'"
      )
      .all(DEFAULT_PROGRAM_ID)
      .map((r) => r.detail)
      .join(" ");
    expect(planEndedCount).toMatch(/USING (COVERING )?INDEX idx_markets_/);
  });

  it("partitions live, unsettled (expired + open), and ended markets mutually exclusively", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const addresses = seedMarkets(dbPath, 18, nowSec);
    const db = getServerDb(dbPath);
    // Mark two markets as expired while still open (awaiting / voidable)
    const expiredOpenA = addresses[12];
    const expiredOpenB = addresses[13];
    db.prepare(
      "UPDATE markets SET status = 'open', winner = NULL, settled_price = '0', settled_publish_time = 0, finish_ts = 0 WHERE address IN (?, ?)"
    ).run(expiredOpenA, expiredOpenB);

    const live = queryMarketsPage({ programId: DEFAULT_PROGRAM_ID, section: "live", nowSec, pageSize: 50, dbPath });
    const unsettled = queryMarketsPage({ programId: DEFAULT_PROGRAM_ID, section: "unsettled", nowSec, pageSize: 50, dbPath });
    const ended = queryMarketsPage({ programId: DEFAULT_PROGRAM_ID, section: "ended", nowSec, pageSize: 50, dbPath });
    const all = queryMarketsPage({ programId: DEFAULT_PROGRAM_ID, section: "all", nowSec, pageSize: 50, dbPath });

    expect(live.total).toBe(12);
    expect(unsettled.total).toBe(2);
    expect(ended.total).toBe(4);
    expect(live.total + unsettled.total + ended.total).toBe(all.total);

    const liveIds = new Set(live.items.map((m) => m.address));
    const unsettledIds = new Set(unsettled.items.map((m) => m.address));
    const endedIds = new Set(ended.items.map((m) => m.address));
    expect(unsettledIds.has(expiredOpenA)).toBe(true);
    expect(unsettledIds.has(expiredOpenB)).toBe(true);
    for (const id of unsettledIds) {
      expect(liveIds.has(id)).toBe(false);
      expect(endedIds.has(id)).toBe(false);
    }

    const res = await getMarketsApi(
      new Request(`http://localhost/api/markets?programId=${DEFAULT_PROGRAM_ID}&section=unsettled&page=1&pageSize=30`)
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items.map((m: { address: string }) => m.address).sort()).toEqual(
      [expiredOpenA, expiredOpenB].sort()
    );
  });

  it("queries settlement_evidence and paginated wallet_positions + API handlers", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const addresses = seedMarkets(dbPath, 50, nowSec);
    const db = getServerDb(dbPath);
    const wallet = Keypair.generate().publicKey.toBase58();
    const resolvedMarket = addresses[12];

    db.prepare(`
      INSERT INTO settlement_evidence (
        market_address, program_id, feed_address, snapshot_address,
        resolve_signature, resolve_tx_url, settled_price, price_decimals,
        winner, status, pre_epoch, pre_round, pre_counter, pre_price,
        pre_timestamp, pre_push_signature, pre_push_tx_url,
        post_epoch, post_round, post_counter, post_price,
        post_timestamp, post_push_signature, post_push_tx_url,
        missing_count, created_at
      ) VALUES (
        ?, ?, ?, ?,
        'resolve-sig', 'https://solscan.io/tx/resolve-sig?cluster=devnet', '9600000000000', 8,
        'yes', 'resolved', 100, 1, 10, '9490000000000',
        1799999990, 'push-pre', 'https://solscan.io/tx/push-pre?cluster=devnet',
        100, 2, 11, '9600000000000',
        1799999993, 'push-post', 'https://solscan.io/tx/push-post?cluster=devnet',
        0, ?
      )
    `).run(
      resolvedMarket,
      DEFAULT_PROGRAM_ID,
      FEEDS[0].feed,
      Keypair.generate().publicKey.toBase58(),
      nowSec
    );

    const evidence = querySettlementEvidence(resolvedMarket, DEFAULT_PROGRAM_ID, dbPath);
    expect(evidence?.resolveSignature).toBe("resolve-sig");
    expect(evidence?.missingCount).toBe(0);

    // Seed 35 wallet positions (only i === 12 is claimable; other resolved markets hold losing side)
    const insertPos = db.prepare(`
      INSERT INTO wallet_positions (
        wallet, market_address, program_id, yes_amount, no_amount, lp_shares,
        pending_yes, pending_no, claimable_amount, can_claim, collateral_amount, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?, '25000000', ?)
    `);
    const tx = db.transaction(() => {
      for (let i = 0; i < 35; i += 1) {
        const isClaimable = i === 12;
        const isResolved = i >= 12;
        const holdYes = isClaimable || !isResolved || i % 2 === 1;
        insertPos.run(
          wallet,
          addresses[i],
          DEFAULT_PROGRAM_ID,
          holdYes ? "2000000" : "0",
          holdYes ? "0" : "2000000",
          isClaimable ? "5000000" : "0",
          isClaimable ? "10000" : "0",
          isClaimable ? "2000000" : "0",
          isClaimable ? 1 : 0,
          nowSec
        );
      }
    });
    tx();

    const posPage = queryWalletPositionsPage({
      wallet,
      programId: DEFAULT_PROGRAM_ID,
      page: 1,
      pageSize: 30,
      dbPath,
    });
    expect(posPage.items).toHaveLength(30);
    expect(posPage.total).toBe(35);
    expect(posPage.hasMore).toBe(true);
    expect(posPage.items[0].canClaim).toBe(true);
    expect(posPage.summary.totalMarkets).toBe(35);
    expect(posPage.summary.claimCount).toBe(1);
    expect(posPage.summary.lpUnclaimed).toBe(true);

    // Exercise the 3 Next.js API Route handlers directly
    const mkRes = await getMarketsApi(
      new Request(`http://localhost/api/markets?programId=${DEFAULT_PROGRAM_ID}&section=ended&page=1&pageSize=10`)
    );
    expect(mkRes.status).toBe(200);
    const mkJson = await mkRes.json();
    expect(mkJson.items).toHaveLength(10);
    expect(mkJson.source).toBe("sqlite");

    const evRes = await getEvidenceApi(
      new Request(`http://localhost/api/evidence/${resolvedMarket}?programId=${DEFAULT_PROGRAM_ID}`),
      { params: Promise.resolve({ address: resolvedMarket }) }
    );
    expect(evRes.status).toBe(200);
    const evJson = await evRes.json();
    expect(evJson.found).toBe(true);
    expect(evJson.evidence.resolveSignature).toBe("resolve-sig");

    const posRes = await getPositionsApi(
      new Request(`http://localhost/api/positions?wallet=${wallet}&programId=${DEFAULT_PROGRAM_ID}&page=2&pageSize=30`)
    );
    expect(posRes.status).toBe(200);
    const posJson = await posRes.json();
    expect(posJson.items).toHaveLength(5);
    expect(posJson.hasMore).toBe(false);
  });

  it("self-heals partial settlement evidence with fill-only writeback, zero-RPC fast path, dedup, and honest fallback", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const addresses = seedMarkets(dbPath, 20, nowSec);
    const marketMissingCounters = addresses[12];
    const marketMissingPushes = addresses[13];
    const marketUnwitnessed = addresses[14];
    const snapshotAddr = Keypair.generate().publicKey.toBase58();

    const encodeSnapshot = (
      entries: Array<{ epoch: number; round: number; counter: number; price: bigint; ts: bigint }>
    ) => {
      const buf = Buffer.alloc(12 + entries.length * 33 + 1);
      Buffer.from(MARKET_SNAPSHOT_DISCRIMINATOR).copy(buf, 0);
      buf.writeUInt32LE(entries.length, 8);
      let off = 12;
      for (const e of entries) {
        buf.writeUInt32LE(e.epoch, off); off += 4;
        buf.writeUInt8(e.round, off); off += 1;
        buf.writeUInt32LE(e.counter, off); off += 4;
        buf.writeBigUInt64LE(e.price & ((1n << 64n) - 1n), off);
        buf.writeBigInt64LE(e.price >> 64n, off + 8);
        off += 16;
        buf.writeBigInt64LE(e.ts, off); off += 8;
      }
      buf.writeUInt8(255, off);
      return buf;
    };

    // 1) Partial row: has push signatures, missing counters + missingCount
    upsertSettlementEvidence(
      {
        marketAddress: marketMissingCounters,
        programId: DEFAULT_PROGRAM_ID,
        feedAddress: FEEDS[0].feed,
        snapshotAddress: snapshotAddr,
        resolveSignature: "original-resolve-sig",
        resolveTxUrl: "https://solscan.io/tx/original-resolve-sig?cluster=devnet",
        settledPrice: "9600000000000",
        priceDecimals: 8,
        winner: "yes",
        status: "resolved",
        preEpoch: 100,
        preRound: 1,
        preCounter: null,
        prePrice: "9490000000000",
        preTimestamp: 1_799_999_990,
        prePushSignature: "orig-push-pre",
        prePushTxUrl: "https://solscan.io/tx/orig-push-pre?cluster=devnet",
        postEpoch: 100,
        postRound: 3,
        postCounter: null,
        postPrice: "9600000000000",
        postTimestamp: 1_799_999_993,
        postPushSignature: "orig-push-post",
        postPushTxUrl: "https://solscan.io/tx/orig-push-post?cluster=devnet",
        missingCount: null,
        createdAt: nowSec,
      },
      dbPath
    );

    const getAccountInfoMock = vi.fn(async () => ({
      data: encodeSnapshot([
        { epoch: 100, round: 1, counter: 500, price: 9_490_000_000_000n, ts: 1_799_999_990n },
        { epoch: 100, round: 3, counter: 502, price: 9_600_000_000_000n, ts: 1_799_999_993n },
      ]),
    }));
    const conn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getAccountInfo: getAccountInfoMock,
    } as unknown as Connection;

    const first = await healSettlementEvidenceOnDemand({
      marketAddress: marketMissingCounters,
      programId: DEFAULT_PROGRAM_ID,
      dbPath,
      connectionOverride: conn,
    });
    expect(first.found).toBe(true);
    expect(first.complete).toBe(true);
    expect(first.healed).toBe(true);
    expect(first.evidence?.preCounter).toBe(500);
    expect(first.evidence?.postCounter).toBe(502);
    expect(first.evidence?.missingCount).toBe(1);
    expect(first.evidence?.resolveSignature).toBe("original-resolve-sig");
    expect(getAccountInfoMock).toHaveBeenCalledTimes(1);

    // 2) Second read on complete row uses SQLite fast-path with ZERO RPC calls
    getAccountInfoMock.mockClear();
    const second = await healSettlementEvidenceOnDemand({
      marketAddress: marketMissingCounters,
      programId: DEFAULT_PROGRAM_ID,
      dbPath,
      connectionOverride: conn,
    });
    expect(second.complete).toBe(true);
    expect(second.healed).toBe(false);
    expect(getAccountInfoMock).not.toHaveBeenCalled();

    // 3) Partial row missing push signatures + concurrent deduplication + fill-only preservation
    upsertSettlementEvidence(
      {
        marketAddress: marketMissingPushes,
        programId: DEFAULT_PROGRAM_ID,
        feedAddress: FEEDS[0].feed,
        snapshotAddress: snapshotAddr,
        resolveSignature: "keep-existing-resolve",
        resolveTxUrl: "https://solscan.io/tx/keep-existing-resolve?cluster=devnet",
        settledPrice: "9600000000000",
        priceDecimals: 8,
        winner: "yes",
        status: "resolved",
        preEpoch: 101,
        preRound: 3,
        preCounter: null,
        prePrice: "9490000000000",
        preTimestamp: 1_799_999_990,
        prePushSignature: null,
        prePushTxUrl: null,
        postEpoch: 101,
        postRound: 4,
        postCounter: null,
        postPrice: "9600000000000",
        postTimestamp: 1_799_999_993,
        postPushSignature: "keep-existing-post-push",
        postPushTxUrl: "https://solscan.io/tx/keep-existing-post-push?cluster=devnet",
        missingCount: null,
        createdAt: nowSec,
      },
      dbPath
    );

    const digest = Buffer.alloc(32, 2);
    fetchRulingSpy.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return {
        pre: { configDigest: digest, epoch: 101, round: 3, observationsTimestamp: 1_799_999_990, median: 9_490_000_000_000n, observerCount: 4, raw: Buffer.alloc(288) },
        post: { configDigest: digest, epoch: 101, round: 4, observationsTimestamp: 1_799_999_993, median: 9_600_000_000_000n, observerCount: 4, raw: Buffer.alloc(288) },
        signature: "should-not-overwrite-resolve",
      };
    });
    findPushSpy.mockResolvedValue({ pre: "healed-push-pre", post: "should-not-overwrite-post" });
    const conn2 = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getAccountInfo: vi.fn(async () => ({
        data: encodeSnapshot([
          { epoch: 101, round: 3, counter: 600, price: 9_490_000_000_000n, ts: 1_799_999_990n },
          { epoch: 101, round: 4, counter: 602, price: 9_600_000_000_000n, ts: 1_799_999_993n },
        ]),
      })),
    } as unknown as Connection;

    const [c1, c2] = await Promise.all([
      healSettlementEvidenceOnDemand({
        marketAddress: marketMissingPushes,
        programId: DEFAULT_PROGRAM_ID,
        dbPath,
        connectionOverride: conn2,
      }),
      healSettlementEvidenceOnDemand({
        marketAddress: marketMissingPushes,
        programId: DEFAULT_PROGRAM_ID,
        dbPath,
        connectionOverride: conn2,
      }),
    ]);
    expect(fetchRulingSpy).toHaveBeenCalledTimes(1);
    expect(findPushSpy).toHaveBeenCalledTimes(1);
    expect(c1.evidence?.resolveSignature).toBe("keep-existing-resolve");
    expect(c1.evidence?.prePushSignature).toBe("healed-push-pre");
    expect(c1.evidence?.postPushSignature).toBe("keep-existing-post-push");
    expect(c1.evidence?.preCounter).toBe(600);
    expect(c1.evidence?.postCounter).toBe(602);
    expect(c1.evidence?.missingCount).toBe(1);
    expect(c2.evidence).toEqual(c1.evidence);

    // 4) Non-adjacent unwitnessed snapshot / RPC error degrades honestly without fabricating counters
    upsertSettlementEvidence(
      {
        marketAddress: marketUnwitnessed,
        programId: DEFAULT_PROGRAM_ID,
        feedAddress: FEEDS[0].feed,
        snapshotAddress: snapshotAddr,
        resolveSignature: "unwitnessed-resolve",
        resolveTxUrl: "https://solscan.io/tx/unwitnessed-resolve?cluster=devnet",
        settledPrice: "9600000000000",
        priceDecimals: 8,
        winner: "yes",
        status: "resolved",
        preEpoch: 102,
        preRound: 1,
        preCounter: null,
        prePrice: "9490000000000",
        preTimestamp: 1_799_999_990,
        prePushSignature: "unw-pre",
        prePushTxUrl: "https://solscan.io/tx/unw-pre?cluster=devnet",
        postEpoch: 102,
        postRound: 3,
        postCounter: null,
        postPrice: "9600000000000",
        postTimestamp: 1_799_999_993,
        postPushSignature: "unw-post",
        postPushTxUrl: "https://solscan.io/tx/unw-post?cluster=devnet",
        missingCount: null,
        createdAt: nowSec,
      },
      dbPath
    );
    const connEmpty = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getAccountInfo: vi.fn(async () => null),
    } as unknown as Connection;
    const unw = await healSettlementEvidenceOnDemand({
      marketAddress: marketUnwitnessed,
      programId: DEFAULT_PROGRAM_ID,
      dbPath,
      connectionOverride: connEmpty,
    });
    expect(unw.found).toBe(true);
    expect(unw.complete).toBe(false);
    expect(unw.healed).toBe(false);
    expect(unw.evidence?.preCounter).toBeNull();
    expect(unw.evidence?.missingCount).toBeNull();

    // 5) Layer 1 adjacent resolved market without snapshot counters is complete with ZERO RPC calls
    const marketAdjacent = addresses[15];
    upsertSettlementEvidence(
      {
        marketAddress: marketAdjacent,
        programId: DEFAULT_PROGRAM_ID,
        feedAddress: FEEDS[0].feed,
        snapshotAddress: snapshotAddr,
        resolveSignature: "adjacent-resolve",
        resolveTxUrl: "https://solscan.io/tx/adjacent-resolve?cluster=devnet",
        settledPrice: "9600000000000",
        priceDecimals: 8,
        winner: "yes",
        status: "resolved",
        preEpoch: 102,
        preRound: 3,
        preCounter: null,
        prePrice: "9490000000000",
        preTimestamp: 1_799_999_990,
        prePushSignature: "adj-pre",
        prePushTxUrl: "https://solscan.io/tx/adj-pre?cluster=devnet",
        postEpoch: 102,
        postRound: 4,
        postCounter: null,
        postPrice: "9600000000000",
        postTimestamp: 1_799_999_993,
        postPushSignature: "adj-post",
        postPushTxUrl: "https://solscan.io/tx/adj-post?cluster=devnet",
        missingCount: null,
        createdAt: nowSec,
      },
      dbPath
    );
    const getAccSpy = vi.fn(async () => null);
    const adj = await healSettlementEvidenceOnDemand({
      marketAddress: marketAdjacent,
      programId: DEFAULT_PROGRAM_ID,
      dbPath,
      connectionOverride: {
        rpcEndpoint: "https://api.devnet.solana.com",
        getAccountInfo: getAccSpy,
      } as unknown as Connection,
    });
    expect(adj.found).toBe(true);
    expect(adj.complete).toBe(true);
    expect(adj.healed).toBe(false);
    expect(getAccSpy).not.toHaveBeenCalled();
  });

  it("filters losing and voided shares out of summary sumYes/sumNo and applies per-mint floor on void claimTotal", () => {
    const nowSec = 1_800_000_000;
    const addresses = seedMarkets(dbPath, 16, nowSec);
    const db = getServerDb(dbPath);
    const wallet = Keypair.generate().publicKey.toBase58();

    // addresses[0]: open; addresses[12]: resolved yes; addresses[13]: resolved no; addresses[14]: staleBurn
    const openAddr = addresses[0];
    const resolvedYesAddr = addresses[12];
    const resolvedNoAddr = addresses[13];
    const voidAddr = addresses[14];
    db.prepare("UPDATE markets SET status = 'staleBurn', winner = NULL WHERE address = ?").run(voidAddr);

    const insertPos = db.prepare(`
      INSERT INTO wallet_positions (
        wallet, market_address, program_id, yes_amount, no_amount, lp_shares,
        pending_yes, pending_no, claimable_amount, can_claim, collateral_amount, updated_at
      ) VALUES (?, ?, ?, ?, ?, '0', '0', '0', '0', 0, '0', ?)
    `);
    insertPos.run(wallet, openAddr, DEFAULT_PROGRAM_ID, "4000000", "1000000", nowSec);
    // Winning YES (3) + losing NO (5) -> only YES counts in sumYes, claimable = 3
    insertPos.run(wallet, resolvedYesAddr, DEFAULT_PROGRAM_ID, "3000000", "5000000", nowSec);
    // Losing YES (8) + winning NO (2) -> only NO counts in sumNo, claimable = 2
    insertPos.run(wallet, resolvedNoAddr, DEFAULT_PROGRAM_ID, "8000000", "2000000", nowSec);
    // Voided double-odd: yes=2_000_001, no=2_000_001 -> excluded from sumYes/sumNo, claimable = 1_000_000 + 1_000_000 = 2_000_000
    insertPos.run(wallet, voidAddr, DEFAULT_PROGRAM_ID, "2000001", "2000001", nowSec);

    const page = queryWalletPositionsPage({ wallet, programId: DEFAULT_PROGRAM_ID, dbPath });
    expect(page.summary.totalMarkets).toBe(4);
    expect(page.summary.sumYes).toBe(7); // 4 (open) + 3 (resolved yes win)
    expect(page.summary.sumNo).toBe(3); // 1 (open) + 2 (resolved no win)
    expect(page.summary.claimCount).toBe(3);
    expect(page.summary.claimTotal).toBe(7); // 3 + 2 + 2
  });

  it("allows 1.5s post-tx forceRefresh retry while coalescing sub-second duplicate force refreshes", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_400);
      const wallet = Keypair.generate().publicKey.toBase58();
      const getTokenAccountsByOwner = vi.fn(async () => ({ value: [] }));
      const getProgramAccounts = vi.fn(async () => []);
      const fakeConn = {
        rpcEndpoint: "https://api.devnet.solana.com",
        getTokenAccountsByOwner,
        getProgramAccounts,
      } as unknown as Connection;

      await syncWalletPositionsOnDemand({
        wallet,
        programId: DEFAULT_PROGRAM_ID,
        forceRefresh: true,
        dbPath,
        connectionOverride: fakeConn,
      });
      expect(getProgramAccounts).toHaveBeenCalledTimes(1);

      // Duplicate within 500ms is blocked by the 1s cooldown
      vi.advanceTimersByTime(500);
      await syncWalletPositionsOnDemand({
        wallet,
        programId: DEFAULT_PROGRAM_ID,
        forceRefresh: true,
        dbPath,
        connectionOverride: fakeConn,
      });
      expect(getProgramAccounts).toHaveBeenCalledTimes(1);

      // 1500ms retry (1000ms later, total 1500ms) succeeds even across integer-second boundary
      vi.advanceTimersByTime(1000);
      await syncWalletPositionsOnDemand({
        wallet,
        programId: DEFAULT_PROGRAM_ID,
        forceRefresh: true,
        dbPath,
        connectionOverride: fakeConn,
      });
      expect(getProgramAccounts).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backfills only past-48h open v1 markets to windowBurn, keeps in-window v1 and past-48h v2 open, and excludes backfilled voids from claim summary", () => {
    const endTs = 1_800_000_000;
    const atEdge = endTs + 172_800;
    const pastWindow = atEdge + 1;

    // Pure status derivation checks
    expect(deriveIndexedMarketStatus({ status: "open", startTs: null, endTs }, atEdge)).toBe("open");
    expect(deriveIndexedMarketStatus({ status: "open", startTs: null, endTs }, pastWindow)).toBe("windowBurn");
    expect(deriveIndexedMarketStatus({ status: "open", startTs: endTs - 900, endTs }, pastWindow)).toBe("open");

    const addresses = seedMarkets(dbPath, 3, endTs);
    const db = getServerDb(dbPath);
    const v1InWindow = addresses[0];
    const v1PastWindow = addresses[1];
    const v2PastWindow = addresses[2];

    // Configure exact v1/v2 rows
    db.prepare(
      "UPDATE markets SET status = 'open', winner = NULL, finish_ts = 0, start_ts = NULL, expiry = ?, end_ts = ? WHERE address = ?"
    ).run(pastWindow - 1000, pastWindow - 1000, v1InWindow);
    db.prepare(
      "UPDATE markets SET status = 'open', winner = NULL, finish_ts = 0, start_ts = NULL, expiry = ?, end_ts = ? WHERE address = ?"
    ).run(endTs, endTs, v1PastWindow);
    db.prepare(
      "UPDATE markets SET status = 'open', winner = NULL, finish_ts = 0, start_ts = ?, expiry = ?, end_ts = ? WHERE address = ?"
    ).run(endTs - 900, endTs, endTs, v2PastWindow);

    const changed = backfillExpiredV1Markets({ programId: DEFAULT_PROGRAM_ID, nowSec: pastWindow, dbPath });
    expect(changed).toBe(1);

    const statusOf = (addr: string) =>
      (db.prepare("SELECT status FROM markets WHERE address = ?").get(addr) as { status: string }).status;
    expect(statusOf(v1InWindow)).toBe("open");
    expect(statusOf(v1PastWindow)).toBe("windowBurn");
    expect(statusOf(v2PastWindow)).toBe("open");

    // Wallet holding YES/NO/LP on the backfilled v1 market (finish_ts=0) must NOT show claimable funds
    const wallet = Keypair.generate().publicKey.toBase58();
    db.prepare(`
      INSERT INTO wallet_positions (
        wallet, market_address, program_id, yes_amount, no_amount, lp_shares,
        pending_yes, pending_no, claimable_amount, can_claim, collateral_amount, updated_at
      ) VALUES (?, ?, ?, '4000000', '2000000', '5000000', '0', '0', '0', 0, '0', ?)
    `).run(wallet, v1PastWindow, DEFAULT_PROGRAM_ID, pastWindow);

    const posPage = queryWalletPositionsPage({ wallet, programId: DEFAULT_PROGRAM_ID, dbPath });
    expect(posPage.summary.claimCount).toBe(0);
    expect(posPage.summary.claimTotal).toBe(0);
    expect(posPage.summary.lpUnclaimed).toBe(false);
  });
});
