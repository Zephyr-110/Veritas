import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { utils } from "@coral-xyz/anchor";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { computePending, decodeLpPosition, i80f48ToAmount } from "./codec";
import { DEFAULT_PROGRAM_ID, DEFAULT_RPC, LP_POSITION_DISCRIMINATOR } from "./constants";
import type { DurationFilter } from "./display";
import { toUi } from "./format";
import type {
  ListSectionFilter,
  MarketsPageResponse,
  SerializedMarket,
  SettlementEvidenceDto,
  WalletPositionItemDto,
  WalletPositionsPageResponse,
  WalletPositionsSummaryDto,
} from "./market-dto";
import { isFinalizedStatus, isVoidedStatus, pendingValueOf } from "./markets";
import { findLpPosition } from "./pdas";
import { fetchTxBatch } from "./resolve";
import { instructionGroups } from "./transaction-history";
import type { FeedKey, MarketStatusName, Side } from "./types";

type MarketDbRow = {
  address: string;
  program_id: string;
  id_hex: string;
  bump: number;
  creator: string;
  title: string;
  feed_key: string | null;
  feed_symbol: string;
  ocr2_state: string;
  collateral_mint: string;
  token_program: string;
  decimals: number;
  yes_mint: string;
  no_mint: string;
  opened_at: number | null;
  expiry: number;
  end_ts: number;
  finish_ts: number;
  duration_sec: number | null;
  duration_bucket: string | null;
  status: string;
  winner: string | null;
  threshold: string;
  price_decimals: number;
  settle_above: number;
  settled_price: string;
  settled_publish_time: number;
  fee_bps: number;
  l_zero: string;
  last_accrual_ts: number;
  cum_yes_per_share: string;
  cum_no_per_share: string;
  reserve_yes: string;
  reserve_no: string;
  total_lp_shares: string;
  yes_pool: string;
  no_pool: string;
  vault: string;
  yes_price: number;
  no_price: number;
  updated_at: number;
};

type EvidenceDbRow = {
  market_address: string;
  program_id: string;
  feed_address: string | null;
  snapshot_address: string;
  resolve_signature: string;
  resolve_tx_url: string | null;
  settled_price: string;
  price_decimals: number;
  winner: string | null;
  status: string;
  pre_epoch: number;
  pre_round: number;
  pre_counter: number | null;
  pre_price: string;
  pre_timestamp: number;
  pre_push_signature: string | null;
  pre_push_tx_url: string | null;
  post_epoch: number;
  post_round: number;
  post_counter: number | null;
  post_price: string;
  post_timestamp: number;
  post_push_signature: string | null;
  post_push_tx_url: string | null;
  missing_count: number | null;
  created_at: number;
};

type WalletPositionJoinRow = MarketDbRow & {
  wp_yes_amount: string;
  wp_no_amount: string;
  wp_lp_shares: string;
  wp_pending_yes: string;
  wp_pending_no: string;
  wp_claimable_amount: string;
  wp_can_claim: number;
  wp_collateral_amount: string;
  wp_updated_at: number;
};

type GlobalDbState = {
  dbPath: string;
  db: Database.Database;
};

const globalScope = globalThis as typeof globalThis & {
  __veritasServerDb?: GlobalDbState;
  __veritasWalletSyncs?: Map<string, Promise<{ syncedAt: number | null }>>;
};

export function resolveServerDbPath(explicitPath?: string): string {
  const chosen = explicitPath?.trim() || process.env.VERITAS_DB_PATH?.trim();
  if (chosen) return path.resolve(chosen);
  const cwd = process.cwd();
  const inAppDir = fs.existsSync(path.join(cwd, "next.config.js"));
  return path.resolve(cwd, inAppDir ? ".." : ".", "data", "veritas.db");
}

function initServerSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      address TEXT PRIMARY KEY,
      program_id TEXT NOT NULL,
      id_hex TEXT NOT NULL,
      bump INTEGER NOT NULL,
      creator TEXT NOT NULL,
      title TEXT NOT NULL,
      feed_key TEXT,
      feed_symbol TEXT NOT NULL,
      ocr2_state TEXT NOT NULL,
      collateral_mint TEXT NOT NULL,
      token_program TEXT NOT NULL,
      decimals INTEGER NOT NULL DEFAULT 6,
      yes_mint TEXT NOT NULL,
      no_mint TEXT NOT NULL,
      opened_at INTEGER,
      expiry INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      finish_ts INTEGER NOT NULL DEFAULT 0,
      duration_sec INTEGER,
      duration_bucket TEXT,
      status TEXT NOT NULL,
      winner TEXT,
      threshold TEXT NOT NULL,
      price_decimals INTEGER NOT NULL DEFAULT 8,
      settle_above INTEGER NOT NULL DEFAULT 1,
      settled_price TEXT NOT NULL DEFAULT '0',
      settled_publish_time INTEGER NOT NULL DEFAULT 0,
      fee_bps INTEGER NOT NULL DEFAULT 30,
      l_zero TEXT NOT NULL DEFAULT '0',
      last_accrual_ts INTEGER NOT NULL DEFAULT 0,
      cum_yes_per_share TEXT NOT NULL DEFAULT '0',
      cum_no_per_share TEXT NOT NULL DEFAULT '0',
      reserve_yes TEXT NOT NULL DEFAULT '0',
      reserve_no TEXT NOT NULL DEFAULT '0',
      total_lp_shares TEXT NOT NULL DEFAULT '0',
      yes_pool TEXT NOT NULL DEFAULT '0',
      no_pool TEXT NOT NULL DEFAULT '0',
      vault TEXT NOT NULL DEFAULT '0',
      yes_price REAL NOT NULL DEFAULT 0.5,
      no_price REAL NOT NULL DEFAULT 0.5,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_markets_status_expiry
      ON markets (program_id, status, expiry DESC);
    CREATE INDEX IF NOT EXISTS idx_markets_status_bucket_expiry
      ON markets (program_id, status, duration_bucket, expiry DESC);
    CREATE INDEX IF NOT EXISTS idx_markets_expiry
      ON markets (program_id, expiry DESC, status);
    CREATE INDEX IF NOT EXISTS idx_markets_bucket_expiry
      ON markets (program_id, duration_bucket, expiry DESC, status);
    CREATE INDEX IF NOT EXISTS idx_markets_yes_mint
      ON markets (yes_mint);
    CREATE INDEX IF NOT EXISTS idx_markets_no_mint
      ON markets (no_mint);
    CREATE INDEX IF NOT EXISTS idx_markets_creator_status_finish
      ON markets (program_id, creator, status, finish_ts);

    CREATE TABLE IF NOT EXISTS settlement_evidence (
      market_address TEXT PRIMARY KEY,
      program_id TEXT NOT NULL,
      feed_address TEXT,
      snapshot_address TEXT NOT NULL,
      resolve_signature TEXT NOT NULL,
      resolve_tx_url TEXT,
      settled_price TEXT NOT NULL,
      price_decimals INTEGER NOT NULL DEFAULT 8,
      winner TEXT,
      status TEXT NOT NULL DEFAULT 'resolved',
      pre_epoch INTEGER NOT NULL,
      pre_round INTEGER NOT NULL,
      pre_counter INTEGER,
      pre_price TEXT NOT NULL,
      pre_timestamp INTEGER NOT NULL,
      pre_push_signature TEXT,
      pre_push_tx_url TEXT,
      post_epoch INTEGER NOT NULL,
      post_round INTEGER NOT NULL,
      post_counter INTEGER,
      post_price TEXT NOT NULL,
      post_timestamp INTEGER NOT NULL,
      post_push_signature TEXT,
      post_push_tx_url TEXT,
      missing_count INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_positions (
      wallet TEXT NOT NULL,
      market_address TEXT NOT NULL,
      program_id TEXT NOT NULL,
      yes_amount TEXT NOT NULL DEFAULT '0',
      no_amount TEXT NOT NULL DEFAULT '0',
      lp_shares TEXT NOT NULL DEFAULT '0',
      pending_yes TEXT NOT NULL DEFAULT '0',
      pending_no TEXT NOT NULL DEFAULT '0',
      claimable_amount TEXT NOT NULL DEFAULT '0',
      can_claim INTEGER NOT NULL DEFAULT 0,
      collateral_amount TEXT NOT NULL DEFAULT '0',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (wallet, market_address)
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_positions_wallet
      ON wallet_positions (program_id, wallet, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_positions_market
      ON wallet_positions (market_address);

    CREATE TABLE IF NOT EXISTS wallet_sync_state (
      wallet TEXT NOT NULL,
      program_id TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (wallet, program_id)
    );
  `);
}

function applyServerPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("cache_size = -8000");
  db.pragma("mmap_size = 0");
  db.pragma("temp_store = FILE");
  db.pragma("foreign_keys = ON");
}

export function getServerDb(explicitPath?: string): Database.Database {
  const targetPath = resolveServerDbPath(explicitPath);
  const existing = globalScope.__veritasServerDb;
  if (existing && existing.dbPath === targetPath && existing.db.open) {
    return existing.db;
  }
  if (existing?.db.open) {
    existing.db.close();
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const db = new Database(targetPath);
  applyServerPragmas(db);
  initServerSchema(db);
  globalScope.__veritasServerDb = { dbPath: targetPath, db };
  return db;
}

export function closeServerDb(): void {
  const existing = globalScope.__veritasServerDb;
  if (existing?.db.open) {
    existing.db.close();
  }
  globalScope.__veritasServerDb = undefined;
}

function serializeMarketRow(row: MarketDbRow): SerializedMarket {
  return {
    address: row.address,
    programId: row.program_id,
    idHex: row.id_hex,
    bump: row.bump,
    creator: row.creator,
    title: row.title,
    feedKey: (row.feed_key as FeedKey | null) ?? null,
    feedSymbol: row.feed_symbol,
    ocr2State: row.ocr2_state,
    collateralMint: row.collateral_mint,
    tokenProgram: row.token_program,
    decimals: row.decimals,
    yesMint: row.yes_mint,
    noMint: row.no_mint,
    openedAt: row.opened_at,
    expiry: row.expiry,
    endTs: row.end_ts,
    finishTs: row.finish_ts,
    durationSec: row.duration_sec,
    durationBucket: (row.duration_bucket as Exclude<DurationFilter, "all"> | null) ?? null,
    status: row.status as MarketStatusName,
    winner: (row.winner as Side | null) ?? null,
    threshold: row.threshold,
    priceDecimals: row.price_decimals,
    settleAbove: Boolean(row.settle_above),
    settledPrice: row.settled_price,
    settledPublishTime: row.settled_publish_time,
    feeBps: row.fee_bps,
    lZero: row.l_zero,
    lastAccrualTs: row.last_accrual_ts,
    cumYesPerShare: row.cum_yes_per_share,
    cumNoPerShare: row.cum_no_per_share,
    reserveYes: row.reserve_yes,
    reserveNo: row.reserve_no,
    totalLpShares: row.total_lp_shares,
    yesPool: row.yes_pool,
    noPool: row.no_pool,
    vault: row.vault,
    yesPrice: row.yes_price,
    noPrice: row.no_price,
    updatedAt: row.updated_at,
  };
}

export function queryMarketsPage(opts: {
  programId?: string;
  section?: ListSectionFilter;
  duration?: DurationFilter;
  page?: number;
  pageSize?: number;
  nowSec?: number;
  dbPath?: string;
}): MarketsPageResponse {
  const db = getServerDb(opts.dbPath);
  const programId = opts.programId?.trim() || DEFAULT_PROGRAM_ID;
  const section: ListSectionFilter = opts.section ?? "all";
  const duration: DurationFilter = opts.duration ?? "all";
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 30)));
  const offset = (page - 1) * pageSize;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  const conditions = ["program_id = ?"];
  const params: unknown[] = [programId];

  if (duration !== "all") {
    conditions.push("duration_bucket = ?");
    params.push(duration);
  }

  let orderBy = "expiry DESC";
  if (section === "live") {
    conditions.push("status = 'open'");
    conditions.push("expiry > ?");
    params.push(nowSec);
    orderBy = "expiry ASC";
  } else if (section === "ended") {
    conditions.push("(status != 'open' OR expiry <= ?)");
    params.push(nowSec);
    orderBy = "expiry DESC";
  }

  const whereSql = conditions.join(" AND ");
  const countRow = db
    .prepare<unknown[], { cnt: number }>(`SELECT COUNT(*) AS cnt FROM markets WHERE ${whereSql}`)
    .get(...params);
  const total = countRow?.cnt ?? 0;

  const rows = db
    .prepare<unknown[], MarketDbRow>(
      `SELECT * FROM markets WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  const maxUpdatedRow = db
    .prepare<[string], { max_updated: number | null }>(
      "SELECT MAX(updated_at) AS max_updated FROM markets WHERE program_id = ?"
    )
    .get(programId);

  const items = rows.map(serializeMarketRow);
  return {
    items,
    total,
    page,
    pageSize,
    hasMore: offset + items.length < total,
    indexedAt: maxUpdatedRow?.max_updated ?? null,
    source: "sqlite",
  };
}

export function querySettlementEvidence(
  marketAddress: string,
  programId = DEFAULT_PROGRAM_ID,
  dbPath?: string
): SettlementEvidenceDto | null {
  const db = getServerDb(dbPath);
  const row = db
    .prepare<[string, string], EvidenceDbRow>(
      "SELECT * FROM settlement_evidence WHERE market_address = ? AND program_id = ? LIMIT 1"
    )
    .get(marketAddress, programId);
  if (!row) return null;
  return {
    marketAddress: row.market_address,
    programId: row.program_id,
    feedAddress: row.feed_address,
    snapshotAddress: row.snapshot_address,
    resolveSignature: row.resolve_signature,
    resolveTxUrl: row.resolve_tx_url,
    settledPrice: row.settled_price,
    priceDecimals: row.price_decimals,
    winner: (row.winner as Side | null) ?? null,
    status: row.status as MarketStatusName,
    preEpoch: row.pre_epoch,
    preRound: row.pre_round,
    preCounter: row.pre_counter,
    prePrice: row.pre_price,
    preTimestamp: row.pre_timestamp,
    prePushSignature: row.pre_push_signature,
    prePushTxUrl: row.pre_push_tx_url,
    postEpoch: row.post_epoch,
    postRound: row.post_round,
    postCounter: row.post_counter,
    postPrice: row.post_price,
    postTimestamp: row.post_timestamp,
    postPushSignature: row.post_push_signature,
    postPushTxUrl: row.post_push_tx_url,
    missingCount: row.missing_count,
    createdAt: row.created_at,
  };
}

function claimableOfRow(
  status: MarketStatusName,
  winner: Side | null,
  yes: bigint,
  no: bigint
): bigint {
  if (status === "resolved") {
    return winner === "yes" ? yes : winner === "no" ? no : 0n;
  }
  if (isVoidedStatus(status)) {
    return yes > 1n || no > 1n ? (yes + no) / 2n : 0n;
  }
  return 0n;
}

async function resolveUnknownLpMarket(
  connection: Connection,
  programId: PublicKey,
  lpPda: PublicKey
): Promise<string | null> {
  try {
    const sigs = await connection.getSignaturesForAddress(lpPda, { limit: 10 }, "confirmed");
    const valid = sigs.filter((s) => !s.err).map((s) => s.signature);
    if (!valid.length) return null;
    const txs = await fetchTxBatch(connection, valid.slice(0, 4));
    for (const tx of txs) {
      if (!tx) continue;
      for (const ix of instructionGroups(tx).flat()) {
        if (
          ix.program.equals(programId) &&
          ix.accounts.some((acc) => acc.equals(lpPda)) &&
          ix.accounts[1]
        ) {
          return ix.accounts[1].toBase58();
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function syncWalletPositionsOnDemand(opts: {
  wallet: string;
  programId?: string;
  rpcUrl?: string;
  forceRefresh?: boolean;
  ttlSec?: number;
  dbPath?: string;
}): Promise<{ syncedAt: number | null }> {
  const programId = opts.programId?.trim() || DEFAULT_PROGRAM_ID;
  const db = getServerDb(opts.dbPath);
  const existingSync = db
    .prepare<[string, string], { synced_at: number }>(
      "SELECT synced_at FROM wallet_sync_state WHERE wallet = ? AND program_id = ?"
    )
    .get(opts.wallet, programId);

  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = opts.ttlSec ?? 30;
  if (process.env.VERITAS_DISABLE_ON_DEMAND_SYNC === "1") {
    return { syncedAt: existingSync?.synced_at ?? null };
  }
  if (!opts.forceRefresh && existingSync && nowSec - existingSync.synced_at < ttlSec) {
    return { syncedAt: existingSync.synced_at };
  }

  if (!globalScope.__veritasWalletSyncs) {
    globalScope.__veritasWalletSyncs = new Map();
  }
  const syncKey = `${opts.dbPath ?? "default"}:${programId}:${opts.wallet}`;
  const inFlight = globalScope.__veritasWalletSyncs.get(syncKey);
  if (inFlight) return inFlight;

  const task = (async () => {
    try {
      const rpcUrl = opts.rpcUrl?.trim() || process.env.SOLANA_RPC || DEFAULT_RPC;
      const connection = new Connection(rpcUrl, "confirmed");
      const pid = new PublicKey(programId);
      const walletPk = new PublicKey(opts.wallet);

      const tpRows = db
        .prepare<[string], { token_program: string }>(
          "SELECT DISTINCT token_program FROM markets WHERE program_id = ?"
        )
        .all(programId);
      const tokenPrograms = tpRows.length
        ? tpRows.map((r) => new PublicKey(r.token_program))
        : [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

      const [tokenGroups, lpRows] = await Promise.all([
        Promise.all(
          tokenPrograms.map((tp) =>
            connection.getTokenAccountsByOwner(walletPk, { programId: tp }, "confirmed")
          )
        ),
        connection.getProgramAccounts(pid, {
          commitment: "confirmed",
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: utils.bytes.bs58.encode(Buffer.from(LP_POSITION_DISCRIMINATOR)),
              },
            },
            { memcmp: { offset: 8, bytes: walletPk.toBase58() } },
          ],
        }),
      ]);

      const balancesByMint = new Map<string, bigint>();
      for (const group of tokenGroups) {
        for (const { pubkey, account } of group.value) {
          try {
            const token = unpackAccount(pubkey, account, account.owner);
            const mint = token.mint.toBase58();
            balancesByMint.set(mint, (balancesByMint.get(mint) ?? 0n) + token.amount);
          } catch {
            // ignore malformed token account
          }
        }
      }

      const nonZeroMints = Array.from(balancesByMint.entries())
        .filter(([, amt]) => amt > 0n)
        .map(([mint]) => mint);

      const matchedMarkets = new Map<string, MarketDbRow>();
      for (let i = 0; i < nonZeroMints.length; i += 200) {
        const chunk = nonZeroMints.slice(i, i + 200);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db
          .prepare<unknown[], MarketDbRow>(
            `SELECT * FROM markets WHERE program_id = ? AND (yes_mint IN (${placeholders}) OR no_mint IN (${placeholders}))`
          )
          .all(programId, ...chunk, ...chunk);
        for (const row of rows) {
          matchedMarkets.set(row.address, row);
        }
      }

      const decodedLpByPda = new Map<
        string,
        ReturnType<typeof decodeLpPosition>
      >();
      for (const row of lpRows) {
        try {
          const decoded = decodeLpPosition(Buffer.from(row.account.data));
          if (decoded.shares > 0n) {
            decodedLpByPda.set(row.pubkey.toBase58(), decoded);
          }
        } catch {
          // skip undecodable LP account
        }
      }

      const lpByMarket = new Map<string, ReturnType<typeof decodeLpPosition>>();
      if (decodedLpByPda.size > 0) {
        const candidateRows = db
          .prepare<[string, string, string, string], MarketDbRow>(`
            SELECT * FROM markets
            WHERE program_id = ?
              AND (
                address IN (SELECT market_address FROM wallet_positions WHERE wallet = ? AND program_id = ?)
                OR creator = ?
                OR status = 'open'
              )
            LIMIT 250
          `)
          .all(programId, opts.wallet, programId, opts.wallet);

        const allCandidates = new Map<string, MarketDbRow>(matchedMarkets);
        for (const row of candidateRows) allCandidates.set(row.address, row);

        for (const marketRow of allCandidates.values()) {
          const [lpPda] = findLpPosition(pid, new PublicKey(marketRow.address), walletPk);
          const pdaStr = lpPda.toBase58();
          const lp = decodedLpByPda.get(pdaStr);
          if (lp) {
            matchedMarkets.set(marketRow.address, marketRow);
            lpByMarket.set(marketRow.address, lp);
            decodedLpByPda.delete(pdaStr);
          }
        }

        for (const [pdaStr, lp] of decodedLpByPda.entries()) {
          const marketAddr = await resolveUnknownLpMarket(connection, pid, new PublicKey(pdaStr));
          if (!marketAddr) continue;
          const marketRow = db
            .prepare<[string, string], MarketDbRow>(
              "SELECT * FROM markets WHERE address = ? AND program_id = ?"
            )
            .get(marketAddr, programId);
          if (marketRow) {
            matchedMarkets.set(marketRow.address, marketRow);
            lpByMarket.set(marketRow.address, lp);
          }
        }
      }

      const syncedAt = Math.floor(Date.now() / 1000);
      const posRows: Array<{
        wallet: string;
        market_address: string;
        program_id: string;
        yes_amount: string;
        no_amount: string;
        lp_shares: string;
        pending_yes: string;
        pending_no: string;
        claimable_amount: string;
        can_claim: number;
        collateral_amount: string;
        updated_at: number;
      }> = [];

      for (const marketRow of matchedMarkets.values()) {
        const yes = balancesByMint.get(marketRow.yes_mint) ?? 0n;
        const no = balancesByMint.get(marketRow.no_mint) ?? 0n;
        const lp = lpByMarket.get(marketRow.address);
        const lpShares = lp ? i80f48ToAmount(lp.shares) : 0n;
        const pending = lp
          ? computePending(
              lp.shares,
              lp.checkpointYes,
              lp.checkpointNo,
              BigInt(marketRow.cum_yes_per_share),
              BigInt(marketRow.cum_no_per_share)
            )
          : { yes: 0n, no: 0n };
        if (
          yes === 0n &&
          no === 0n &&
          lpShares === 0n &&
          pending.yes === 0n &&
          pending.no === 0n
        ) {
          continue;
        }
        const status = marketRow.status as MarketStatusName;
        const winner = (marketRow.winner as Side | null) ?? null;
        const claimable = claimableOfRow(status, winner, yes, no);
        const canClaim =
          isFinalizedStatus(status) &&
          (claimable > 0n || lpShares > 0n || pending.yes > 0n || pending.no > 0n)
            ? 1
            : 0;
        const collateral = balancesByMint.get(marketRow.collateral_mint) ?? 0n;

        posRows.push({
          wallet: opts.wallet,
          market_address: marketRow.address,
          program_id: programId,
          yes_amount: yes.toString(),
          no_amount: no.toString(),
          lp_shares: lpShares.toString(),
          pending_yes: pending.yes.toString(),
          pending_no: pending.no.toString(),
          claimable_amount: claimable.toString(),
          can_claim: canClaim,
          collateral_amount: collateral.toString(),
          updated_at: syncedAt,
        });
      }

      const deleteStmt = db.prepare(
        "DELETE FROM wallet_positions WHERE wallet = ? AND program_id = ?"
      );
      const insertStmt = db.prepare(`
        INSERT INTO wallet_positions (
          wallet, market_address, program_id, yes_amount, no_amount, lp_shares,
          pending_yes, pending_no, claimable_amount, can_claim, collateral_amount, updated_at
        ) VALUES (
          @wallet, @market_address, @program_id, @yes_amount, @no_amount, @lp_shares,
          @pending_yes, @pending_no, @claimable_amount, @can_claim, @collateral_amount, @updated_at
        )
      `);
      const syncStmt = db.prepare(`
        INSERT INTO wallet_sync_state (wallet, program_id, synced_at)
        VALUES (?, ?, ?)
        ON CONFLICT(wallet, program_id) DO UPDATE SET synced_at = excluded.synced_at
      `);
      const writeTx = db.transaction(() => {
        deleteStmt.run(opts.wallet, programId);
        for (const r of posRows) insertStmt.run(r);
        syncStmt.run(opts.wallet, programId, syncedAt);
      });
      writeTx();

      return { syncedAt };
    } catch {
      return { syncedAt: existingSync?.synced_at ?? null };
    } finally {
      globalScope.__veritasWalletSyncs?.delete(syncKey);
    }
  })();

  globalScope.__veritasWalletSyncs.set(syncKey, task);
  return task;
}

export function queryWalletPositionsPage(opts: {
  wallet: string;
  programId?: string;
  page?: number;
  pageSize?: number;
  dbPath?: string;
}): WalletPositionsPageResponse {
  const db = getServerDb(opts.dbPath);
  const programId = opts.programId?.trim() || DEFAULT_PROGRAM_ID;
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 30)));
  const offset = (page - 1) * pageSize;

  const summaryRows = db
    .prepare<
      [string, string],
      {
        yes_amount: string;
        no_amount: string;
        lp_shares: string;
        pending_yes: string;
        pending_no: string;
        claimable_amount: string;
        status: string;
        winner: string | null;
        decimals: number;
      }
    >(`
      SELECT
        wp.yes_amount,
        wp.no_amount,
        wp.lp_shares,
        wp.pending_yes,
        wp.pending_no,
        wp.claimable_amount,
        m.status,
        m.winner,
        m.decimals
      FROM wallet_positions wp
      INNER JOIN markets m ON m.address = wp.market_address
      WHERE wp.wallet = ? AND wp.program_id = ?
    `)
    .all(opts.wallet, programId);

  const summary: WalletPositionsSummaryDto = {
    totalMarkets: summaryRows.length,
    sumYes: 0,
    sumNo: 0,
    sumPending: 0,
    claimCount: 0,
    claimTotal: 0,
    lpUnclaimed: false,
  };

  for (const r of summaryRows) {
    const yes = BigInt(r.yes_amount);
    const no = BigInt(r.no_amount);
    const lpShares = BigInt(r.lp_shares);
    const pendingYes = BigInt(r.pending_yes);
    const pendingNo = BigInt(r.pending_no);
    const status = r.status as MarketStatusName;
    const winner = (r.winner as Side | null) ?? null;

    summary.sumYes += Number(toUi(yes, r.decimals, 2));
    summary.sumNo += Number(toUi(no, r.decimals, 2));
    summary.sumPending += Number(
      toUi(pendingValueOf({ status, winner }, { pendingYes, pendingNo }), r.decimals, 4)
    );
    if (isFinalizedStatus(status)) {
      const claimable = claimableOfRow(status, winner, yes, no);
      if (claimable > 0n) {
        summary.claimCount += 1;
        summary.claimTotal += Number(toUi(claimable, r.decimals, 2));
      }
      if (lpShares > 0n || pendingYes > 0n || pendingNo > 0n) {
        summary.lpUnclaimed = true;
      }
    }
  }

  const pageRows = db
    .prepare<[string, string, number, number], WalletPositionJoinRow>(`
      SELECT
        m.*,
        wp.yes_amount AS wp_yes_amount,
        wp.no_amount AS wp_no_amount,
        wp.lp_shares AS wp_lp_shares,
        wp.pending_yes AS wp_pending_yes,
        wp.pending_no AS wp_pending_no,
        wp.claimable_amount AS wp_claimable_amount,
        wp.can_claim AS wp_can_claim,
        wp.collateral_amount AS wp_collateral_amount,
        wp.updated_at AS wp_updated_at
      FROM wallet_positions wp
      INNER JOIN markets m ON m.address = wp.market_address
      WHERE wp.wallet = ? AND wp.program_id = ?
      ORDER BY wp.can_claim DESC, m.expiry DESC
      LIMIT ? OFFSET ?
    `)
    .all(opts.wallet, programId, pageSize, offset);

  const syncRow = db
    .prepare<[string, string], { synced_at: number }>(
      "SELECT synced_at FROM wallet_sync_state WHERE wallet = ? AND program_id = ?"
    )
    .get(opts.wallet, programId);

  const items: WalletPositionItemDto[] = pageRows.map((row) => ({
    market: serializeMarketRow(row),
    yes: row.wp_yes_amount,
    no: row.wp_no_amount,
    lpShares: row.wp_lp_shares,
    pendingYes: row.wp_pending_yes,
    pendingNo: row.wp_pending_no,
    claimableAmount: row.wp_claimable_amount,
    canClaim: Boolean(row.wp_can_claim),
    collateral: row.wp_collateral_amount,
    updatedAt: row.wp_updated_at,
  }));

  return {
    items,
    summary,
    total: summaryRows.length,
    page,
    pageSize,
    hasMore: offset + items.length < summaryRows.length,
    syncedAt: syncRow?.synced_at ?? null,
    source: "sqlite",
  };
}
