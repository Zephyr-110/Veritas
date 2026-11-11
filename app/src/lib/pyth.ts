import { Connection, PublicKey } from "@solana/web3.js";
import { HERMES_URL, MAX_SETTLE_DELAY, PYTH_PUSH_ORACLE } from "./constants";
import { decodePythPrint, pythToNumber, type PythPrint } from "./codec";
import { FEEDS, pushOracleAccount, type FeedPreset } from "./feeds";
import type { FeedKey, FeedQuote } from "./types";
import type { MarketView } from "./markets";

const PUSH = new PublicKey(PYTH_PUSH_ORACLE);

export function emptyQuotes(): Record<FeedKey, FeedQuote> {
  return {
    btc: { key: "btc", price: null, expo: null, publishTime: null, conf: null, available: false },
    sol: { key: "sol", price: null, expo: null, publishTime: null, conf: null, available: false },
    xau: { key: "xau", price: null, expo: null, publishTime: null, conf: null, available: false },
  };
}

function quoteFromPrint(preset: FeedPreset, print: PythPrint | null): FeedQuote {
  if (!print) {
    return { key: preset.key, price: null, expo: preset.exponent, publishTime: null, conf: null, available: false };
  }
  return {
    key: preset.key,
    price: pythToNumber(print.price, print.exponent),
    expo: print.exponent,
    publishTime: Number(print.publishTime),
    conf: pythToNumber(print.conf, print.exponent),
    available: true,
  };
}

export async function fetchFeedQuotes(connection: Connection): Promise<Record<FeedKey, FeedQuote>> {
  const out = emptyQuotes();
  const keys = FEEDS.map((feed) => pushOracleAccount(feed, PUSH));
  const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
  FEEDS.forEach((feed, i) => {
    const info = infos[i];
    const print = info ? decodePythPrint(info.data, Uint8Array.from(Buffer.from(feed.hex, "hex"))) : null;
    out[feed.key] = quoteFromPrint(feed, print);
  });
  return out;
}

export function subscribeFeedQuotes(
  connection: Connection,
  onChange: (quotes: Record<FeedKey, FeedQuote>) => void
): () => void {
  let current = emptyQuotes();
  const subs: number[] = [];
  void fetchFeedQuotes(connection).then((quotes) => {
    current = quotes;
    onChange({ ...current });
  });
  FEEDS.forEach((feed) => {
    const address = pushOracleAccount(feed, PUSH);
    const id = connection.onAccountChange(
      address,
      (info) => {
        const print = decodePythPrint(info.data, Uint8Array.from(Buffer.from(feed.hex, "hex")));
        current = { ...current, [feed.key]: quoteFromPrint(feed, print) };
        onChange({ ...current });
      },
      "confirmed"
    );
    subs.push(id);
  });
  return () => {
    subs.forEach((id) => {
      void connection.removeAccountChangeListener(id);
    });
  };
}

type HermesParsed = {
  parsed?: Array<{
    id?: string;
    price?: { price?: string; expo?: number; publish_time?: number; conf?: string };
  }>;
  binary?: { data?: string[] };
};

async function hermesAt(timestamp: number, feedHex: string): Promise<HermesParsed> {
  const url = `${HERMES_URL}/v2/updates/price/${timestamp}?ids[]=0x${feedHex}&encoding=base64&parsed=true`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("errors.pythFetch");
  return (await res.json()) as HermesParsed;
}

export type ResolveUpdate = {
  binary: string[];
  publishTime: number | null;
  prevGuess: number | null;
  price: bigint | null;
  exponent: number | null;
};

export async function fetchResolveUpdate(market: MarketView): Promise<ResolveUpdate> {
  const hex = market.feedHex;
  const start = market.endTs;
  const candidates = [start, start + 1, start + 2, start + 5, start + MAX_SETTLE_DELAY, start + 30];
  let last: HermesParsed | null = null;
  for (const ts of candidates) {
    const data = await hermesAt(ts, hex);
    last = data;
    const parsed = data.parsed?.[0]?.price;
    const publish = parsed?.publish_time ?? null;
    if (publish != null && publish >= start) {
      return {
        binary: data.binary?.data ?? [],
        publishTime: publish,
        prevGuess: null,
        price: parsed?.price != null ? BigInt(parsed.price) : null,
        exponent: parsed?.expo ?? null,
      };
    }
  }
  if (!last?.binary?.data?.length) throw new Error("errors.pythNoPrint");
  return {
    binary: last.binary.data,
    publishTime: last.parsed?.[0]?.price?.publish_time ?? null,
    prevGuess: null,
    price: last.parsed?.[0]?.price?.price != null ? BigInt(last.parsed[0].price.price) : null,
    exponent: last.parsed?.[0]?.price?.expo ?? null,
  };
}
