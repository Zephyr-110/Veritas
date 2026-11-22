import { COLLATERAL_SYMBOL, RESOLVE_WINDOW } from "./constants";
import { countdown, formatStamp, toUi } from "./format";
import { isVoidedStatus, marketPhase, type MarketView, type UserPosition } from "./markets";
import { feedByState, thresholdToHuman } from "./feeds";
import { getLocale, t } from "@/i18n/store";

export type MarketKind =
  | "live"
  | "awaiting"
  | "voidable"
  | "resolved"
  | "staleVoid"
  | "windowVoid";

const AUTO_TITLE =
  /^(.+?) (>=|<) ([\d,.]+) @ |^([A-Z0-9]+\/[A-Z0-9]+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(?:能站上|会跌破)\s+[\d,.]+\s*吗[？?]?$|^([A-Z0-9]+\/[A-Z0-9]+)\s+(?:above|below)\s+[\d,.]+\s+at\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\??$|^([A-Z0-9]+\/[A-Z0-9]+)\s+at or (?:above|below)\s+/i;

/** Auto-generated spec titles ("BTC/USD >= 73,479 @ ...") read as questions;
    a creator's custom title is returned untouched. */
export function questionTitle(market: MarketView): string {
  if (!AUTO_TITLE.test(market.title)) return market.title;
  const symbol = feedByState(market.ocr2State)?.symbol ?? market.title.split(" ")[0];
  const human = thresholdToHuman(market.threshold, market.priceDecimals);
  const stamp = formatStamp(market.expiry);
  if (getLocale() === "zh") {
    return symbol + " " + stamp + " " + (market.settleAbove ? "能站上" : "会跌破") + " " + human + " 吗？";
  }
  return symbol + " " + (market.settleAbove ? "above" : "below") + " " + human + " at " + stamp + "?";
}

export function money(amount: bigint, decimals: number, digits = 2): string {
  return `${toUi(amount, decimals, digits)} ${COLLATERAL_SYMBOL}`;
}

export function chancePct(price: number): number {
  if (!Number.isFinite(price)) return 50;
  return Math.max(0, Math.min(100, Math.round(price * 100)));
}

export function formatWhen(ts: number): string {
  return formatStamp(ts);
}

export function clusterLabel(cluster: string): string {
  if (cluster === "mainnet-beta") return t("cluster.mainnet");
  if (cluster === "localnet") return t("cluster.local");
  if (cluster === "devnet") return t("cluster.devnet");
  if (cluster === "testnet") return t("cluster.testnet");
  return cluster;
}

export function marketKind(market: MarketView, now: number): MarketKind {
  if (market.status === "resolved") return "resolved";
  if (market.status === "staleBurn") return "staleVoid";
  if (market.status === "windowBurn") return "windowVoid";
  const phase = marketPhase(market, now);
  if (phase.live) return "live";
  if (phase.afterWindow) return "voidable";
  return "awaiting";
}

export function kindLabelKey(
  kind: MarketKind,
  market: MarketView
):
  | "kind.live"
  | "kind.awaiting"
  | "kind.voidable"
  | "kind.yesWon"
  | "kind.noWon"
  | "kind.staleVoid"
  | "kind.windowVoid" {
  switch (kind) {
    case "live":
      return "kind.live";
    case "awaiting":
      return "kind.awaiting";
    case "voidable":
      return "kind.voidable";
    case "resolved":
      return market.winner === "yes" ? "kind.yesWon" : "kind.noWon";
    case "staleVoid":
      return "kind.staleVoid";
    case "windowVoid":
      return "kind.windowVoid";
  }
}

export function kindLabel(kind: MarketKind, market: MarketView): string {
  return t(kindLabelKey(kind, market));
}

export function kindTone(
  kind: MarketKind,
  market?: MarketView
): "mute" | "yes" | "no" | "accent" | "ink" {
  switch (kind) {
    case "live":
      return "yes";
    case "awaiting":
      return "accent";
    case "voidable":
      return "ink";
    case "resolved":
      return market?.winner === "no" ? "no" : "yes";
    case "staleVoid":
    case "windowVoid":
      return "no";
  }
}

export function timeCopy(market: MarketView, now: number): string {
  const kind = marketKind(market, now);
  if (kind === "live") return countdown(market.expiry, now);
  if (kind === "awaiting") return t("time.closed", { when: formatWhen(market.expiry) });
  return formatWhen(market.expiry);
}

export function hasBet(position: UserPosition): boolean {
  return position.yes > 0n || position.no > 0n;
}

export function resolveHours(): number {
  return Math.floor(RESOLVE_WINDOW / 3600);
}

export function listSection(kind: MarketKind): "live" | "next" | "ended" {
  if (kind === "live") return "live";
  return "ended";
}

export function isMarketVoided(market: { status: MarketView["status"] }): boolean {
  return isVoidedStatus(market.status);
}
