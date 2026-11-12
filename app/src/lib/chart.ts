export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

const PAIRS: Record<string, string> = {
  btc: "BTC-USD",
  eth: "ETH-USD",
  sol: "SOL-USD",
  doge: "DOGE-USD",
  xau: "PAXG-USD",
};

export function chartPair(feedKey?: string | null): string | null {
  if (!feedKey) return null;
  return PAIRS[feedKey] ?? null;
}

/**
 * Candles come from Coinbase's public API through our own /chart relay
 * (same pattern as the /rpc relay: no CORS or geo surprises, and the
 * source is labelled in the UI). Reference行情 only — settlement always
 * uses the Pyth print. Window is chosen around the market's expiry.
 */
export async function fetchCandles(pair: string, expiry: number, now: number): Promise<Candle[]> {
  const ended = now > expiry;
  let start: number;
  let end: number;
  let granularity: number;
  if (ended) {
    end = expiry + 600;
    start = end - 4.2 * 3600;
    granularity = 60;
  } else if (expiry - now > 4 * 3600) {
    end = now;
    start = now - 23 * 3600;
    granularity = 300;
  } else {
    end = now;
    start = expiry - 4.5 * 3600;
    granularity = 60;
  }
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const url = `/chart/products/${pair}/candles?granularity=${granularity}&start=${encodeURIComponent(iso(start))}&end=${encodeURIComponent(iso(end))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("chart fetch failed");
  const rows = (await res.json()) as number[][];
  return rows
    .map((r) => ({ time: r[0], low: r[1], high: r[2], open: r[3], close: r[4] }))
    .sort((a, b) => a.time - b.time);
}
