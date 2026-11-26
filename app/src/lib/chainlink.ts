import { Buffer } from "buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import { OCR2_STATE_DISCRIMINATOR } from "./constants";
import { FEEDS, type FeedPreset } from "./feeds";
import type { FeedKey, FeedQuote } from "./types";

const FEED_DECIMALS_OFFSET = 138;
const FEED_COUNTER_OFFSET = 143;
const FEED_TS_OFFSET = 208;
const FEED_ANSWER_OFFSET = 216;
const FEED_MIN_LEN = 232;

const STATE_F_OFFSET = 272;
const STATE_ROUND_OFFSET = 273;
const STATE_EPOCH_OFFSET = 276;
const STATE_DIGEST_OFFSET = 320;
const STATE_OFFCHAIN_BUF_OFFSET = 376;
const STATE_OFFCHAIN_CAP = 4096;
const STATE_OFFCHAIN_LEN_OFFSET = STATE_OFFCHAIN_BUF_OFFSET + STATE_OFFCHAIN_CAP;
const STATE_MIN_LEN = 6920;

const CONTEXT_LEN = 96;
const REPORT_LEN = 61;
const SIGNATURE_LEN = 65;
const RAW_REPORT_HEADER_LEN = 1 + CONTEXT_LEN + REPORT_LEN;

export type ChainlinkPrint = {
  price: number;
  decimals: number;
  publishTime: number;
  counter: number;
};

export type Ocr2StateInfo = {
  f: number;
  round: number;
  epoch: number;
  latestConfigDigest: Buffer;
  rMax: number;
};

export type Ocr2TransmitReport = {
  raw: Buffer;
  configDigest: Buffer;
  epoch: number;
  round: number;
  observationsTimestamp: number;
  observerCount: number;
  median: bigint;
};

function readI128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigInt64LE(offset + 8);
  return (hi << 64n) + lo;
}

function readI128BE(buf: Buffer, offset: number): bigint {
  const hi = buf.readBigInt64BE(offset);
  const lo = buf.readBigUInt64BE(offset + 8);
  return (hi << 64n) + lo;
}

export function decodeChainlinkFeed(data: Buffer): ChainlinkPrint | null {
  if (data.length < FEED_MIN_LEN) return null;
  const decimals = data[FEED_DECIMALS_OFFSET];
  const counter = data.readUInt32LE(FEED_COUNTER_OFFSET);
  const publishTime = Number(data.readBigInt64LE(FEED_TS_OFFSET));
  const answer = readI128LE(data, FEED_ANSWER_OFFSET);
  if (!Number.isFinite(publishTime) || publishTime <= 0) return null;
  const price = Number(answer) / 10 ** decimals;
  if (!Number.isFinite(price)) return null;
  return { price, decimals, publishTime, counter };
}

export const QUOTE_STALE_MS = 30_000;
export const QUOTE_PUBLISH_STALE_MS = 300_000;

export function isQuoteStale(
  quote: FeedQuote | null | undefined,
  nowMs = Date.now(),
  thresholdMs = QUOTE_STALE_MS,
  publishThresholdMs = QUOTE_PUBLISH_STALE_MS
): boolean {
  if (!quote || !quote.available || quote.price == null || quote.receivedAt === null) {
    return true;
  }
  if (quote.publishTime == null || !Number.isFinite(quote.publishTime) || quote.publishTime <= 0) {
    return true;
  }
  if (nowMs - quote.publishTime * 1000 > publishThresholdMs) {
    return true;
  }
  if (quote.receivedAt === undefined) {
    return false;
  }
  return nowMs - quote.receivedAt > thresholdMs;
}

