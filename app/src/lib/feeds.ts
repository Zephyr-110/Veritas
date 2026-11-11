import { PYTH_PUSH_ORACLE, PYTH_SHARD } from "./constants";
import { findPushPriceFeed } from "./pdas";
import { bytesFromHex } from "./format";
import type { FeedKey } from "./types";
import { PublicKey } from "@solana/web3.js";

export type FeedPreset = {
  key: FeedKey;
  labelKey: "feeds.btc" | "feeds.sol" | "feeds.xau";
  symbol: string;
  hex: string;
  exponent: number;
  defaultHuman: string;
};

export const FEEDS: FeedPreset[] = [
  {
    key: "btc",
    labelKey: "feeds.btc",
    symbol: "BTC/USD",
    hex: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    exponent: -8,
    defaultHuman: "100000",
  },
  {
    key: "sol",
    labelKey: "feeds.sol",
    symbol: "SOL/USD",
    hex: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    exponent: -8,
    defaultHuman: "200",
  },
  {
    key: "xau",
    labelKey: "feeds.xau",
    symbol: "XAU/USD",
    hex: "765d2ba50737720fda44d313598912d0bd42cd1da5ce2489bfaa23784067b3fc",
    exponent: -8,
    defaultHuman: "4000",
  },
];

export function feedByKey(key: FeedKey): FeedPreset {
  const found = FEEDS.find((f) => f.key === key);
  if (!found) throw new Error("errors.decode");
  return found;
}

export function feedByHex(hex: string): FeedPreset | null {
  const clean = hex.replace(/^0x/i, "").toLowerCase();
  return FEEDS.find((f) => f.hex === clean) ?? null;
}

export function feedIdBytes(preset: FeedPreset): number[] {
  return bytesFromHex(preset.hex);
}

export function pushOracleAccount(preset: FeedPreset, program = new PublicKey(PYTH_PUSH_ORACLE)): PublicKey {
  return findPushPriceFeed(program, PYTH_SHARD, Uint8Array.from(feedIdBytes(preset)));
}

export function humanToThreshold(human: string, exponent: number): bigint {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("errors.invalidAmount");
  const scale = exponent < 0 ? -exponent : 0;
  const [whole, frac = ""] = trimmed.split(".");
  if (exponent > 0) {
    return BigInt(whole) / 10n ** BigInt(exponent);
  }
  const fracPadded = (frac + "0".repeat(scale)).slice(0, scale);
  return BigInt(whole + fracPadded);
}

export function thresholdToHuman(threshold: bigint, exponent: number, digits = 2): string {
  const value = Number(threshold) * 10 ** exponent;
  if (!Number.isFinite(value)) return threshold.toString();
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function formatPythPrice(price: number | null, digits = 2): string {
  if (price == null || !Number.isFinite(price)) return "—";
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: digits });
  if (price >= 1) return price.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return price.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
