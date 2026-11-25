import { DEFAULT_RPC } from "./constants";

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_CLUSTERS = new Set(["devnet", "mainnet-beta", "testnet", "localnet"]);

type SecurityStore = {
  nextCleanup: number;
  buckets: Map<string, Map<string, number[]>>;
  dailyCounts: Map<string, { dayKey: string; count: number }>;
};

const globalScope = globalThis as typeof globalThis & {
  __veritasServerSecurity?: SecurityStore;
};

function utcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function getStore(now = Date.now()): SecurityStore {
  if (!globalScope.__veritasServerSecurity) {
    globalScope.__veritasServerSecurity = {
      nextCleanup: 0,
      buckets: new Map(),
      dailyCounts: new Map(),
    };
  }
  const store = globalScope.__veritasServerSecurity;
  if (!store.nextCleanup || now >= store.nextCleanup) {
    store.nextCleanup = now + 60_000;
    const cutoff = now - DAY_MS;
    for (const [bucketName, map] of store.buckets) {
      for (const [k, list] of map) {
        const kept = list.filter((ts) => ts > cutoff);
        if (kept.length === 0) map.delete(k);
        else if (kept.length !== list.length) map.set(k, kept);
      }
      if (map.size === 0) store.buckets.delete(bucketName);
    }
    const today = utcDayKey(now);
    for (const [bucketName, entry] of store.dailyCounts) {
      if (entry.dayKey !== today) store.dailyCounts.delete(bucketName);
    }
  }
  return store;
}

export function resolveServerRpcUrl(): string {
  return (process.env.SOLANA_RPC || process.env.NEXT_PUBLIC_SOLANA_RPC || DEFAULT_RPC).trim();
}

export function parseStrictPositiveInt(
  raw: string | null,
  opts: { defaultValue: number; min?: number; max: number }
): { ok: true; value: number } | { ok: false } {
  if (raw == null || raw.trim() === "") {
    return { ok: true, value: opts.defaultValue };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false };
  }
  const n = Number(trimmed);
  const min = opts.min ?? 1;
  if (!Number.isSafeInteger(n) || n < min || n > opts.max) {
    return { ok: false };
  }
  return { ok: true, value: n };
}

export function validateClusterParam(raw: string | null): string | undefined {
  const trimmed = raw?.trim();
  return trimmed && VALID_CLUSTERS.has(trimmed) ? trimmed : undefined;
}

export function validateFaucetRequest(
  req: Request
): { ok: true } | { ok: false; status: 403 | 415; error: "forbidden_origin" | "unsupported_media_type" } {
  const contentType = (req.headers.get("content-type") || "").trim().toLowerCase();
  if (contentType !== "application/json" && !contentType.startsWith("application/json;")) {
    return { ok: false, status: 415, error: "unsupported_media_type" };
  }

  const secFetchSite = (req.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin") {
    return { ok: false, status: 403, error: "forbidden_origin" };
  }

  const originRaw = (req.headers.get("origin") || "").trim();
  if (!originRaw) {
    return { ok: false, status: 403, error: "forbidden_origin" };
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(originRaw);
  } catch {
    return { ok: false, status: 403, error: "forbidden_origin" };
  }
  if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
    return { ok: false, status: 403, error: "forbidden_origin" };
  }

  const allowEnv = process.env.FAUCET_ALLOWED_ORIGINS?.trim();
  if (allowEnv) {
    const allowed = allowEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.includes(parsedOrigin.origin)) {
      return { ok: true };
    }
  }

  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const headerHost = req.headers.get("host")?.trim();
  let urlHost = "";
  try {
    urlHost = new URL(req.url).host;
  } catch {
    // ignore malformed req.url
  }
  const expectedHost = forwardedHost || headerHost || urlHost;
  if (!expectedHost || parsedOrigin.host !== expectedHost) {
    return { ok: false, status: 403, error: "forbidden_origin" };
  }

  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (
    (forwardedProto === "http" || forwardedProto === "https") &&
    parsedOrigin.protocol !== `${forwardedProto}:`
  ) {
    return { ok: false, status: 403, error: "forbidden_origin" };
  }

  return { ok: true };
}

function pruneBucketKey(
  store: SecurityStore,
  bucket: string,
  key: string,
  windowMs: number,
  now: number
): number[] {
  let map = store.buckets.get(bucket);
  if (!map) {
    map = new Map();
    store.buckets.set(bucket, map);
  }
  const cutoff = now - windowMs;
  const raw = map.get(key) ?? [];
  const valid = raw.filter((ts) => ts > cutoff);
  if (valid.length === 0) map.delete(key);
  else if (valid.length !== raw.length) map.set(key, valid);
  return valid;
}

export function checkRateLimit(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): boolean {
  if (limit <= 0) return false;
  const store = getStore(now);
  return pruneBucketKey(store, bucket, key, windowMs, now).length < limit;
}

export function recordRateLimit(
  bucket: string,
  key: string,
  windowMs: number,
  now = Date.now()
): void {
  const store = getStore(now);
  const valid = pruneBucketKey(store, bucket, key, windowMs, now);
  valid.push(now);
  let map = store.buckets.get(bucket);
  if (!map) {
    map = new Map();
    store.buckets.set(bucket, map);
  }
  map.set(key, valid);
}

export function checkDailyCountCap(bucket: string, cap: number, now = Date.now()): boolean {
  if (cap <= 0) return false;
  const store = getStore(now);
  const today = utcDayKey(now);
  const entry = store.dailyCounts.get(bucket);
  if (!entry || entry.dayKey !== today) return true;
  return entry.count < cap;
}

export function recordDailyCount(bucket: string, now = Date.now()): void {
  const store = getStore(now);
  const today = utcDayKey(now);
  const entry = store.dailyCounts.get(bucket);
  if (!entry || entry.dayKey !== today) {
    store.dailyCounts.set(bucket, { dayKey: today, count: 1 });
    return;
  }
  entry.count += 1;
}

export function resetServerSecurityForTests(): void {
  globalScope.__veritasServerSecurity = {
    nextCleanup: 0,
    buckets: new Map(),
    dailyCounts: new Map(),
  };
}
