#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } = require("@solana/spl-token");
const { Connection, PublicKey } = require("@solana/web3.js");
const dbLib = require("./db");
const indexer = require("./index-markets");

const DEFAULT_RPC = "https://api.devnet.solana.com";

function cleanupDb(filePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = filePath + suffix;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }
}

function sampleRows(rows, count) {
  const copy = [...rows];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

async function spotCheckMarkets(connection, programId, db) {
  const openRows = db
    .prepare("SELECT * FROM markets WHERE program_id = ? AND status = 'open' ORDER BY expiry DESC LIMIT 20")
    .all(programId.toBase58());
  const finalizedRows = db
    .prepare("SELECT * FROM markets WHERE program_id = ? AND status != 'open' ORDER BY RANDOM() LIMIT 20")
    .all(programId.toBase58());
  const picks = [
    ...sampleRows(openRows, 3),
    ...sampleRows(finalizedRows, 10 - Math.min(3, openRows.length)),
  ].slice(0, 10);

  const results = [];
  for (const row of picks) {
    const addr = new PublicKey(row.address);
    const info = await connection.getAccountInfo(addr, "confirmed");
    if (!info) throw new Error(`Spot-check market missing on chain: ${row.address}`);
    const account = dbLib.decodeMarketFull(info.data);
    const pdas = dbLib.findMarketPdas(programId, account.id);
    const [vaultInfo, mintInfo] = await connection.getMultipleAccountsInfo(
      [pdas.collateralVault, account.collateralMint],
      "confirmed"
    );
    const tp = mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    let vault = 0n;
    if (vaultInfo) {
      try {
        vault = unpackAccount(pdas.collateralVault, vaultInfo, tp).amount;
      } catch {
        vault = 0n;
      }
    }
    const liveYesPrice = dbLib.computeYesPrice(account);
    const matches = {
      address: row.address,
      statusMatch: row.status === account.status,
      winnerMatch: (row.winner || null) === (account.winner || null),
      thresholdMatch: row.threshold === account.threshold.toString(),
      settledPriceMatch: row.settled_price === account.settledPrice.toString(),
      vaultMatch: row.vault === vault.toString(),
      priceDelta: Math.abs(row.yes_price - liveYesPrice),
    };
    if (
      !matches.statusMatch ||
      !matches.winnerMatch ||
      !matches.thresholdMatch ||
      !matches.settledPriceMatch ||
      (!matches.vaultMatch && account.status !== "open") ||
      matches.priceDelta > 1e-6
    ) {
      throw new Error(`Market mismatch: ${JSON.stringify(matches)}`);
    }
    results.push(matches);
  }
  return results;
}

async function spotCheckEvidence(connection, programId, db) {
  const resolved = db
    .prepare(
      "SELECT * FROM markets WHERE program_id = ? AND status = 'resolved' AND finish_ts > 0 ORDER BY finish_ts DESC LIMIT 25"
    )
    .all(programId.toBase58());
  const picks = sampleRows(resolved, 5);
  const checked = [];

  for (const row of picks) {
    const ev = await indexer.computeEvidenceFromChain(connection, programId, row, {
      cluster: "devnet",
    });
    if (!ev) {
      throw new Error(`Failed to compute evidence for resolved market ${row.address}`);
    }
    dbLib.upsertSettlementEvidence(db, ev);
    const saved = db
      .prepare("SELECT * FROM settlement_evidence WHERE market_address = ?")
      .get(row.address);

    // Independently verify resolve tx and snapshot on chain
    const [tx, snapshotInfo] = await Promise.all([
      connection.getTransaction(saved.resolve_signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
      connection.getAccountInfo(new PublicKey(saved.snapshot_address), "confirmed"),
    ]);
    if (!tx || !tx.meta || tx.meta.err) {
      throw new Error(`Resolve tx invalid for ${row.address}: ${saved.resolve_signature}`);
    }
    const snapshot = snapshotInfo ? dbLib.decodeMarketSnapshot(snapshotInfo.data) : null;
    const ruling = await indexer.fetchRulingForMarket(connection, programId, row);
    const counts = dbLib.witnessCounts(snapshot, ruling.pre, ruling.post);

    const ok =
      saved.resolve_signature === ruling.signature &&
      saved.pre_epoch === ruling.pre.epoch &&
      saved.pre_round === ruling.pre.round &&
      saved.pre_price === ruling.pre.median.toString() &&
      saved.post_epoch === ruling.post.epoch &&
      saved.post_round === ruling.post.round &&
      saved.post_price === ruling.post.median.toString() &&
      saved.settled_price === row.settled_price &&
      (counts ? saved.pre_counter === counts[0] && saved.post_counter === counts[1] : saved.pre_counter === null);
    if (!ok) {
      throw new Error(`Evidence mismatch for ${row.address}`);
    }
    checked.push({
      market: row.address,
      resolveSignature: saved.resolve_signature,
      preId: `${saved.pre_epoch}/${saved.pre_round}`,
      postId: `${saved.post_epoch}/${saved.post_round}`,
      counters: counts,
      hasPrePush: Boolean(saved.pre_push_signature),
      hasPostPush: Boolean(saved.post_push_signature),
    });
  }
  return checked;
}

async function spotCheckWallet(connection, programId, db, dbPath) {
  const creatorRow = db
    .prepare(
      "SELECT creator FROM markets WHERE program_id = ? GROUP BY creator ORDER BY COUNT(*) DESC LIMIT 1"
    )
    .get(programId.toBase58());
  if (!creatorRow) throw new Error("No creator found for wallet spot-check");

  const walletPk = new PublicKey(creatorRow.creator);
  const syncRes = await indexer.syncWalletPositions(connection, programId, walletPk, { dbPath });

  const dbRows = db
    .prepare(
      "SELECT wp.*, m.yes_mint, m.no_mint, m.token_program FROM wallet_positions wp JOIN markets m ON m.address = wp.market_address WHERE wp.wallet = ? AND wp.program_id = ?"
    )
    .all(walletPk.toBase58(), programId.toBase58());

  const [splStandard, spl2022] = await Promise.all([
    connection.getTokenAccountsByOwner(walletPk, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
    connection.getTokenAccountsByOwner(walletPk, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed"),
  ]);
  const liveBalances = new Map();
  for (const grp of [splStandard, spl2022]) {
    for (const { pubkey, account } of grp.value) {
      const t = unpackAccount(pubkey, account, account.owner);
      const mint = t.mint.toBase58();
      liveBalances.set(mint, (liveBalances.get(mint) || 0n) + t.amount);
    }
  }

  const sample = dbRows.slice(0, 10);
  for (const row of sample) {
    const liveYes = liveBalances.get(row.yes_mint) || 0n;
    const liveNo = liveBalances.get(row.no_mint) || 0n;
    if (BigInt(row.yes_amount) !== liveYes || BigInt(row.no_amount) !== liveNo) {
      throw new Error(
        `Wallet position mismatch on ${row.market_address}: db=(${row.yes_amount},${row.no_amount}) chain=(${liveYes},${liveNo})`
      );
    }
  }

  return {
    wallet: walletPk.toBase58(),
    totalIndexedPositions: syncRes.positions,
    checkedSampleCount: sample.length,
  };
}

function resolveRpcUrl() {
  const fromEnv = (process.env.SOLANA_RPC || process.env.RPC_URL || "").trim();
  if (fromEnv) return fromEnv;
  const rpcFile = path.join(__dirname, ".rpc.url");
  if (fs.existsSync(rpcFile)) {
    const line = fs.readFileSync(rpcFile, "utf8").trim();
    if (line) return line;
  }
  return DEFAULT_RPC;
}

function redactRpcUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

async function main() {
  const rpcUrl = resolveRpcUrl();
  const programId = new PublicKey((process.env.PROGRAM_ID || dbLib.DEFAULT_PROGRAM_ID).trim());
  const connection = new Connection(rpcUrl, "confirmed");
  const dbPath = path.join(os.tmpdir(), `veritas-verify-${process.pid}-${Date.now()}.db`);

  cleanupDb(dbPath);
  try {
    const rebuild = await indexer.reindexFull(connection, programId, {
      dbPath,
      withEvidence: false,
    });

    const db = dbLib.openDb(dbPath);
    let marketChecks;
    let evidenceChecks;
    let walletCheck;
    try {
      marketChecks = await spotCheckMarkets(connection, programId, db);
      evidenceChecks = await spotCheckEvidence(connection, programId, db);
      walletCheck = await spotCheckWallet(connection, programId, db, dbPath);
    } finally {
      if (db.open) db.close();
    }

    console.log(
      JSON.stringify(
        {
          rpcEndpoint: redactRpcUrl(rpcUrl),
          programId: programId.toBase58(),
          rebuild,
          marketChecksCount: marketChecks.length,
          marketChecks,
          evidenceChecksCount: evidenceChecks.length,
          evidenceChecks,
          walletCheck,
        },
        null,
        2
      )
    );
  } finally {
    cleanupDb(dbPath);
  }
}

main().catch((err) => {
  console.error("[verify] failed:", err?.stack || err);
  process.exit(1);
});