export function emptyQuotes(): Record<FeedKey, FeedQuote> {
  return {
    btc: { key: "btc", price: null, decimals: 8, publishTime: null, counter: null, available: false, receivedAt: null },
    eth: { key: "eth", price: null, decimals: 8, publishTime: null, counter: null, available: false, receivedAt: null },
    sol: { key: "sol", price: null, decimals: 8, publishTime: null, counter: null, available: false, receivedAt: null },
    link: { key: "link", price: null, decimals: 8, publishTime: null, counter: null, available: false, receivedAt: null },
    usdc: { key: "usdc", price: null, decimals: 8, publishTime: null, counter: null, available: false, receivedAt: null },
    usdt: { key: "usdt", price: null, decimals: 8, publishTime: null, counter: null, available: false, receivedAt: null },
  };
}

function quoteFromFeed(preset: FeedPreset, data: Buffer | null): FeedQuote {
  const parsed = data ? decodeChainlinkFeed(data) : null;
  if (!parsed) {
    return {
      key: preset.key,
      price: null,
      decimals: preset.decimals,
      publishTime: null,
      counter: null,
      available: false,
      receivedAt: null,
    };
  }
  return {
    key: preset.key,
    price: parsed.price,
    decimals: parsed.decimals,
    publishTime: parsed.publishTime,
    counter: parsed.counter,
    available: true,
    receivedAt: Date.now(),
  };
}

export async function fetchFeedQuotes(connection: Connection): Promise<Record<FeedKey, FeedQuote>> {
  const out = emptyQuotes();
  const keys = FEEDS.map((f) => new PublicKey(f.feed));
  const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
  FEEDS.forEach((feed, i) => {
    const info = infos[i];
    out[feed.key] = quoteFromFeed(feed, info ? Buffer.from(info.data) : null);
  });
  return out;
}

