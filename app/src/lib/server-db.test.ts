// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DEFAULT_PROGRAM_ID } from "@/lib/constants";
import { FEEDS } from "@/lib/feeds";
import {
  closeServerDb,
  getServerDb,
  queryMarketsPage,
  querySettlementEvidence,
  queryWalletPositionsPage,
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
  });

  afterEach(() => {
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
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM markets WHERE program_id = ? AND (status != 'open' OR expiry <= ?)"
      )
      .all(DEFAULT_PROGRAM_ID, nowSec)
      .map((r) => r.detail)
      .join(" ");
    expect(planEndedCount).toMatch(/USING COVERING INDEX idx_markets_(bucket_)?expiry/);
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
});
