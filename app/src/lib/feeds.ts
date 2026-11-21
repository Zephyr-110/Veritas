import { PublicKey } from "@solana/web3.js";
import type { FeedKey } from "./types";

export type FeedPreset = {
  key: FeedKey;
  labelKey: "feeds.btc" | "feeds.eth" | "feeds.sol" | "feeds.link" | "feeds.usdc" | "feeds.usdt";
  symbol: string;
  feed: string;
  state: string;
  decimals: number;
  defaultHuman: string;
  market: boolean;
};

/**
 * Exact Chainlink devnet whitelist matching `ALLOWED_FEEDS` in
 * `programs/prediction_market/src/constants.rs`.
 */
export const FEEDS: FeedPreset[] = [
  {
    key: "btc",
    labelKey: "feeds.btc",
    symbol: "BTC/USD",
    feed: "6PxBx93S8x3tno1TsFZwT5VqP8drrRCbCXygEXYNkFJe",
    state: "HCKJKQ8xFfqm5BxTA6LaUCWYXNShYXF4eAwC7NhBYXkj",
    decimals: 8,
    defaultHuman: "60000",
    market: true,
  },
  {
    key: "eth",
    labelKey: "feeds.eth",
    symbol: "ETH/USD",
    feed: "669U43LNHx7LsVj95uYksnhXUfWKDsdzVqev3V4Jpw3P",
    state: "7zDTDDXiMqwbEEE17ZuFE4A6K5uBQo15tG1gkgdKZQB2",
    decimals: 8,
    defaultHuman: "2000",
    market: true,
  },
  {
    key: "sol",
    labelKey: "feeds.sol",
    symbol: "SOL/USD",
    feed: "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR",
    state: "EpFp9mhi9cvZL9Lp59S1mt2twv2dtZGgFUvZEQMZ9Ra8",
    decimals: 8,
    defaultHuman: "100",
    market: true,
  },
  {
    key: "link",
    labelKey: "feeds.link",
    symbol: "LINK/USD",
    feed: "HXoZZBWv25N4fm2vfSKnHXTeDJ31qaAcWZe3ZKeM6dQv",
    state: "Ghm1a2c2NGPg6pKGG3PP1GLAuJkHm1RKMPqqJwPM7JpJ",
    decimals: 8,
    defaultHuman: "10",
    market: true,
  },
  {
    key: "usdc",
    labelKey: "feeds.usdc",
    symbol: "USDC/USD",
    feed: "2EmfL3MqL3YHABudGNmajjCpR13NNEn9Y4LWxbDm6SwR",
    state: "ENVhPWE3nuvwc5qx2MjSwS41SXr33gFgGaWX4ATA9pyV",
    decimals: 8,
    defaultHuman: "1.00",
    market: true,
  },
  {
    key: "usdt",
    labelKey: "feeds.usdt",
    symbol: "USDT/USD",
    feed: "8QQSUPtdRTboa4bKyMftVNRfGFsB4Vp9d7r39hGKi53e",
    state: "DcZuU19fXJSEurnuFh4moeYK5hohvgaBD5KmjvHvYEG1",
    decimals: 8,
    defaultHuman: "1.00",
    market: true,
  },
];

export function feedByKey(key: FeedKey): FeedPreset {
  const found = FEEDS.find((f) => f.key === key);
  if (!found) throw new Error("errors.decode");
  return found;
}

export function feedByState(state: PublicKey | string): FeedPreset | null {
  const addr = typeof state === "string" ? state.trim() : state.toBase58();
  return FEEDS.find((f) => f.state === addr) ?? null;
}

export function humanToThreshold(human: string, decimals = 8): bigint {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("errors.invalidAmount");
  const scale = Math.max(0, decimals);
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(scale)).slice(0, scale);
  return BigInt(whole + fracPadded);
}

export function thresholdToHuman(threshold: bigint, decimals = 8, digits?: number): string {
  const value = Number(threshold) / 10 ** decimals;
  if (!Number.isFinite(value)) return threshold.toString();
  const abs = Math.abs(value);
  const maxFrac = digits ?? (abs >= 10 ? 2 : abs >= 0.5 ? 4 : 6);
  return value.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

export function formatFeedPrice(price: number | null, digits?: number): string {
  if (price == null || !Number.isFinite(price)) return "—";
  const abs = Math.abs(price);
  if (digits != null) {
    return price.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  if (abs >= 1000) return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 10) return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 2) return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (abs >= 0.5) return price.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return price.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
