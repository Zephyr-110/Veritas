"use client";

import Link from "next/link";
import { money, timeCopy } from "@/lib/display";
import { formatCents, formatYesNo } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import { useNow } from "@/hooks/use-now";
import { useT } from "@/i18n/provider";
import { LiveCountdown } from "./live";
import { Button, StatusChip } from "./ui";
import { marketKind } from "@/lib/display";

export function MarketTable({
  markets,
  actionHref = "open",
}: {
  markets: MarketView[];
  actionHref?: "open" | "view";
}) {
  const now = useNow(1000);
  const t = useT();
  return (
    <div className="surface overflow-hidden">
      <div className="market-head text-[11px] uppercase tracking-wide text-zinc-500">
        <div className="c-name text-left">{t("markets.colMarket")}</div>
        <div className="c-yes text-right">{t("markets.colYes")}</div>
        <div className="c-ends text-right">{t("markets.colExpiry")}</div>
        <div className="c-pool text-right">{t("markets.colLiq")}</div>
        <div className="c-status text-right">{t("markets.colStatus")}</div>
        <div className="c-trade text-right">{t("markets.colAction")}</div>
      </div>
      {markets.map((market) => {
        const live = marketKind(market, now) === "live";
        const href = `/markets/${market.address.toBase58()}`;
        const title = market.title || t("common.untitled");
        return (
          <article key={market.address.toBase58()} className="relative border-t border-zinc-800/80 px-4 hover:bg-white/[0.03]">
            <Link href={href} className="absolute inset-0 z-10" aria-label={title} />
            <div className="market-row">
              <div className="c-name min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-white">{title}</span>
                  <span className="shrink-0 md:hidden">
                    <StatusChip market={market} now={now} />
                  </span>
                </div>
                <div className="mt-1 text-xs text-zinc-500 md:hidden">{formatYesNo(market.yesPrice)}</div>
              </div>
              <div className="c-yes text-right">
                <div className="num text-sm text-zinc-100">{formatCents(market.yesPrice)}</div>
                <div className="mt-0.5 hidden text-[11px] text-zinc-500 md:block">{formatYesNo(market.yesPrice)}</div>
              </div>
              <div className="c-ends text-right">
                {live ? (
                  <LiveCountdown expiry={market.expiry} now={now} className="whitespace-nowrap text-sm text-zinc-200" />
                ) : (
                  <span className="num block truncate text-sm text-zinc-500">{timeCopy(market, now)}</span>
                )}
              </div>
              <div className="c-pool text-right">
                <div className="num truncate text-sm text-zinc-200">{money(market.vault, market.decimals)}</div>
              </div>
              <div className="c-status justify-end">
                <StatusChip market={market} now={now} />
              </div>
              <div className="c-trade text-right">
                <Link href={href} className="relative z-20">
                  <Button type="button" tone="secondary" className="h-8 px-3 text-[11px]">
                    {t(actionHref === "view" ? "markets.view" : "markets.open")}
                  </Button>
                </Link>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
