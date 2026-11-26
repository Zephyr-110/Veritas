#!/usr/bin/env node
"use strict";

const path = require("path");
const { utils } = require("@coral-xyz/anchor");
const { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } = require("@solana/spl-token");
const { Connection, PublicKey } = require("@solana/web3.js");
const dbLib = require("./db");

const DEFAULT_RPC = "https://api.devnet.solana.com";
const CHAINLINK_OCR2_PROGRAM_ID = new PublicKey("cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ");
const RESOLVE_DISC = Buffer.from([155, 23, 80, 173, 46, 74, 23, 239]);
const STATUS_OFFSET = 129;
const CONTEXT_LEN = 96;
const REPORT_LEN = 61;
const SIGNATURE_LEN = 65;
const RAW_REPORT_HEADER_LEN = 1 + CONTEXT_LEN + REPORT_LEN;
const TX_BATCH_SIZE = 8;
const MAX_SIGNATURE_PAGES = 20;
const RPC_FETCH_TIMEOUT_MS = 15_000;

function inferCluster(rpcUrl = "") {
  const lower = String(rpcUrl).toLowerCase();
  if (lower.includes("127.0.0.1") || lower.includes("localhost")) return "localnet";
  if (lower.includes("mainnet")) return "mainnet-beta";
  if (lower.includes("testnet")) return "testnet";
  return "devnet";
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function marketDiscriminatorBase58() {
  return utils.bytes.bs58.encode(Buffer.from(dbLib.MARKET_DISCRIMINATOR));
}

function openMarketFilters() {
  return [
    { dataSize: dbLib.MARKET_ACCOUNT_SIZE },
    { memcmp: { offset: 0, bytes: marketDiscriminatorBase58() } },
    { memcmp: { offset: STATUS_OFFSET, bytes: utils.bytes.bs58.encode(Buffer.from([0])) } },
  ];
}

function allMarketFilters() {
  return [
    { dataSize: dbLib.MARKET_ACCOUNT_SIZE },
    { memcmp: { offset: 0, bytes: marketDiscriminatorBase58() } },
  ];
}

function lpByOwnerFilters(ownerPk) {
  return [
    {
      memcmp: {
        offset: 0,
        bytes: utils.bytes.bs58.encode(Buffer.from(dbLib.LP_POSITION_DISCRIMINATOR)),
      },
    },
    { memcmp: { offset: 8, bytes: ownerPk.toBase58() } },
  ];
}

function tokenProgramOf(owner) {
  return owner && owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

function unpackTokenAmount(pubkey, info, tokenProgram) {
  if (!info) return 0n;
  try {
    return unpackAccount(pubkey, info, tokenProgram).amount;
  } catch {
    return 0n;
  }
}

function unpackMintDecimals(pubkey, info, tokenProgram) {
  if (!info) return 6;
  try {
    return unpackMint(pubkey, info, tokenProgram).decimals;
  } catch {
    return 6;
  }
}

async function getMultipleBatched(connection, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed");
    out.push(...chunk);
    if (i + 100 < keys.length) await pause(120);
  }
  return out;
}

function readI128BE(buf, offset) {
  const hi = buf.readBigInt64BE(offset);
  const lo = buf.readBigUInt64BE(offset + 8);
  return (hi << 64n) + lo;
}

function parseOcr2TransmitReport(rawBytes, expectedDigest) {
  const raw = Buffer.from(rawBytes);
  if (raw.length <= RAW_REPORT_HEADER_LEN) return null;
  const sigBytes = raw.length - RAW_REPORT_HEADER_LEN;
  if (sigBytes % SIGNATURE_LEN !== 0) return null;
  const configDigest = Buffer.from(raw.subarray(1, 33));
  if (expectedDigest && !configDigest.equals(expectedDigest)) return null;
  const epoch = raw.readUInt32BE(1 + 59);
  const round = raw[1 + 63];
  const rawReportOffset = 1 + CONTEXT_LEN;
  const observationsTimestamp = raw.readUInt32BE(rawReportOffset);
  const observerCount = raw[rawReportOffset + 4];
  const median = readI128BE(raw, rawReportOffset + 37);
  return { raw, configDigest, epoch, round, observationsTimestamp, observerCount, median };
}

function decodeResolveReports(data) {
  if (data.length < 16 || !data.subarray(0, 8).equals(RESOLVE_DISC)) return null;
  const middle = 12 + data.readUInt32LE(8);
  if (middle + 4 > data.length || middle + 4 + data.readUInt32LE(middle) !== data.length) {
    return null;
  }
  const pre = parseOcr2TransmitReport(data.subarray(12, middle));
  const post = parseOcr2TransmitReport(data.subarray(middle + 4));
  return pre && post && pre.configDigest.equals(post.configDigest) ? { pre, post } : null;
}

function decodeIxData(raw) {
  if (typeof raw === "string") return Buffer.from(utils.bytes.bs58.decode(raw));
  return Buffer.from(raw);
}

function instructionGroups(tx) {
  if (!tx || !tx.meta || tx.meta.err) return [];
  const message = tx.transaction.message;
  const keys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses || undefined,
  });
  const decode = (programIndex, indices, data) => ({
    program: keys.get(programIndex),
    accounts: Array.from(indices, (i) => keys.get(i)),
    data: decodeIxData(data),
  });
  return message.compiledInstructions.map((ix, i) => [
    decode(ix.programIdIndex, ix.accountKeyIndexes, ix.data),
    ...(
      tx.meta.innerInstructions?.find((group) => group.index === i)?.instructions || []
    ).map((inner) => decode(inner.programIdIndex, inner.accounts, inner.data)),
  ]);
}

