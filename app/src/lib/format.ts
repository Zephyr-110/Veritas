import { Buffer } from "buffer";
import { PREDICTION_BYTES } from "./constants";
import { t } from "@/i18n/store";
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
  throw new Error("errors.decode");
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
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("errors.invalidAmount");
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + fracPadded);
}

export function formatCents(price: number): string {
  if (!Number.isFinite(price)) return "—";
  return `${(price * 100).toFixed(1)}¢`;
}

export function formatPct(price: number): string {
  if (!Number.isFinite(price)) return "—";
  return `${Math.round(price * 100)}%`;
}

export function formatYesNo(yesPrice: number): string {
  const yes = Number.isFinite(yesPrice) ? Math.max(0, Math.min(100, Math.round(yesPrice * 100))) : 50;
  return t("odds.line", { yes, no: 100 - yes });
}

export function formatStamp(input: number | Date): string {
  const date = typeof input === "number" ? new Date(input * 1000) : input;
  if (Number.isNaN(date.getTime()) || (typeof input === "number" && !input)) return "—";
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return y + "-" + m + "-" + d + " " + hh + ":" + mm;
}

export function formatUnix(ts: number): string {
  return formatStamp(ts);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function countdown(expiry: number, now = Math.floor(Date.now() / 1000)): string {
  const delta = Math.max(0, expiry - now);
  if (expiry - now <= 0) return t("time.ended");
  const d = Math.floor(delta / 86400);
  const h = Math.floor((delta % 86400) / 3600);
  const m = Math.floor((delta % 3600) / 60);
  const s = delta % 60;
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? t("time.daysClock", { days: d, clock }) : clock;
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

export function hexOf(bytes: number[] | Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function bytesFromHex(hex: string): number[] {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) throw new Error("errors.decode");
  return Array.from(Buffer.from(clean, "hex"));
}

export function formatRawI64(value: bigint | number): string {
  return value.toString();
}
