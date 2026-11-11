import { COLLATERAL_SYMBOL, RESOLVE_WINDOW } from "./constants";
import { countdown, toUi } from "./format";
import { marketPhase, type MarketView, type UserPosition } from "./markets";
import { dateLocale, t } from "@/i18n/store";

export type MarketKind = "live" | "awaiting" | "voidable" | "resolved" | "voided" | "upcoming";

export function money(amount: bigint, decimals: number, digits = 2): string {
  return `${toUi(amount, decimals, digits)} ${COLLATERAL_SYMBOL}`;
}

export function chancePct(price: number): number {
  if (!Number.isFinite(price)) return 50;
  return Math.max(0, Math.min(100, Math.round(price * 100)));
}

export function formatWhen(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(dateLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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
  if (market.status === "burn") return "voided";
  if (market.status === "upcoming") return "upcoming";
  const phase = marketPhase(market, now);
  if (phase.live) return "live";
  if (phase.afterWindow) return "voidable";
  return "awaiting";
}

export function kindLabel(kind: MarketKind, market: MarketView): string {
  switch (kind) {
    case "live":
      return t("kind.live");
    case "awaiting":
      return t("kind.awaiting");
    case "voidable":
      return t("kind.voidable");
    case "resolved":
      return market.winner === "yes" ? t("kind.yesWon") : t("kind.noWon");
    case "voided":
      return t("kind.voided");
    case "upcoming":
      return t("kind.upcoming");
  }
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
    case "voided":
      return "no";
    case "upcoming":
      return "mute";
  }
}

export function timeCopy(market: MarketView, now: number): string {
  const kind = marketKind(market, now);
  if (kind === "live") return countdown(market.expiry, now);
  if (kind === "awaiting") return t("time.closed", { when: formatWhen(market.expiry) });
  if (kind === "voidable") return t("time.waitingRefund");
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
  if (kind === "upcoming") return "next";
  return "ended";
}
