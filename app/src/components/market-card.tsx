"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { money, formatWhen, kindLabel, marketKind } from "@/lib/display";
import { formatYesNo } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import { useNow } from "@/hooks/use-now";
import { useT } from "@/i18n/provider";
import { LiveCountdown } from "./live";

export function FeatureCard({
  href,
  title,
  yesPrice = 0.5,
  expiry,
  liquidity,
  threshold,
  status,
}: {
  href?: string;
  title: string;
  yesPrice?: number;
  expiry?: number;
  liquidity: string;
  threshold?: string;
  status?: string;
}) {
  const now = useNow(1000);
  const t = useT();
  const live = expiry != null && expiry > now;
  const body = (
    <div className="stack-3 p-4">
      <div className="truncate text-sm font-medium text-white">{title || t("common.untitled")}</div>
      {threshold ? <div className="num text-right text-xs text-zinc-400">{threshold}</div> : null}
      <div className="num text-right text-sm text-zinc-200">{formatYesNo(yesPrice)}</div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-zinc-500">{t("markets.colExpiry")}</span>
        {live && expiry != null ? (
          <LiveCountdown expiry={expiry} now={now} className="text-sm text-zinc-200" />
        ) : (
          <span className="num text-right text-sm text-zinc-500">{expiry ? formatWhen(expiry) : "\u2014"}</span>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-zinc-500">{t("markets.colLiq")}</span>
        <span className="num text-right text-sm text-zinc-200">{liquidity}</span>
      </div>
      {status ? <div className="text-right text-[11px] text-zinc-500">{status}</div> : null}
    </div>
  );
  const cls = "surface block h-full";
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function MarketCard({ market }: { market: MarketView }) {
  const now = useNow(1000);
  return (
    <FeatureCard
      href={"/markets/" + market.address.toBase58()}
      title={market.title}
      yesPrice={market.yesPrice}
      expiry={market.expiry}
      liquidity={money(market.vault, market.decimals)}
      status={kindLabel(marketKind(market, now), market)}
    />
  );
}

export function FeatureGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-3">{children}</div>;
}
