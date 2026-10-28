import { Buffer } from "buffer";
import { PREDICTION_BYTES } from "./constants";
import type { MarketStatusName, Side } from "./types";

export function encodePrediction(title: string): number[] {
  const buf = Buffer.alloc(PREDICTION_BYTES);
  Buffer.from(title, "utf8").copy(buf, 0, 0, PREDICTION_BYTES);
  return Array.from(buf);
}

export function decodePrediction(bytes: number[] | Uint8Array): string {
  const buf = Buffer.from(bytes);
  const end = buf.indexOf(0);
  return buf.slice(0, end === -1 ? buf.length : end).toString("utf8").replace(/\0/g, "").trim();
}

export function utf8Len(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function randomMarketId(): number[] {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes);
}

export function marketIdHex(id: number[] | Uint8Array): string {
  return Buffer.from(id).toString("hex");
}

export function parseEnumKey<T extends string>(value: unknown): T {
  if (typeof value === "string") return value as T;
  if (value && typeof value === "object") {
    const key = Object.keys(value as object)[0];
    if (key) return key as T;
  }
  throw new Error("Unable to parse on-chain enum");
}

export function parseStatus(value: unknown): MarketStatusName {
  return parseEnumKey<MarketStatusName>(value);
}

export function parseSide(value: unknown): Side {
  return parseEnumKey<Side>(value);
}

export function sideToChain(side: Side): { yes: Record<string, never> } | { no: Record<string, never> } {
  return side === "yes" ? { yes: {} } : { no: {} };
}

export function asBigInt(value: { toString(): string } | number | bigint | string): bigint {
  return BigInt(value.toString());
}

export function shorten(value: string, left = 4, right = 4): string {
  if (value.length <= left + right + 1) return value;
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

export function toUi(amount: bigint, decimals: number, digits = 4): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const raw = abs.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, raw.length - decimals);
  const frac = raw.slice(raw.length - decimals).replace(/0+$/, "");
  const clipped = frac.slice(0, digits);
  const body = clipped.length ? `${whole}.${clipped}` : whole;
  return neg ? `-${body}` : body;
}

export function fromUi(text: string, decimals: number): bigint {
  const trimmed = text.trim();
  if (!trimmed) return 0n;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Invalid amount");
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + fracPadded);
}

export function formatCents(price: number): string {
  if (!Number.isFinite(price)) return "—";
  return `${Math.round(price * 100)}¢`;
}

export function formatPct(price: number): string {
  if (!Number.isFinite(price)) return "—";
  return `${(price * 100).toFixed(1)}%`;
}

export function formatUnix(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("en-US", { hour12: false });
}

export function countdown(expiry: number, now = Math.floor(Date.now() / 1000)): string {
  const delta = expiry - now;
  if (delta <= 0) return "Ended";
  const d = Math.floor(delta / 86400);
  const h = Math.floor((delta % 86400) / 3600);
  const m = Math.floor((delta % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  const s = delta % 60;
  return `${m}m ${s}s`;
}

export function explorerTx(sig: string, cluster: string): string | null {
  if (cluster === "localnet") return null;
  const q = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${sig}${q}`;
}

export function explorerAccount(address: string, cluster: string): string | null {
  if (cluster === "localnet") return null;
  const q = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://solscan.io/account/${address}${q}`;
}
