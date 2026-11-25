"use client";

import Link from "next/link";
import { money, formatWhen, kindLabelKey, marketKind, questionTitle } from "@/lib/display";
import { thresholdToHuman } from "@/lib/feeds";
import { formatYesNo } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import type { FeedKey } from "@/lib/types";
import { useNow } from "@/hooks/use-now";
import { useLocale, useT } from "@/i18n/provider";
import { AssetBadge } from "./asset-badge";
import { LiveCountdown } from "./live";
import { onSpot, StableText } from "./ui";

export function FeatureCard({
  href,
  title,
  yesPrice = 0.5,
  expiry,
  liquidity,
  threshold,
  statusKey,
  asset,
}: {
  href?: string;
  title: string;
  yesPrice?: number;
  expiry?: number;
  liquidity: string;
  threshold?: string;
  statusKey?: string;
  asset?: { feedKey?: FeedKey | null; symbol?: string };
}) {
  const now = useNow(1000, expiry ?? 0);
  const t = useT();
  const live = expiry != null && now > 0 && expiry > now;
  const body = (
    <div className="stack-3 flex-1 p-5">
      <div className={asset ? "flex items-start gap-2.5" : undefined}>
        {asset ? <AssetBadge feedKey={asset.feedKey} symbol={asset.symbol} size="sm" className="mt-0.5" /> : null}
        <div className="line-clamp-2 min-h-[2.5rem] min-w-0 flex-1 text-sm font-medium leading-5 text-white">
          {title || t("common.untitled")}
        </div>
      </div>
      {threshold ? <div className="num text-right text-xs text-zinc-400">{threshold}</div> : null}
      <div className="num text-right text-sm text-zinc-200">{formatYesNo(yesPrice)}</div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-zinc-500">
          <StableText k="markets.colExpiry" />
        </span>
        {live && expiry != null ? (
          <LiveCountdown expiry={expiry} now={now} className="text-sm text-zinc-200" />
        ) : (
          <span className="num text-right text-sm text-zinc-500">{expiry ? formatWhen(expiry) : "\u2014"}</span>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-zinc-500">
          <StableText k="markets.colLiq" />
        </span>
        <span className="num text-right text-sm text-zinc-200">{liquidity}</span>
      </div>
      {statusKey ? (
        <div className="mt-auto pt-1 text-right text-[11px] text-zinc-500">
          <StableText k={statusKey} align="end" />
        </div>
      ) : null}
    </div>
  );
  const cls = "surface flex h-full flex-col";
  return href ? (
    <Link href={href} onMouseMove={onSpot} className={cls}>
      {body}
    </Link>
  ) : (
    <div onMouseMove={onSpot} className={cls}>
      {body}
    </div>
  );
}

export function MarketCard({ market, vault = market.vault }: { market: MarketView; vault?: bigint | null }) {
  const now = useNow(1000, market.status === "open" ? market.expiry : 0);
  useLocale();
  const kind = marketKind(market, now);
  const thr = thresholdToHuman(market.threshold, market.priceDecimals);
  return (
    <FeatureCard
      href={"/markets/" + market.address.toBase58()}
      title={market.title ? questionTitle(market) : ""}
      yesPrice={market.yesPrice}
      expiry={market.expiry}
      liquidity={vault === null ? "—" : money(vault, market.decimals)}
      threshold={`${market.feedSymbol} ${market.settleAbove ? "≥" : "<"} ${thr}`}
      statusKey={kindLabelKey(kind, market)}
      asset={{ feedKey: market.feedKey, symbol: market.feedSymbol }}
    />
  );
}
