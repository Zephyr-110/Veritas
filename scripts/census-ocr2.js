#!/usr/bin/env node
"use strict";

const { utils } = require("@coral-xyz/anchor");
const { createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { gzipSync } = require("node:zlib");
const { parseOcr2Transmit, areReportsAdjacent } = require("./settle");

const OCR2 = "cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ";
const STORE = "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny";
// Finalized OCR2 state at slot 525816420: f=1 and rMax=6 for all six digests.
const FEEDS = [
  ["BTC", "HCKJKQ8xFfqm5BxTA6LaUCWYXNShYXF4eAwC7NhBYXkj", "000313f1d4c985690d10b076382710ec0f1b56e242853c5227ccd0773a34f332"],
  ["ETH", "7zDTDDXiMqwbEEE17ZuFE4A6K5uBQo15tG1gkgdKZQB2", "00032676f7187f38b18b2cc6cac5a385030690d48e854ea99b0da051ed1e7ae6"],
  ["SOL", "EpFp9mhi9cvZL9Lp59S1mt2twv2dtZGgFUvZEQMZ9Ra8", "00035db3d150cc0cd14d9cb1f1da219877e9843c79cb01b01bc14f51f9479684"],
  ["LINK", "Ghm1a2c2NGPg6pKGG3PP1GLAuJkHm1RKMPqqJwPM7JpJ", "000377d3f88b066d0644ac5eeb2f611adbef2823cb9ac700d7a695830e8029ed"],
  ["USDC", "ENVhPWE3nuvwc5qx2MjSwS41SXr33gFgGaWX4ATA9pyV", "00036f4cfc7fc737fe7ee1ab57bcdec0db348a9c0bc82ec74daf719089d17c91"],
  ["USDT", "DcZuU19fXJSEurnuFh4moeYK5hohvgaBD5KmjvHvYEG1", "000383e0502692b80f3c96eec5d8e2cc0901fed0e37c9e6eb95c52890536a0e3"],
];

async function rpc(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { result, error } = await res.json();
      if (error) throw new Error(`${method}: ${error.code} ${error.message}`);
      return result;
    } catch (err) {
      if (attempt === 5) throw err;
      await delay(1000 * 2 ** attempt);
    }
  }
}

function* reports(tx, state, digest) {
  if (!tx.meta || tx.meta.err !== null) throw new Error("Expected successful transaction metadata");
  const msg = tx.transaction.message;
  const lookup = tx.meta.loadedAddresses;
  const keys = [...msg.accountKeys, ...(lookup?.writable ?? []), ...(lookup?.readonly ?? [])];
  const inner = new Map((tx.meta.innerInstructions ?? []).map(g => [g.index, g.instructions]));
  for (const [i, outer] of msg.instructions.entries()) {
    for (const [j, ix] of [outer, ...(inner.get(i) ?? [])].entries()) {
      if (keys[ix.programIdIndex] !== OCR2 || keys[ix.accounts[0]] !== state ||
          keys[ix.accounts[3]] !== STORE) continue;
      const report = parseOcr2Transmit(utils.bytes.bs58.decode(ix.data), digest, 1);
      if (!report || report.round < 1 || report.round > 6) {
        throw new Error(`Unrecognized transmit/config in ${tx.transaction.signatures[0]}`);
      }
      yield { report, instruction: j === 0 ? String(i) : `${i}.${j - 1}` };
    }
  }
}

async function scan(url, [symbol, state, hex], start, end, evidence) {
  const digest = Buffer.from(hex, "hex");
  const result = { symbol, first: null, last: null, landed: 0, gapTransitions: 0, adjacent: 0, increasingTimestampPairs: 0 };
  let previous, previousTx, paginationToken;
  do {
    const page = await rpc(url, "getTransactionsForAddress", [state, {
      transactionDetails: "full", encoding: "json", maxSupportedTransactionVersion: 0,
      commitment: "finalized", sortOrder: "asc", limit: 100, paginationToken,
      filters: { blockTime: { gte: start, lt: end }, status: "succeeded" },
    }]);
    for (const tx of page.data) {
      if (!Number.isInteger(tx.blockTime) || tx.blockTime < start || tx.blockTime >= end ||
          !Number.isInteger(tx.slot) || !Number.isInteger(tx.transactionIndex) ||
          (previousTx && (tx.slot < previousTx.slot ||
           (tx.slot === previousTx.slot && tx.transactionIndex <= previousTx.transactionIndex)))) {
        throw new Error(`Invalid page order or window for ${symbol}`);
      }
      previousTx = tx;
      for (const { report, instruction } of reports(tx, state, digest)) {
        const boundary = { slot: tx.slot, utc: new Date(tx.blockTime * 1000).toISOString(), signature: tx.transaction.signatures[0] };
        result.first ??= boundary;
        result.last = boundary;
        result.landed++;
        evidence?.push([symbol, tx.slot, tx.transactionIndex, instruction, tx.blockTime,
          report.epoch, report.round, report.observationsTimestamp, boundary.signature].join(","));
        if (previous) {
          if (areReportsAdjacent(previous, report, 6)) {
            result.adjacent++;
            if (report.observationsTimestamp > previous.observationsTimestamp) result.increasingTimestampPairs++;
          } else {
            result.gapTransitions++;
          }
        }
        previous = report;
      }
    }
    if (page.paginationToken && (!page.data.length || page.paginationToken === paginationToken)) {
      throw new Error(`Pagination stalled for ${symbol}`);
    }
    paginationToken = page.paginationToken;
  } while (paginationToken);
  console.error(`${symbol}: ${result.landed} landed`);
  return result;
}

async function main() {
  const [from, to, evidenceFile] = process.argv.slice(2);
  const [start, end] = [from, to].map(s => Date.parse(s) / 1000);
  if (![4, 5].includes(process.argv.length) || ![from, to].every(s => s?.endsWith("Z")) ||
      ![start, end].every(Number.isInteger) || start >= end) {
    throw new Error("Usage: node scripts/census-ocr2.js <start-UTC-inclusive> <end-UTC-exclusive> [new-evidence.csv.gz]");
  }
  const url = process.env.SOLANA_RPC;
  if (!url) throw new Error("Set SOLANA_RPC to a Helius Devnet archive RPC URL");
  if (await rpc(url, "getGenesisHash", []) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
    throw new Error("Expected Solana Devnet genesis hash");
  }
  const evidence = evidenceFile ? FEEDS.map(() => []) : null;
  const feeds = await Promise.all(FEEDS.map((feed, i) => scan(url, feed, start, end, evidence?.[i])));
  const totals = {};
  for (const key of ["landed", "gapTransitions", "adjacent", "increasingTimestampPairs"]) {
    totals[key] = feeds.reduce((sum, row) => sum + row[key], 0);
  }
  let csvSha256;
  if (evidence) {
    const header = "feed,slot,transactionIndex,instruction,blockTime,epoch,round,observationTime,signature";
    const csv = [header, ...evidence.flat(), ""].join("\n");
    csvSha256 = createHash("sha256").update(csv).digest("hex");
    writeFileSync(evidenceFile, gzipSync(csv), { flag: "wx" });
  }
  console.log(JSON.stringify({ from, to, feeds, totals, csvSha256 }, null, 2));
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exit(1); });
