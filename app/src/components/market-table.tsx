"use client";

import Link from "next/link";
import { money, questionTitle, timeCopy } from "@/lib/display";
import { formatCents, formatYesNo } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import { useNow } from "@/hooks/use-now";
import { useFeeds } from "@/hooks/use-feeds";
import { FEEDS, formatPythPrice } from "@/lib/feeds";
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
  const { quotes } = useFeeds();
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
      {markets.map((market, index) => {
        const live = marketKind(market, now) === "live";
        const feedPreset = FEEDS.find((f) => f.hex === market.feedHex);
        const spot = feedPreset ? quotes[feedPreset.key] : undefined;
        let spotLine: string | null = null;
        if (live && spot?.available && spot.price != null) {
          const thr = Number(market.threshold) * 10 ** market.exponent;
          if (thr > 0) {
            const pct = Math.abs(((spot.price - thr) / thr) * 100);
            const pctText = pct >= 0.1 ? pct.toFixed(1) : pct.toFixed(2);
            spotLine = t(spot.price >= thr ? "markets.spotAbove" : "markets.spotBelow", {
              spot: formatPythPrice(spot.price),
              pct: pctText,
            });
          }
        }
        const href = `/markets/${market.address.toBase58()}`;
        const title = market.title ? questionTitle(market) : t("common.untitled");
        return (
          <article
            key={market.address.toBase58()}
            className="row-in relative border-t border-zinc-800/80 px-5 transition-colors duration-150 hover:bg-white/[0.03]"
            style={{ animationDelay: `${Math.min(index, 7) * 80}ms` }}
          >
            <Link href={href} className="absolute inset-0 z-10" aria-label={title} />
            <div className="market-row">
              <div className="c-name min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[15px] font-semibold text-white">{title}</span>
                  <span className="shrink-0 md:hidden">
                    <StatusChip market={market} now={now} />
                  </span>
                </div>
                <div className="mt-1 text-xs text-zinc-500 md:hidden">{formatYesNo(market.yesPrice)}</div>
                {spotLine ? <div className="mt-1 hidden truncate text-xs text-zinc-500 md:block">{spotLine}</div> : null}
              </div>
              <div className="c-yes text-right">
                <div className="num text-[17px] font-semibold text-zinc-50">{formatCents(market.yesPrice)}</div>
                <div className="mt-0.5 hidden text-[11px] text-zinc-500 md:block">{formatYesNo(market.yesPrice)}</div>
              </div>
              <div className="c-ends text-right">
                {live ? (
                  <LiveCountdown expiry={market.expiry} now={now} className="whitespace-nowrap text-[15px] text-zinc-100" />
                ) : (
                  <span className="num block truncate text-[15px] text-zinc-500">{timeCopy(market, now)}</span>
                )}
              </div>
              <div className="c-pool text-right">
                <div className="num truncate text-[15px] text-zinc-200">{money(market.vault, market.decimals)}</div>
              </div>
              <div className="c-status justify-end">
                <StatusChip market={market} now={now} />
              </div>
              <div className="c-trade text-right">
                <Link href={href} className="relative z-20">
                  <Button type="button" tone="secondary" className="h-8 px-3 text-[11px] transition-transform duration-150 hover:scale-105">
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
