"use client";

import Link from "next/link";
import { formatWhen, marketKind, money, questionTitle } from "@/lib/display";
import { formatCents, formatYesNo } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import { useMarketPhaseTime, useVisibleVaults } from "@/hooks/use-markets";
import { useFeeds } from "@/hooks/use-feeds";
import { feedByState, formatFeedPrice, thresholdToHuman } from "@/lib/feeds";
import { useT } from "@/i18n/provider";
import { TickingCountdown } from "./live";
import { PriceAge } from "./price-age";
import { Button, onSpot, StableText, StatusChip } from "./ui";

const EMPTY_MARKETS: MarketView[] = [];

export function MarketTable({
  markets,
  useIndexedVault = false,
}: {
  markets: MarketView[];
  useIndexedVault?: boolean;
}) {
  const now = useMarketPhaseTime(markets);
  const vaultFor = useVisibleVaults(useIndexedVault ? EMPTY_MARKETS : markets);
  const { quotes } = useFeeds();
  const t = useT();
  return (
    <div onMouseMove={onSpot} className="surface overflow-hidden">
      <div className="market-head text-[11px] uppercase tracking-wider text-zinc-500">
        <div className="c-name text-left">
          <StableText k="markets.colMarket" />
        </div>
        <div className="c-yes text-right">
          <StableText k="markets.colYes" align="end" />
        </div>
        <div className="c-ends text-right">
          <StableText k="markets.colExpiry" align="end" />
        </div>
        <div className="c-pool text-right">
          <StableText k="markets.colLiq" align="end" />
        </div>
        <div className="c-status text-right">
          <StableText k="markets.colStatus" align="end" />
        </div>
        <div className="c-trade text-right">
          <StableText k="markets.colAction" align="end" />
        </div>
      </div>
      {markets.map((market, index) => {
        const vault = useIndexedVault ? market.vault : vaultFor(market);
        const kind = marketKind(market, now);
        const live = kind === "live";
        const actionKey =
          kind === "live"
            ? "markets.open"
            : kind === "awaiting"
              ? "markets.actionSettle"
              : kind === "voidable"
                ? "markets.actionVoid"
                : "markets.view";
        const feedPreset = feedByState(market.ocr2State);
        const spot = feedPreset ? quotes[feedPreset.key] : undefined;
        let spotLine: string | null = null;
        if (live && spot?.available && spot.price != null) {
          const thr = Number(market.threshold) * 10 ** -market.priceDecimals;
          if (thr > 0) {
            const pct = Math.abs(((spot.price - thr) / thr) * 100);
            const pctText = pct >= 0.1 ? pct.toFixed(1) : pct.toFixed(2);
            spotLine = t(spot.price >= thr ? "markets.spotAbove" : "markets.spotBelow", {
              spot: formatFeedPrice(spot.price),
              pct: pctText,
            });
          }
        }
        const href = `/markets/${market.address.toBase58()}`;
        const title = market.title ? questionTitle(market) : t("common.untitled");
        const targetSpec = `${market.feedSymbol} ${market.settleAbove ? "≥" : "<"} ${thresholdToHuman(
          market.threshold,
          market.priceDecimals
        )}`;
        return (
          <article
            key={market.address.toBase58()}
            className="row-in relative border-t border-[var(--hair)] px-5 transition-colors duration-150 hover:bg-white/[0.03]"
            style={{ animationDelay: `${Math.min(index, 7) * 50}ms` }}
          >
            <Link href={href} className="absolute inset-0 z-10" aria-label={title} />
            <div className="market-row">
              <div className="c-name min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="line-clamp-2 min-w-0 leading-snug text-[15px] font-semibold text-white">
                    {title}
                  </span>
                  <span className="shrink-0 md:hidden">
                    <StatusChip market={market} now={now} />
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-xs text-zinc-500">
                  <span className="num font-medium text-zinc-300">{targetSpec}</span>
                  <span className="md:hidden">{formatYesNo(market.yesPrice)}</span>
                  {spotLine ? (
                    <span className="hidden items-baseline gap-2 md:inline-flex">
                      <span className="truncate">{spotLine}</span>
                      <PriceAge
                        publishTime={spot?.publishTime ?? null}
                        className="min-w-[4.25rem] shrink-0 text-left text-[10px]"
                      />
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="c-yes text-right">
                <div className="num text-[17px] font-semibold text-zinc-50">{formatCents(market.yesPrice)}</div>
                <div className="mt-0.5 hidden text-[11px] text-zinc-500 md:block">
                  {formatYesNo(market.yesPrice)}
                </div>
              </div>
              <div className="c-ends text-right">
                {live ? (
                  <TickingCountdown
                    expiry={market.expiry}
                    className="whitespace-nowrap text-[15px] text-zinc-100"
                  />
                ) : (
                  <span className="num block whitespace-nowrap text-[13px] text-zinc-400">
                    {formatWhen(market.expiry)}
                  </span>
                )}
              </div>
              <div className="c-pool text-right">
                <div className="num truncate text-[15px] text-zinc-200">
                  {vault === undefined ? "—" : money(vault, market.decimals)}
                </div>
              </div>
              <div className="c-status justify-end">
                <StatusChip market={market} now={now} />
              </div>
              <div className="c-trade text-right">
                <Link href={href} className="relative z-20">
                  <Button
                    type="button"
                    tone="secondary"
                    className={
                      "h-8 min-w-[5rem] px-3 text-[11px]" + (kind === "voidable" ? " btn-void" : "")
                    }
                  >
                    <StableText k={actionKey} align="center" />
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