type RpcWebSocketLike = {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export function subscribeFeedQuotes(
  connection: Connection,
  onChange: (quotes: Record<FeedKey, FeedQuote>) => void,
  onError?: (err: unknown) => void
): () => void {
  let current = emptyQuotes();
  const subs: number[] = [];

  void fetchFeedQuotes(connection)
    .then((quotes) => {
      current = quotes;
      onChange({ ...current });
    })
    .catch((err) => {
      onError?.(err);
    });

  FEEDS.forEach((feed) => {
    const address = new PublicKey(feed.feed);
    try {
      const id = connection.onAccountChange(
        address,
        (info) => {
          current = {
            ...current,
            [feed.key]: quoteFromFeed(feed, Buffer.from(info.data)),
          };
          onChange({ ...current });
        },
        "confirmed"
      );
      subs.push(id);
    } catch (err) {
      onError?.(err);
    }
  });

  const rpcWs = (connection as unknown as { _rpcWebSocket?: RpcWebSocketLike })._rpcWebSocket;
  const onWsError = (err: unknown) => onError?.(err ?? new Error("WebSocket error"));
  const onWsClose = (err: unknown) => onError?.(err ?? new Error("WebSocket disconnected"));
  if (rpcWs?.on) {
    rpcWs.on("error", onWsError);
    rpcWs.on("close", onWsClose);
  }

  return () => {
    subs.forEach((id) => {
      try {
        void connection.removeAccountChangeListener(id);
      } catch {
        // ignore cleanup failure on disconnected socket
      }
    });
    if (rpcWs) {
      const detach = rpcWs.off ?? rpcWs.removeListener;
      if (detach) {
        detach.call(rpcWs, "error", onWsError);
        detach.call(rpcWs, "close", onWsClose);
      }
    }
  };
}

function readVarint(buf: Buffer, pos: { i: number }): bigint {
  let value = 0n;
  for (let shiftIdx = 0; shiftIdx < 10; shiftIdx += 1) {
    if (pos.i >= buf.length) throw new Error("errors.invalidOracleInput");
    const b = buf[pos.i];
    pos.i += 1;
    const bits = BigInt(b & 0x7f);
    if (shiftIdx === 9 && bits > 1n) throw new Error("errors.invalidOracleInput");
    value |= bits << BigInt(7 * shiftIdx);
    if ((b & 0x80) === 0) return value;
  }
  throw new Error("errors.invalidOracleInput");
}

export function readRMax(stateData: Buffer): number {
  if (stateData.length < STATE_MIN_LEN) throw new Error("errors.invalidOracleInput");
  for (let i = 0; i < 8; i += 1) {
    if (stateData[i] !== OCR2_STATE_DISCRIMINATOR[i]) throw new Error("errors.invalidOracleInput");
  }
  const lenBig = stateData.readBigUInt64LE(STATE_OFFCHAIN_LEN_OFFSET);
  if (lenBig > BigInt(STATE_OFFCHAIN_CAP)) throw new Error("errors.invalidOracleInput");
  const len = Number(lenBig);
  const cfg = stateData.subarray(STATE_OFFCHAIN_BUF_OFFSET, STATE_OFFCHAIN_BUF_OFFSET + len);
  const pos = { i: 0 };
  let rMax: number | null = null;
  while (pos.i < cfg.length) {
    const tag = readVarint(cfg, pos);
    const wire = Number(tag & 7n);
    const field = tag >> 3n;
    if (wire === 0) {
      const v = readVarint(cfg, pos);
      if (field === 6n) {
        if (rMax !== null) throw new Error("errors.invalidOracleInput");
        if (v < 1n || v > 255n) throw new Error("errors.invalidOracleInput");
        rMax = Number(v);
      }
    } else if (wire === 1) {
      if (pos.i + 8 > cfg.length) throw new Error("errors.invalidOracleInput");
      pos.i += 8;
    } else if (wire === 2) {
      const lBig = readVarint(cfg, pos);
      if (lBig > BigInt(cfg.length - pos.i)) throw new Error("errors.invalidOracleInput");
      pos.i += Number(lBig);
    } else if (wire === 5) {
      if (pos.i + 4 > cfg.length) throw new Error("errors.invalidOracleInput");
      pos.i += 4;
    } else {
      throw new Error("errors.invalidOracleInput");
    }
  }
  if (rMax === null) throw new Error("errors.invalidOracleInput");
  return rMax;
}

export function parseOcr2State(stateData: Buffer): Ocr2StateInfo {
  const rMax = readRMax(stateData);
  return {
    f: stateData[STATE_F_OFFSET],
    round: stateData[STATE_ROUND_OFFSET],
    epoch: stateData.readUInt32LE(STATE_EPOCH_OFFSET),
    latestConfigDigest: Buffer.from(stateData.subarray(STATE_DIGEST_OFFSET, STATE_DIGEST_OFFSET + 32)),
    rMax,
  };
}

export function parseOcr2Transmit(
  rawBytes: Uint8Array | Buffer,
  expectedDigest?: Buffer,
  expectedF?: number
): Ocr2TransmitReport | null {
  const raw = Buffer.from(rawBytes);
  if (raw.length <= RAW_REPORT_HEADER_LEN) return null;
  const sigBytes = raw.length - RAW_REPORT_HEADER_LEN;
  if (sigBytes % SIGNATURE_LEN !== 0) return null;

  const sigCount = sigBytes / SIGNATURE_LEN;
  if (expectedF != null && sigCount !== expectedF + 1) return null;

  const configDigest = Buffer.from(raw.subarray(1, 33));
  if (expectedDigest && !configDigest.equals(expectedDigest)) return null;

  const epoch = raw.readUInt32BE(1 + 59);
  const round = raw[1 + 63];
  const rawReportOffset = 1 + CONTEXT_LEN;
  const observationsTimestamp = raw.readUInt32BE(rawReportOffset);
  const observerCount = raw[rawReportOffset + 4];
  if (expectedF != null && expectedF >= observerCount) return null;
  const median = readI128BE(raw, rawReportOffset + 37);

  return {
    raw,
    configDigest,
    epoch,
    round,
    observationsTimestamp,
    observerCount,
    median,
  };
}

export function areReportsAdjacent(
  pre: { epoch: number; round: number },
  post: { epoch: number; round: number },
  rMax: number
): boolean {
  if (pre.round === rMax && post.round === 1 && pre.epoch + 1 === post.epoch) return true;
  if (pre.round < rMax && post.round === pre.round + 1 && pre.epoch === post.epoch) return true;
  return false;
}
