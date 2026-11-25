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
  link: "LINK-USD",
  usdc: "USDC-USD",
  usdt: "USDT-USD",
};

export function chartPair(feedKey?: string | null): string | null {
  if (!feedKey) return null;
  return PAIRS[feedKey] ?? null;
}

/**
 * Candles come from Coinbase's public API through our own /chart relay
 * (no CORS or geo surprises, and the source is labelled in the UI).
 * Reference prices only — settlement always uses signed Chainlink OCR2 reports.
 */
export async function fetchCandles(
  pair: string,
  expiry: number,
  now: number,
  durationSec?: number | null
): Promise<Candle[]> {
  const ended = now > expiry;
  let start: number;
  let end: number;
  let granularity: number;
  if (durationSec != null && durationSec > 0 && durationSec <= 3600) {
    // Anchor short rounds shortly before open instead of a fixed multi-hour lookback.
    const openTs = expiry - durationSec;
    const leadSec = Math.max(15 * 60, Math.round(durationSec * 0.5));
    granularity = 60;
    if (ended) {
      const postPad = Math.min(600, Math.max(300, Math.round(durationSec * 0.5)));
      end = expiry + postPad;
      start = openTs - leadSec;
    } else {
      end = now;
      start = Math.min(openTs - leadSec, now - 15 * 60);
    }
  } else if (ended) {
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

export type SparklineData = {
  points: number[];
  changePct: number | null;
};

/**
 * Fetches real 24h hourly closes from the Coinbase /chart relay.
 * Returns null when upstream candles are unavailable (never fabricates series).
 */
export async function fetch24hSparkline(
  pair: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<SparklineData | null> {
  try {
    const start = new Date((nowSec - 24 * 3600) * 1000).toISOString();
    const end = new Date(nowSec * 1000).toISOString();
    const url = `/chart/products/${pair}/candles?granularity=3600&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const sorted = rows
      .filter((r): r is number[] => Array.isArray(r) && r.length >= 5 && Number.isFinite(r[0]) && Number.isFinite(r[3]) && Number.isFinite(r[4]))
      .sort((a, b) => a[0] - b[0]);
    if (sorted.length < 2) return null;
    const points = sorted.map((r) => r[4]);
    const open = sorted[0][3];
    const close = points[points.length - 1];
    const changePct = open > 0 ? ((close - open) / open) * 100 : null;
    return { points, changePct };
  } catch {
    return null;
  }
}