function extractOcr2Instructions(tx) {
  if (!tx || !tx.meta || tx.meta.err) return [];
  return instructionGroups(tx)
    .flat()
    .filter((ix) => ix.program && ix.program.equals(CHAINLINK_OCR2_PROGRAM_ID))
    .map((ix) => ix.data);
}

async function fetchTxBatch(connection, signatures) {
  if (!signatures.length) return [];
  try {
    return await connection.getTransactions(signatures, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    const out = [];
    for (const sig of signatures) {
      try {
        out.push(
          await connection.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
        );
      } catch {
        out.push(null);
      }
      await pause(120);
    }
    return out;
  }
}

async function fetchRulingForMarket(connection, programId, marketRow) {
  const marketPk = new PublicKey(marketRow.address);
  const ocr2StatePk = new PublicKey(marketRow.ocr2_state);
  const finishTs = Number(marketRow.finish_ts);
  const endTs = Number(marketRow.end_ts);
  const settledPublishTime = Number(marketRow.settled_publish_time);
  const settledPrice = BigInt(marketRow.settled_price);
  let before;

  for (let pageNum = 0; pageNum < MAX_SIGNATURE_PAGES; pageNum += 1) {
    const page = await connection.getSignaturesForAddress(
      marketPk,
      { before, limit: 100 },
      "confirmed"
    );
    const candidates = page
      .filter((s) => !s.err && (s.blockTime == null || Math.abs(s.blockTime - finishTs) <= 30))
      .sort(
        (a, b) =>
          Math.abs((a.blockTime ?? finishTs) - finishTs) -
          Math.abs((b.blockTime ?? finishTs) - finishTs)
      );

    for (let i = 0; i < candidates.length; i += TX_BATCH_SIZE) {
      const sigs = candidates.slice(i, i + TX_BATCH_SIZE).map((c) => c.signature);
      const txs = await fetchTxBatch(connection, sigs);
      const bySig = new Map(
        txs.flatMap((tx) => (tx ? [[tx.transaction.signatures[0], tx]] : []))
      );
      for (const signature of sigs) {
        const tx = bySig.get(signature);
        if (!tx) continue;
        for (const ix of instructionGroups(tx).flat()) {
          if (
            !ix.program ||
            !ix.program.equals(programId) ||
            !ix.accounts[1]?.equals(marketPk) ||
            !ix.accounts[3]?.equals(ocr2StatePk)
          ) {
            continue;
          }
          const pair = decodeResolveReports(ix.data);
          if (
            pair &&
            pair.pre.observationsTimestamp < endTs &&
            pair.post.observationsTimestamp === settledPublishTime &&
            pair.post.median === settledPrice
          ) {
            return { ...pair, signature };
          }
        }
      }
      if (i + TX_BATCH_SIZE < candidates.length) await pause(120);
    }

    const last = page.at(-1);
    if (
      !last ||
      page.length < 100 ||
      (last.blockTime != null && last.blockTime < finishTs - 30)
    ) {
      return null;
    }
    before = last.signature;
  }
  return null;
}

async function findPushSignaturesForRuling(connection, feedPk, ruling) {
  const result = {};
  let before = ruling.signature;
  const from = ruling.pre.observationsTimestamp - 60;
  const until = ruling.post.observationsTimestamp + 60;

  for (let pageNum = 0; pageNum < MAX_SIGNATURE_PAGES; pageNum += 1) {
    const page = await connection.getSignaturesForAddress(
      feedPk,
      { before, limit: 250 },
      "confirmed"
    );
    const candidates = page
      .filter((s) => !s.err && (s.blockTime == null || (s.blockTime >= from && s.blockTime <= until)))
      .sort(
        (a, b) =>
          Math.abs((a.blockTime ?? until) - ruling.post.observationsTimestamp) -
          Math.abs((b.blockTime ?? until) - ruling.post.observationsTimestamp)
      );

    for (let i = 0; i < candidates.length; i += TX_BATCH_SIZE) {
      const sigs = candidates.slice(i, i + TX_BATCH_SIZE).map((c) => c.signature);
      const txs = await fetchTxBatch(connection, sigs);
      const bySig = new Map(
        txs.flatMap((tx) => (tx ? [[tx.transaction.signatures[0], tx]] : []))
      );
      for (const signature of sigs) {
        const tx = bySig.get(signature);
        if (!tx || !tx.meta || tx.meta.err) continue;
        for (const raw of extractOcr2Instructions(tx)) {
          const pushed = parseOcr2TransmitReport(raw, ruling.pre.configDigest);
          if (!pushed) continue;
          for (const side of ["pre", "post"]) {
            const report = ruling[side];
            if (pushed.raw.subarray(1, 158).equals(report.raw.subarray(1, 158))) {
              result[side] = signature;
            }
          }
        }
        if (result.pre && result.post) return result;
      }
      if (i + TX_BATCH_SIZE < candidates.length) await pause(120);
    }

    const last = page.at(-1);
    if (!last || page.length < 250 || (last.blockTime != null && last.blockTime < from)) {
      return result;
    }
    before = last.signature;
  }
  return result;
}

function buildEvidenceRecord({
  programId,
  marketRow,
  snapshotAddress,
  snapshot,
  ruling,
  pushes,
  cluster,
}) {
  const preset = dbLib.feedByState(marketRow.ocr2_state);
  const counts = dbLib.witnessCounts(snapshot, ruling.pre, ruling.post);
  const prePushSig = pushes?.pre || null;
  const postPushSig = pushes?.post || null;

  return {
    market_address: marketRow.address,
    program_id: typeof programId === "string" ? programId : programId.toBase58(),
    feed_address: preset ? preset.feed : null,
    snapshot_address: snapshotAddress,
    resolve_signature: ruling.signature,
    resolve_tx_url: dbLib.explorerTxUrl(ruling.signature, cluster),
    settled_price: String(marketRow.settled_price),
    price_decimals: Number(marketRow.price_decimals ?? 8),
    winner: marketRow.winner ?? null,
    status: marketRow.status,
    pre_epoch: ruling.pre.epoch,
    pre_round: ruling.pre.round,
    pre_counter: counts ? counts[0] : null,
    pre_price: ruling.pre.median.toString(),
    pre_timestamp: ruling.pre.observationsTimestamp,
    pre_push_signature: prePushSig,
    pre_push_tx_url: prePushSig ? dbLib.explorerTxUrl(prePushSig, cluster) : null,
    post_epoch: ruling.post.epoch,
    post_round: ruling.post.round,
    post_counter: counts ? counts[1] : null,
    post_price: ruling.post.median.toString(),
    post_timestamp: ruling.post.observationsTimestamp,
    post_push_signature: postPushSig,
    post_push_tx_url: postPushSig ? dbLib.explorerTxUrl(postPushSig, cluster) : null,
    missing_count: counts ? counts[1] - counts[0] - 1 : null,
    created_at: Math.floor(Date.now() / 1000),
  };
}

async function computeEvidenceFromChain(connection, programId, marketRow, { cluster = "devnet" } = {}) {
  const pid = typeof programId === "string" ? new PublicKey(programId) : programId;
  const ruling = await fetchRulingForMarket(connection, pid, marketRow);
  if (!ruling) return null;

  const idBytes = Buffer.from(marketRow.id_hex, "hex");
  const pdas = dbLib.findMarketPdas(pid, idBytes);
  const preset = dbLib.feedByState(marketRow.ocr2_state);
  const snapshotInfo = await connection.getAccountInfo(pdas.snapshot, "confirmed");
  const snapshot = snapshotInfo ? dbLib.decodeMarketSnapshot(snapshotInfo.data) : null;

  let pushes = {};
  if (preset) {
    pushes = await findPushSignaturesForRuling(connection, new PublicKey(preset.feed), ruling);
  }

  return buildEvidenceRecord({
    programId: pid,
    marketRow,
    snapshotAddress: pdas.snapshot.toBase58(),
    snapshot,
    ruling,
    pushes,
    cluster,
  });
}

async function hydrateMarketRows(connection, programId, decodedList, { mintMetaCache } = {}) {
  if (!decodedList.length) return [];
  const pid = typeof programId === "string" ? new PublicKey(programId) : programId;
  const cache = mintMetaCache || new Map();

  const pdasList = decodedList.map((item) => dbLib.findMarketPdas(pid, item.account.id));
  const missingMints = Array.from(
    new Set(
      decodedList
        .map((item) => item.account.collateralMint.toBase58())
        .filter((m) => !cache.has(m))
    )
  ).map((s) => new PublicKey(s));

  const keys = [];
  const slots = decodedList.map((item, idx) => {
    const pda = pdasList[idx];
    const vaultIdx = keys.length;
    keys.push(pda.collateralVault);
    let yesIdx = -1;
    let noIdx = -1;
    if (item.account.status === "open") {
      yesIdx = keys.length;
      keys.push(pda.yesPool);
      noIdx = keys.length;
      keys.push(pda.noPool);
    }
    return { pda, vaultIdx, yesIdx, noIdx };
  });
  const mintStart = keys.length;
  keys.push(...missingMints);

  const infos = keys.length ? await getMultipleBatched(connection, keys) : [];
  missingMints.forEach((mintPk, idx) => {
    const info = infos[mintStart + idx] || null;
    const tp = info ? tokenProgramOf(info.owner) : TOKEN_PROGRAM_ID;
    const decimals = unpackMintDecimals(mintPk, info, tp);
    cache.set(mintPk.toBase58(), { tokenProgram: tp, decimals });
  });

  const nowSec = Math.floor(Date.now() / 1000);
  return decodedList.map((item, idx) => {
    const slot = slots[idx];
    const mintMeta = cache.get(item.account.collateralMint.toBase58()) || {
      tokenProgram: TOKEN_PROGRAM_ID,
      decimals: 6,
    };
    const tp = mintMeta.tokenProgram;
    return dbLib.buildMarketRow({
      programId: pid,
      address: item.address,
      account: item.account,
      tokenProgram: tp,
      decimals: mintMeta.decimals,
      yesPool: slot.yesIdx >= 0 ? unpackTokenAmount(slot.pda.yesPool, infos[slot.yesIdx], tp) : 0n,
      noPool: slot.noIdx >= 0 ? unpackTokenAmount(slot.pda.noPool, infos[slot.noIdx], tp) : 0n,
      vault: unpackTokenAmount(slot.pda.collateralVault, infos[slot.vaultIdx], tp),
      openedAt: item.openedAt ?? null,
      updatedAt: nowSec,
    });
  });
}

async function backfillMissingEvidence(
  connection,
  programId,
  db,
  { limit = 3, cluster = "devnet" } = {}
) {
  const pidStr = typeof programId === "string" ? programId : programId.toBase58();
  const candidates = dbLib.getResolvedMarketsMissingEvidence(db, pidStr, limit);
  let written = 0;
  for (const marketRow of candidates) {
    try {
      const evidence = await computeEvidenceFromChain(connection, pidStr, marketRow, { cluster });
      if (evidence) {
        dbLib.upsertSettlementEvidence(db, evidence);
        written += 1;
      }
    } catch (err) {
      console.warn(`[index] evidence backfill failed for ${marketRow.address}: ${err.message}`);
    }
  }
  return written;
}

async function syncIncremental(
  connection,
  programId,
  { dbPath, backfillEvidenceLimit = 3, cluster } = {}
) {
  const pid = typeof programId === "string" ? new PublicKey(programId) : programId;
  const pidStr = pid.toBase58();
  const resolvedCluster = cluster || inferCluster(connection.rpcEndpoint);
  const db = dbLib.openDb(dbPath);
  try {
    if (!dbLib.hasIndexedMarkets(db, pidStr)) {
      db.close();
      return reindexFull(connection, pid, {
        dbPath,
        withEvidence: backfillEvidenceLimit > 0,
        evidenceLimit: backfillEvidenceLimit > 0 ? backfillEvidenceLimit : 0,
        cluster: resolvedCluster,
      });
    }

    const openAccounts = await connection.getProgramAccounts(pid, {
      commitment: "confirmed",
      filters: openMarketFilters(),
    });
    const decoded = [];
    const seenOpen = new Set();
    for (const row of openAccounts) {
      try {
        const account = dbLib.decodeMarketFull(row.account.data);
        seenOpen.add(row.pubkey.toBase58());
        decoded.push({ address: row.pubkey, account });
      } catch {
        // skip undecodable layouts
      }
    }

    const dbOpenAddrs = dbLib.getOpenMarketAddresses(db, pidStr);
    const transitionedAddrs = dbOpenAddrs.filter((addr) => !seenOpen.has(addr));
    const missingFromChain = [];

    for (let i = 0; i < transitionedAddrs.length; i += 100) {
      const chunk = transitionedAddrs.slice(i, i + 100);
      const infos = await getMultipleBatched(
        connection,
        chunk.map((a) => new PublicKey(a))
      );
      for (let j = 0; j < chunk.length; j += 1) {
        const info = infos[j];
        if (!info || !info.owner.equals(pid)) {
          missingFromChain.push(chunk[j]);
          continue;
        }
        try {
          const account = dbLib.decodeMarketFull(info.data);
          decoded.push({ address: new PublicKey(chunk[j]), account });
        } catch {
          missingFromChain.push(chunk[j]);
        }
      }
    }

    const rows = await hydrateMarketRows(connection, pid, decoded);
    dbLib.upsertMarkets(db, rows);
    for (const row of rows) {
      if (row.status !== "open") {
        dbLib.refreshClaimableForMarket(db, row);
      }
    }
    if (missingFromChain.length) {
      dbLib.deleteMissingMarkets(db, missingFromChain);
    }

    let evidenceWritten = 0;
    if (backfillEvidenceLimit > 0) {
      evidenceWritten = await backfillMissingEvidence(connection, pid, db, {
        limit: backfillEvidenceLimit,
        cluster: resolvedCluster,
      });
    }

    return {
      upserted: rows.length,
      transitioned: transitionedAddrs.length,
      deleted: missingFromChain.length,
      evidenceWritten,
    };
  } finally {
    if (db.open) db.close();
  }
}

async function reindexFull(
  connection,
  programId,
  { dbPath, withEvidence = true, evidenceLimit = 0, cluster } = {}
) {
  const pid = typeof programId === "string" ? new PublicKey(programId) : programId;
  const resolvedCluster = cluster || inferCluster(connection.rpcEndpoint);
  const db = dbLib.openDb(dbPath);
  const mintMetaCache = new Map();
  try {
    const rawAccounts = await connection.getProgramAccounts(pid, {
      commitment: "confirmed",
      filters: allMarketFilters(),
    });

    let upserted = 0;
    const decodedBatch = [];
    const flushBatch = async () => {
      if (!decodedBatch.length) return;
      const chunk = decodedBatch.splice(0, decodedBatch.length);
      const rows = await hydrateMarketRows(connection, pid, chunk, { mintMetaCache });
      dbLib.upsertMarkets(db, rows);
      for (const row of rows) {
        if (row.status !== "open") {
          dbLib.refreshClaimableForMarket(db, row);
        }
      }
      upserted += rows.length;
    };

    for (const row of rawAccounts) {
      try {
        const account = dbLib.decodeMarketFull(row.account.data);
        decodedBatch.push({ address: row.pubkey, account });
      } catch {
        // skip undecodable layouts
      }
      if (decodedBatch.length >= 100) {
        await flushBatch();
      }
    }
    await flushBatch();

    let evidenceWritten = 0;
    if (withEvidence) {
      evidenceWritten = await backfillMissingEvidence(connection, pid, db, {
        limit: evidenceLimit,
        cluster: resolvedCluster,
      });
    }
    return { totalScanned: rawAccounts.length, upserted, evidenceWritten };
  } finally {
    if (db.open) db.close();
  }
}

async function resolveUnknownLpMarket(connection, programId, lpPda) {
  try {
    const sigs = await connection.getSignaturesForAddress(lpPda, { limit: 10 }, "confirmed");
    const valid = sigs.filter((s) => !s.err).map((s) => s.signature);
    if (!valid.length) return null;
    const txs = await fetchTxBatch(connection, valid.slice(0, 4));
    for (const tx of txs) {
      for (const ix of instructionGroups(tx).flat()) {
        if (
          ix.program &&
          ix.program.equals(programId) &&
          ix.accounts.some((acc) => acc && acc.equals(lpPda)) &&
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

async function syncWalletPositions(connection, programId, walletPk, { dbPath } = {}) {
  const pid = typeof programId === "string" ? new PublicKey(programId) : programId;
  const wallet = typeof walletPk === "string" ? new PublicKey(walletPk) : walletPk;
  const pidStr = pid.toBase58();
  const walletStr = wallet.toBase58();
  const db = dbLib.openDb(dbPath);

  try {
    const tpRows = db
      .prepare("SELECT DISTINCT token_program FROM markets WHERE program_id = ?")
      .all(pidStr);
    const tokenPrograms = tpRows.length
      ? tpRows.map((r) => new PublicKey(r.token_program))
      : [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

    const [tokenGroups, lpRows] = await Promise.all([
      Promise.all(
        tokenPrograms.map((tp) =>
          connection.getTokenAccountsByOwner(wallet, { programId: tp }, "confirmed")
        )
      ),
      connection.getProgramAccounts(pid, {
        commitment: "confirmed",
        filters: lpByOwnerFilters(wallet),
      }),
    ]);

    const balancesByMint = new Map();
    for (const group of tokenGroups) {
      for (const { pubkey, account } of group.value) {
        try {
          const token = unpackAccount(pubkey, account, account.owner);
          const mint = token.mint.toBase58();
          balancesByMint.set(mint, (balancesByMint.get(mint) || 0n) + token.amount);
        } catch {
          // ignore malformed token account
        }
      }
    }

    const nonZeroMints = Array.from(balancesByMint.entries())
      .filter(([, amt]) => amt > 0n)
      .map(([mint]) => mint);

    const matchedMarkets = new Map();
    for (let i = 0; i < nonZeroMints.length; i += 200) {
      const chunk = nonZeroMints.slice(i, i + 200);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT * FROM markets WHERE program_id = ? AND (yes_mint IN (${placeholders}) OR no_mint IN (${placeholders}))`
        )
        .all(pidStr, ...chunk, ...chunk);
      for (const row of rows) {
        matchedMarkets.set(row.address, row);
      }
    }

    const decodedLpByPda = new Map();
    for (const row of lpRows) {
      const decoded = dbLib.decodeLpPosition(row.account.data);
      if (decoded && decoded.shares > 0n) {
        decodedLpByPda.set(row.pubkey.toBase58(), decoded);
      }
    }

    const lpByMarket = new Map();
    if (decodedLpByPda.size > 0) {
      const candidateRows = db
        .prepare(`
          SELECT * FROM markets
          WHERE program_id = ?
            AND (
              address IN (SELECT market_address FROM wallet_positions WHERE wallet = ? AND program_id = ?)
              OR creator = ?
              OR status = 'open'
            )
          LIMIT 250
        `)
        .all(pidStr, walletStr, pidStr, walletStr);
      const allCandidates = new Map(matchedMarkets);
      for (const r of candidateRows) allCandidates.set(r.address, r);

      for (const marketRow of allCandidates.values()) {
        const pdaStr = dbLib.findLpPosition(pid, marketRow.address, wallet).toBase58();
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
          .prepare("SELECT * FROM markets WHERE address = ? AND program_id = ?")
          .get(marketAddr, pidStr);
        if (marketRow) {
          matchedMarkets.set(marketRow.address, marketRow);
          lpByMarket.set(marketRow.address, lp);
        }
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const positionRows = [];
    for (const marketRow of matchedMarkets.values()) {
      const yes = balancesByMint.get(marketRow.yes_mint) || 0n;
      const no = balancesByMint.get(marketRow.no_mint) || 0n;
      const lp = lpByMarket.get(marketRow.address);
      const lpShares = lp ? dbLib.i80f48ToAmount(lp.shares) : 0n;
      const pending = lp
        ? dbLib.computePending(
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
      const claimable = dbLib.claimableOf(marketRow.status, marketRow.winner, yes, no);
      const finalized = dbLib.isFinalizedStatus(marketRow.status);
      const canClaim =
        finalized &&
        (claimable > 0n || lpShares > 0n || pending.yes > 0n || pending.no > 0n)
          ? 1
          : 0;
      const collateral = balancesByMint.get(marketRow.collateral_mint) || 0n;
      positionRows.push({
        wallet: walletStr,
        market_address: marketRow.address,
        program_id: pidStr,
        yes_amount: yes.toString(),
        no_amount: no.toString(),
        lp_shares: lpShares.toString(),
        pending_yes: pending.yes.toString(),
        pending_no: pending.no.toString(),
        claimable_amount: claimable.toString(),
        can_claim: canClaim,
        collateral_amount: collateral.toString(),
        updated_at: nowSec,
      });
    }

    dbLib.replaceWalletPositions(db, walletStr, pidStr, positionRows, nowSec);
    return { wallet: walletStr, positions: positionRows.length, syncedAt: nowSec };
  } finally {
    if (db.open) db.close();
  }
}

function parseCliArgs(argv) {
  const opts = {
    mode: "incremental",
    wallet: null,
    dbPath: null,
    rpcUrl: (process.env.SOLANA_RPC || process.env.RPC_URL || DEFAULT_RPC).trim(),
    programId: (process.env.PROGRAM_ID || dbLib.DEFAULT_PROGRAM_ID).trim(),
    withEvidence: true,
    evidenceLimit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rebuild") opts.mode = "rebuild";
    else if (arg === "--incremental") opts.mode = "incremental";
    else if (arg === "--wallet") {
      opts.mode = "wallet";
      opts.wallet = argv[++i];
    } else if (arg === "--db") opts.dbPath = argv[++i];
    else if (arg === "--rpc") opts.rpcUrl = argv[++i];
    else if (arg === "--program-id") opts.programId = argv[++i];
    else if (arg === "--no-evidence") opts.withEvidence = false;
    else if (arg === "--evidence-limit") opts.evidenceLimit = Number(argv[++i]);
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/index-markets.js [--rebuild | --incremental | --wallet <pubkey>] [--db <path>] [--rpc <url>] [--no-evidence] [--evidence-limit <n>]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const connection = new Connection(opts.rpcUrl, {
    commitment: "confirmed",
    fetch: (url, init) => {
      const t = AbortSignal.timeout(RPC_FETCH_TIMEOUT_MS);
      const signal =
        init?.signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([init.signal, t])
          : t;
      return fetch(url, { ...init, signal });
    },
  });
  const programId = new PublicKey(opts.programId);

  if (opts.mode === "rebuild") {
    const res = await reindexFull(connection, programId, {
      dbPath: opts.dbPath,
      withEvidence: opts.withEvidence,
      evidenceLimit: opts.evidenceLimit ?? 0,
    });
    console.log("[index] rebuild complete:", JSON.stringify(res));
    return;
  }

  if (opts.mode === "wallet") {
    if (!opts.wallet) throw new Error("--wallet requires a public key");
    const res = await syncWalletPositions(connection, programId, new PublicKey(opts.wallet), {
      dbPath: opts.dbPath,
    });
    console.log("[index] wallet sync complete:", JSON.stringify(res));
    return;
  }

  const res = await syncIncremental(connection, programId, {
    dbPath: opts.dbPath,
    backfillEvidenceLimit: opts.withEvidence ? (opts.evidenceLimit ?? 5) : 0,
  });
  console.log("[index] incremental sync complete:", JSON.stringify(res));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[index] failed:", err?.stack || err);
    process.exit(1);
  });
}

module.exports = {
  MAX_SIGNATURE_PAGES,
  buildEvidenceRecord,
  computeEvidenceFromChain,
  decodeResolveReports,
  fetchRulingForMarket,
  findPushSignaturesForRuling,
  hydrateMarketRows,
  inferCluster,
  reindexFull,
  syncIncremental,
  syncWalletPositions,
};
