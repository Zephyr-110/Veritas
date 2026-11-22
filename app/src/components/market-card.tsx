"use client";

import Link from "next/link";
import { money, formatWhen, kindLabelKey, marketKind, questionTitle } from "@/lib/display";
import { formatYesNo } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import { useNow } from "@/hooks/use-now";
import { useLocale, useT } from "@/i18n/provider";
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
}: {
  href?: string;
  title: string;
  yesPrice?: number;
  expiry?: number;
  liquidity: string;
  threshold?: string;
  statusKey?: string;
}) {
  const now = useNow(1000);
  const t = useT();
  const live = expiry != null && now > 0 && expiry > now;
  const body = (
    <div className="stack-3 p-5">
      <div className="truncate text-sm font-medium text-white">{title || t("common.untitled")}</div>
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
        <div className="text-right text-[11px] text-zinc-500">
          <StableText k={statusKey} align="end" />
        </div>
      ) : null}
    </div>
  );
  const cls = "surface block h-full";
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

export function MarketCard({ market }: { market: MarketView }) {
  const now = useNow(1000);
  useLocale();
  const kind = marketKind(market, now);
  return (
    <FeatureCard
      href={"/markets/" + market.address.toBase58()}
      title={market.title ? questionTitle(market) : ""}
      yesPrice={market.yesPrice}
      expiry={market.expiry}
      liquidity={money(market.vault, market.decimals)}
      statusKey={kindLabelKey(kind, market)}
    />
  );
}
