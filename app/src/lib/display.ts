import { COLLATERAL_SYMBOL, RESOLVE_WINDOW } from "./constants";
import { countdown, formatFixed, formatStamp } from "./format";
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

const STAMP_TITLE =
  /^(.+?) (>=|<) ([\d,.]+) @ |^([A-Z0-9]+\/[A-Z0-9]+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(?:能站上|会跌破)\s+[\d,.]+\s*吗[？?]?$|^([A-Z0-9]+\/[A-Z0-9]+)\s+(?:above|below)\s+[\d,.]+\s+at\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\??$/i;

const DURATION_EN_TITLE =
  /^([A-Z0-9]+\/[A-Z0-9]+)\s+(at or above|at or below|above|below)\s+(opening price|[\d,.]+)\s+in\s+(\d+)\s*(min|mins|minute|minutes|m|hour|hours|hr|hrs|h|day|days|d|sec|secs|second|seconds|s)\s*\??$/i;

const DURATION_ZH_TITLE =
  /^([A-Z0-9]+\/[A-Z0-9]+)\s+(\d+)\s*(分钟|小时|天|秒)(?:后|内)?\s*(能站上|会跌破)\s*(开盘价|[\d,.]+)\s*吗[？?]?$/i;

type DurationUnit = "min" | "hour" | "day" | "sec";

export type DurationFilter = "all" | "2m" | "15m" | "24h";

const UNIT_SECONDS: Record<DurationUnit, number> = {
  sec: 1,
  min: 60,
  hour: 3600,
  day: 86_400,
};

function normalizeDurationUnit(raw: string): DurationUnit {
  const u = raw.toLowerCase();
  if (u === "分钟" || u.startsWith("m")) return "min";
  if (u === "小时" || u.startsWith("h")) return "hour";
  if (u === "天" || u.startsWith("d")) return "day";
  return "sec";
}

/** Extracts market round duration in seconds from templated EN/ZH titles, or null for custom/stamp titles. */
export function marketDurationSec(market: Pick<MarketView, "title">): number | null {
  const en = DURATION_EN_TITLE.exec(market.title);
  if (en) {
    const qty = Number(en[4]);
    const sec = qty * UNIT_SECONDS[normalizeDurationUnit(en[5])];
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  }
  const zh = DURATION_ZH_TITLE.exec(market.title);
  if (zh) {
    const qty = Number(zh[2]);
    const sec = qty * UNIT_SECONDS[normalizeDurationUnit(zh[3])];
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  }
  return null;
}

/** Maps templated market titles into the /markets duration filter buckets. */
export function marketDurationBucket(
  market: Pick<MarketView, "title">
): Exclude<DurationFilter, "all"> | null {
  const sec = marketDurationSec(market);
  if (sec === 120) return "2m";
  if (sec === 900) return "15m";
  if (sec === 86_400) return "24h";
  return null;
}

function formatDurationTitle(
  symbol: string,
  above: boolean,
  inclusive: boolean,
  target: string,
  amount: string,
  unit: DurationUnit,
  locale: "en" | "zh"
): string {
  const isOpening = target.toLowerCase() === "opening price" || target === "开盘价";
  if (locale === "zh") {
    const zhUnit = unit === "min" ? "分钟" : unit === "hour" ? "小时" : unit === "day" ? "天" : "秒";
    const zhVerb = above ? "能站上" : "会跌破";
    const zhTarget = isOpening ? "开盘价" : ` ${target} `;
    return `${symbol} ${amount} ${zhUnit}后${zhVerb}${zhTarget}吗？`;
  }
  const enUnit =
    unit === "min"
      ? "min"
      : unit === "sec"
        ? "sec"
        : Number(amount) === 1
          ? unit
          : `${unit}s`;
  const enVerb = inclusive ? (above ? "at or above" : "at or below") : above ? "above" : "below";
  const enTarget = isOpening ? "opening price" : target;
  return `${symbol} ${enVerb} ${enTarget} in ${amount} ${enUnit}?`;
}

/** Auto-generated spec/template titles are re-assembled in the active language;
    a creator's custom or unparseable title is returned untouched. */
export function questionTitle(market: MarketView): string {
  const raw = market.title;
  const locale = getLocale();
  const symbol = feedByState(market.ocr2State)?.symbol ?? raw.split(" ")[0];

  const enDur = DURATION_EN_TITLE.exec(raw);
  if (enDur) {
    const verb = enDur[2].toLowerCase();
    const inclusive = verb.startsWith("at or ");
    const above = market.settleAbove ?? !verb.includes("below");
    const unit = normalizeDurationUnit(enDur[5]);
    return formatDurationTitle(symbol, above, inclusive, enDur[3], enDur[4], unit, locale);
  }

  const zhDur = DURATION_ZH_TITLE.exec(raw);
  if (zhDur) {
    const above = market.settleAbove ?? zhDur[4] === "能站上";
    const unit = normalizeDurationUnit(zhDur[3]);
    const isOpening = zhDur[5] === "开盘价";
    return formatDurationTitle(symbol, above, isOpening, zhDur[5], zhDur[2], unit, locale);
  }

  if (!STAMP_TITLE.test(raw)) return raw;
  const human = thresholdToHuman(market.threshold, market.priceDecimals);
  const stamp = formatStamp(market.expiry);
  if (locale === "zh") {
    return symbol + " " + stamp + " " + (market.settleAbove ? "能站上" : "会跌破") + " " + human + " 吗？";
  }
  return symbol + " " + (market.settleAbove ? "above" : "below") + " " + human + " at " + stamp + "?";
}

export function money(amount: bigint, decimals: number, digits = 2): string {
  return `${formatFixed(amount, decimals, digits)} ${COLLATERAL_SYMBOL}`;
}

export function chancePct(price: number): number {
  if (!Number.isFinite(price)) return 50;
  return Math.max(0, Math.min(1000, Math.round(price * 1000))) / 10;
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

export function listSection(kind: MarketKind): "live" | "unsettled" | "ended" {
  if (kind === "live") return "live";
  if (kind === "awaiting" || kind === "voidable") return "unsettled";
  return "ended";
}

export function formatExpiredAgo(expiry: number, now: number): string {
  const sec = Math.max(0, Math.floor(now - expiry));
  if (sec < 60) return t("markets.expiredSec", { n: sec });
  if (sec < 3600) return t("markets.expiredMin", { n: Math.floor(sec / 60) });
  if (sec < 86_400) return t("markets.expiredHour", { n: Math.floor(sec / 3600) });
  return t("markets.expiredDay", { n: Math.floor(sec / 86_400) });
}

export function isMarketVoided(market: { status: MarketView["status"] }): boolean {
  return isVoidedStatus(market.status);
}
