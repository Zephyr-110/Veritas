import { Buffer } from "buffer";
import { PublicKey, type Connection } from "@solana/web3.js";
import { parseOcr2Transmit, type Ocr2TransmitReport } from "./chainlink";
import { type DecodedMarketSnapshot } from "./codec";
import { type MarketView } from "./markets";
import { extractOcr2Instructions } from "./resolve";
import { instructionGroups } from "./transaction-history";

const RESOLVE = Buffer.from([155, 23, 80, 173, 46, 74, 23, 239]);

export function decodeResolveReports(data: Buffer) {
  // Anchor encodes each signed transmit as a Borsh Vec<u8>.
  if (data.length < 16 || !data.subarray(0, 8).equals(RESOLVE)) return null;
  const middle = 12 + data.readUInt32LE(8);
  if (middle + 4 > data.length || middle + 4 + data.readUInt32LE(middle) !== data.length) return null;
  const pre = parseOcr2Transmit(data.subarray(12, middle));
  const post = parseOcr2Transmit(data.subarray(middle + 4));
  return pre && post && pre.configDigest.equals(post.configDigest) ? { pre, post } : null;
}

export function witnessCounts(snapshot: DecodedMarketSnapshot | null, pre: Ocr2TransmitReport, post: Ocr2TransmitReport) {
  const match = (r: Ocr2TransmitReport) => snapshot?.entries.find(e => e.epoch === r.epoch && e.round === r.round
    && e.ts === BigInt(r.observationsTimestamp) && e.price === r.median);
  const a = match(pre), b = match(post);
  return a && b && b.counter > a.counter ? [a.counter, b.counter] as const : null;
}

type ResolvedMarket = Pick<MarketView, "address" | "finishTs" | "endTs" | "ocr2State" | "settledPublishTime" | "settledPrice">;

export async function fetchRuling(connection: Connection, program: PublicKey, market: ResolvedMarket, signal?: AbortSignal) {
  let before: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await connection.getSignaturesForAddress(market.address, { before, limit: 100 }, "confirmed");
    const candidates = page.filter(s => !s.err && (s.blockTime == null || Math.abs(s.blockTime - market.finishTs) <= 30))
      .sort((a, b) => Math.abs((a.blockTime ?? market.finishTs) - market.finishTs)
        - Math.abs((b.blockTime ?? market.finishTs) - market.finishTs));
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const tx = await connection.getTransaction(candidate.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      for (const ix of instructionGroups(tx).flat()) {
        if (!ix.program.equals(program) || !ix.accounts[1]?.equals(market.address)
          || !ix.accounts[3]?.equals(market.ocr2State)) continue;
        const pair = decodeResolveReports(ix.data);
        if (pair && pair.pre.observationsTimestamp < market.endTs && pair.post.observationsTimestamp === market.settledPublishTime
          && pair.post.median === market.settledPrice) return { ...pair, signature: candidate.signature };
      }
    }
    const last = page.at(-1);
    if (!last || page.length < 100 || (last.blockTime != null && last.blockTime < market.finishTs - 30)) return null;
    before = last.signature;
  }
}

export async function findPushSignatures(connection: Connection, feed: PublicKey,
  ruling: NonNullable<Awaited<ReturnType<typeof fetchRuling>>>, signal?: AbortSignal) {
  const result: { pre?: string; post?: string } = {};
  // Start at the historical resolve slot, even for a market that finished months ago.
  let before = ruling.signature;
  const from = ruling.pre.observationsTimestamp - 60;
  const until = ruling.post.observationsTimestamp + 60;
  for (;;) {
    signal?.throwIfAborted();
    const page = await connection.getSignaturesForAddress(feed, { before, limit: 250 }, "confirmed");
    const candidates = page.filter(s => !s.err && (s.blockTime == null || (s.blockTime >= from && s.blockTime <= until)))
      .sort((a, b) => Math.abs((a.blockTime ?? until) - ruling.post.observationsTimestamp)
        - Math.abs((b.blockTime ?? until) - ruling.post.observationsTimestamp));
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const tx = await connection.getTransaction(candidate.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx?.meta || tx.meta.err) continue;
      for (const raw of extractOcr2Instructions(tx)) {
        const pushed = parseOcr2Transmit(raw, ruling.pre.configDigest);
        if (!pushed) continue;
        for (const side of ["pre", "post"] as const) {
          const report = ruling[side];
          // Relayers may use a different nonce or subset of oracle signatures
          // for the same signed report context and content.
          if (pushed.raw.subarray(1, 158).equals(report.raw.subarray(1, 158))) result[side] = candidate.signature;
        }
      }
      if (result.pre && result.post) return result;
    }
    const last = page.at(-1);
    if (!last || page.length < 250 || (last.blockTime != null && last.blockTime < from)) return result;
    before = last.signature;
  }
}
