"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMarkets } from "@/hooks/use-markets";
import { useNow } from "@/hooks/use-now";
import { listSection, marketKind } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { explorerAccount, formatStamp, shorten } from "@/lib/format";
import { GITHUB_REPO } from "@/lib/constants";
import { PricePanel } from "@/components/price-tape";
import { PulseAreaMark } from "@/components/logo-marks";
import { MarketTable } from "@/components/market-table";
import { MarketTableSkeleton } from "@/components/skeletons";
import { Button, Reveal } from "@/components/ui";
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
    () => markets.filter((market) => marketKind(market, now) === "live").sort((a, b) => a.expiry - b.expiry),
    [markets, now]
  );
  const finished = useMemo(
    () => markets.filter((market) => listSection(marketKind(market, now)) === "ended").sort((a, b) => b.expiry - a.expiry),
    [markets, now]
  );
  const merged = !loading && !error && live.length === 0;

  return (
    <div className="relative">
      <div className="home-grid" aria-hidden />
      <section id="masthead" className="masthead">
        <div className="fade-in flex items-center justify-center gap-2 text-[13px] text-zinc-400">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />
          <span>{t("home.badge")}</span>
        </div>
        <h1 className="mt-6">
          <span className="line-mask">
            <span className="line-inner mh-brand" style={{ animationDelay: "100ms" }}>
              <PulseAreaMark size={76} variant="hero" />
              <span className="mh-name">{t("brand.name")}</span>
            </span>
          </span>
          <span className="line-mask mh-tag-mask">
            <span className="line-inner mh-tag" style={{ animationDelay: "200ms" }}>{t("home.mastheadTag")}</span>
          </span>
        </h1>
      </section>

      <section className="home-hero">
        <div className="home-hero-grid">
          <div className="flex flex-col items-center">
            <p className="home-sub rise-in" style={{ animationDelay: "900ms" }}>{t("home.subtitle")}</p>
            <div className="rise-in mt-8 flex flex-wrap justify-center gap-3" style={{ animationDelay: "900ms" }}>
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
          <PricePanel />
        </div>
      </section>

      <section className="home-section home-why">
        <div className="grid gap-6 md:grid-cols-3">
          <div className="home-how-card rise-in" style={{ animationDelay: "1160ms" }}>
            <div className="home-why-title">{t("home.why1Title")}</div>
            <p>{t("home.why1")}</p>
          </div>
          <div className="home-how-card rise-in" style={{ animationDelay: "1080ms" }}>
            <div className="home-why-title">{t("home.why2Title")}</div>
            <p>{t("home.why2")}</p>
          </div>
          <div className="home-how-card rise-in" style={{ animationDelay: "1000ms" }}>
            <div className="home-why-title">{t("home.why3Title")}</div>
            <p>{t("home.why3")}</p>
          </div>
        </div>
      </section>

      <Reveal><section className="home-section">
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
            <div className="surface fade-in p-5">
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-[15px] text-zinc-500">{t("home.emptyLive")}</p>
                <Link href="/create">
                  <Button type="button" tone="secondary" className="h-8 px-3 text-[13px]">
                    {t("markets.emptyCta")}
                  </Button>
                </Link>
              </div>
              <div className="mt-5 border-t border-white/5 pt-5">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="home-kicker">{t("home.next")}</span>
                  <span className="num text-[18px] text-white">{formatStamp(openAt)}</span>
                  <LiveCountdown expiry={openUnix} now={now} className="text-[18px] text-white" />
                </div>
                <div className="home-next-bar" aria-hidden>
                  <div className="home-next-fill" style={{ width: `${(((now % 3600) / 3600) * 100).toFixed(2)}%` }} />
                </div>
                <p className="mt-3 text-[13px] text-zinc-500">{t("home.nextBody")}</p>
              </div>
            </div>
          )}
        </div>
      </section></Reveal>

      {merged ? null : (
        <Reveal><section className="home-section">
          <h2 className="home-kicker">{t("home.next")}</h2>
          <div className="home-next mt-5">
            <div className="num text-[22px] text-white">{formatStamp(openAt)}</div>
            <div className="mt-2">
              <LiveCountdown expiry={openUnix} now={now} className="text-[22px] text-white" />
            </div>
            <div className="home-next-bar" aria-hidden>
              <div className="home-next-fill" style={{ width: `${(((now % 3600) / 3600) * 100).toFixed(2)}%` }} />
            </div>
            <p className="mt-4 text-[15px] text-zinc-500">{t("home.nextBody")}</p>
          </div>
        </section></Reveal>
      )}

      <Reveal><section className="home-section">
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
      </section></Reveal>

      <Reveal><section id="how" className="home-section scroll-mt-24">
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
      </section></Reveal>

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
