"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMarkets } from "@/hooks/use-markets";
import { useNow } from "@/hooks/use-now";
import { marketKind } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { explorerAccount, formatStamp, shorten } from "@/lib/format";
import { GITHUB_REPO } from "@/lib/constants";
import { PriceTape } from "@/components/price-tape";
import { MarketTable } from "@/components/market-table";
import { MarketTableSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui";
import { LiveCountdown } from "@/components/live";
import { useSettings } from "@/components/providers";
import { useT } from "@/i18n/provider";

function nextHourDate(nowMs: number): Date {
  const next = new Date(nowMs);
  next.setMinutes(0, 0, 0);
  next.setSeconds(0, 0);
  next.setMilliseconds(0);
  next.setHours(next.getHours() + 1);
  return next;
}

export default function HomePage() {
  const { markets, loading, error, reload } = useMarkets();
  const now = useNow(1000);
  const t = useT();
  const { settings } = useSettings();
  const programHref = explorerAccount(settings.programId, settings.cluster);
  const openAt = nextHourDate(now * 1000);
  const openUnix = Math.floor(openAt.getTime() / 1000);

  const live = useMemo(
    () => markets.filter((market) => marketKind(market, now) === "live"),
    [markets, now]
  );
  const finished = useMemo(
    () => markets.filter((market) => market.status === "resolved" || market.status === "burn"),
    [markets]
  );

  return (
    <div>
      <section className="home-hero">
        <div>
          <div className="flex items-center gap-2 text-[13px] text-zinc-400">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />
            <span>{t("home.badge")}</span>
          </div>
          <h1 className="home-hero-title mt-6">{t("home.title")}</h1>
          <p className="home-sub mt-5">{t("home.subtitle")}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/markets">
              <Button type="button" className="h-11 px-6">
                {t("home.cta")}
              </Button>
            </Link>
            <Link href="#how">
              <Button type="button" tone="secondary" className="h-11 px-6">
                {t("home.howCta")}
              </Button>
            </Link>
          </div>
        </div>
        <PriceTape />
      </section>

      <section className="home-section">
        <h2 className="home-kicker flex items-center gap-2">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />
          {t("home.live")}
        </h2>
        <div className="mt-5">
          {error && !live.length ? (
            <div className="flex flex-wrap items-center gap-3 text-[15px] text-zinc-500">
              <span>{t("markets.loadError", { error: localizeError(error) })}</span>
              <Button type="button" tone="secondary" className="h-8 px-3 text-[13px]" onClick={() => void reload()}>
                {t("common.tryAgain")}
              </Button>
            </div>
          ) : loading && !markets.length ? (
            <MarketTableSkeleton rows={4} />
          ) : live.length ? (
            <div className="fade-in">
              <MarketTable markets={live} />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-[15px] text-zinc-500">{t("home.emptyLive")}</p>
              <Link href="/create">
                <Button type="button" tone="secondary" className="h-8 px-3 text-[13px]">
                  {t("markets.emptyCta")}
                </Button>
              </Link>
            </div>
          )}
        </div>
      </section>

      <section className="home-section">
        <h2 className="home-kicker">{t("home.next")}</h2>
        <div className="home-next mt-5">
          <div className="num text-right text-[22px] text-white">{formatStamp(openAt)}</div>
          <div className="mt-2 text-right">
            <LiveCountdown expiry={openUnix} now={now} className="text-[22px] text-white" />
          </div>
          <p className="mt-4 text-[15px] text-zinc-500">{t("home.nextBody")}</p>
        </div>
      </section>

      <section className="home-section">
        <h2 className="home-kicker">{t("home.finished")}</h2>
        <div className="mt-5">
          {loading && !markets.length ? (
            <MarketTableSkeleton rows={3} />
          ) : finished.length ? (
            <div className="fade-in">
              <MarketTable markets={finished} actionHref="view" />
            </div>
          ) : (
            <p className="text-[15px] text-zinc-500">{t("home.emptyFinished")}</p>
          )}
        </div>
      </section>

      <section id="how" className="home-section scroll-mt-24">
        <h2 className="home-kicker">{t("home.how")}</h2>
        <div className="mt-6 grid gap-6 md:grid-cols-3">
          <div className="home-how-card">{t("home.how1")}</div>
          <div className="home-how-card">{t("home.how2")}</div>
          <div className="home-how-card">{t("home.how3")}</div>
        </div>
        <p className="mt-6 text-[13px] leading-relaxed text-zinc-500">
          {t("home.howFeesLead")}
          <Link href="/help" className="underline decoration-zinc-600 underline-offset-2 hover:text-zinc-300">
            {t("home.howHelp")}
          </Link>
          {t("home.howFeesTail")}
        </p>
      </section>

      <footer className="home-footer">
        <span>{t("brand.name")}</span>
        <span className="home-footer-dot">·</span>
        {programHref ? (
          <a href={programHref} target="_blank" rel="noreferrer" className="font-mono hover:text-zinc-300">
            {shorten(settings.programId, 4, 4)}
          </a>
        ) : (
          <span className="font-mono">{shorten(settings.programId, 4, 4)}</span>
        )}
        <span className="home-footer-dot">·</span>
        <a href={GITHUB_REPO} target="_blank" rel="noreferrer" className="hover:text-zinc-300">
          {t("footer.github")}
        </a>
        <span className="home-footer-dot">·</span>
        <span>{t("home.footerNote")}</span>
      </footer>
    </div>
  );
}
