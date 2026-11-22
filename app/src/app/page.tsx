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
import { MarketCard } from "@/components/market-card";
import { MarketTableSkeleton } from "@/components/skeletons";
import { Button, DataFreshness, Reveal, StableText, onSpot } from "@/components/ui";
import { LiveCountdown } from "@/components/live";
import { useSettings } from "@/components/providers";
import { useLocale, useT } from "@/i18n/provider";
import { tPair } from "@/i18n/store";

function nextHourDate(nowMs: number): Date {
  const next = new Date(nowMs);
  next.setMinutes(0, 0, 0);
  next.setSeconds(0, 0);
  next.setMilliseconds(0);
  next.setHours(next.getHours() + 1);
  return next;
}

export default function HomePage() {
  const { markets, loading, refreshing, updatedAt, isStaleError, error, reload } = useMarkets();
  const now = useNow(1000);
  const t = useT();
  const locale = useLocale();
  const { settings } = useSettings();
  const programHref = explorerAccount(settings.programId, settings.cluster);
  const mountedNow = now > 0;
  const openAt = mountedNow ? nextHourDate(now * 1000) : null;
  const openUnix = openAt ? Math.floor(openAt.getTime() / 1000) : 0;

  const live = useMemo(
    () =>
      mountedNow
        ? markets.filter((market) => marketKind(market, now) === "live").sort((a, b) => a.expiry - b.expiry)
        : [],
    [markets, mountedNow, now]
  );
  const finished = useMemo(
    () =>
      mountedNow
        ? markets.filter((market) => listSection(marketKind(market, now)) === "ended").sort((a, b) => b.expiry - a.expiry)
        : [],
    [markets, mountedNow, now]
  );
  const merged = !loading && !error && live.length === 0;

  const feesLead = tPair("home.howFeesLead");
  const feesHelp = tPair("home.howHelp");
  const feesTail = tPair("home.howFeesTail");
  const reserveFees =
    locale === "zh"
      ? `${feesLead.en}${feesHelp.en}${feesTail.en}`
      : `${feesLead.zh}${feesHelp.zh}${feesTail.zh}`;

  return (
    <div className="relative">
      <section className="home-hero">
        <div className="home-hero-grid">
          <div className="hero-left">
            <div id="masthead" className="masthead">
              <div className="fade-in flex items-center justify-center gap-2 text-[12px] font-medium tracking-[0.12em] text-zinc-400 lg:justify-start">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--yes)]" />
                <StableText k="home.badge" />
              </div>
              <h1 className="mt-4">
                <span className="line-mask">
                  <span className="line-inner mh-brand" style={{ animationDelay: "40ms" }}>
                    <PulseAreaMark size={64} variant="hero" />
                    <span className="mh-name">{t("brand.name")}</span>
                  </span>
                </span>
                <span className="line-mask mh-tag-mask">
                  <span className="line-inner mh-tag" style={{ animationDelay: "90ms" }}>
                    <StableText k="home.mastheadTag" align="start" />
                  </span>
                </span>
              </h1>
            </div>
            <div className="mt-6 flex flex-col items-center lg:items-start">
              <p className="home-sub rise-in text-center lg:text-left" style={{ animationDelay: "130ms" }}>
                <StableText k="home.subtitle" block />
              </p>
              <div
                className="rise-in mt-7 flex flex-wrap justify-center gap-3 lg:justify-start"
                style={{ animationDelay: "180ms" }}
              >
                <Link href="/markets">
                  <Button type="button" className="h-11 px-6">
                    <StableText k="home.cta" align="center" />
                  </Button>
                </Link>
                <Link href="#how">
                  <Button type="button" tone="secondary" className="h-11 px-6">
                    <StableText k="home.howCta" align="center" />
                  </Button>
                </Link>
              </div>
            </div>
          </div>
          <PricePanel />
        </div>
      </section>

      <Reveal>
        <section className="py-3">
          <div onMouseMove={onSpot} className="surface overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hair)] px-5 py-3">
              <span className="home-kicker flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                <StableText k="home.settleKicker" />
              </span>
              <span className="text-xs text-zinc-400">
                <StableText k="home.settleRuleTag" align="end" />
              </span>
            </div>

            <div className="grid divide-y divide-[var(--hair)] md:grid-cols-3 md:divide-x md:divide-y-0">
              <div className="flex flex-col gap-1.5 px-5 py-4">
                <span className="num text-[11px] font-medium tracking-wider text-zinc-500">
                  01 · {t("home.settleNode1Tag")}
                </span>
                <div className="text-[15px] font-medium text-[var(--ink-strong)]">
                  <StableText k="home.settleNode1Title" block />
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">
                  <StableText k="home.settleNode1Sub" block />
                </p>
              </div>

              <div className="flex flex-col gap-1.5 px-5 py-4">
                <span className="num text-[11px] font-medium tracking-wider text-zinc-500">
                  02 · {t("home.settleNode2Tag")}
                </span>
                <div className="text-[15px] font-medium text-[var(--ink-strong)]">
                  <StableText k="home.settleNode2Title" block />
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">
                  <StableText k="home.settleNode2Sub" block />
                </p>
              </div>

              <div className="flex flex-col gap-1.5 px-5 py-4">
                <span className="num flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-[var(--yes)]">
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--yes)]" />
                  03 · {t("home.settleNode3Tag")}
                </span>
                <div className="text-[15px] font-medium text-[var(--ink-strong)]">
                  <StableText k="home.settleNode3Title" block />
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">
                  <StableText k="home.settleNode3Sub" block />
                </p>
              </div>
            </div>

            <div className="grid divide-y divide-[var(--hair)] border-t border-[var(--hair)] bg-[var(--seg-bg)] md:grid-cols-3 md:divide-x md:divide-y-0">
              <div className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs">
                <span className="text-zinc-500">
                  <StableText k="home.settleGuard1Label" />
                </span>
                <span className="font-medium text-[var(--yes)]">
                  <StableText k="home.settleGuard1Val" align="end" />
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs">
                <span className="text-zinc-500">
                  <StableText k="home.settleGuard2Label" />
                </span>
                <span className="font-medium text-[var(--warn)]">
                  <StableText k="home.settleGuard2Val" align="end" />
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs">
                <span className="text-zinc-500">
                  <StableText k="home.settleGuard3Label" />
                </span>
                <span className="font-medium text-zinc-300">
                  <StableText k="home.settleGuard3Val" align="end" />
                </span>
              </div>
            </div>
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section className="home-section">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="home-kicker flex items-center gap-2">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--yes)]" />
              <StableText k="home.live" />
            </h2>
            <DataFreshness
              updatedAt={updatedAt}
              refreshing={refreshing}
              staleError={isStaleError}
              onRefresh={() => void reload()}
            />
          </div>
          <div className="mt-5">
            {error && !live.length ? (
              <div className="surface flex flex-wrap items-center gap-3 p-5 text-[15px] text-zinc-400">
                <span>{t("markets.loadError", { error: localizeError(error) })}</span>
                <Button type="button" tone="secondary" className="h-8 px-3 text-[13px]" onClick={() => void reload()}>
                  <StableText k="common.tryAgain" align="center" />
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
                  <p className="text-[15px] text-zinc-400">
                    <StableText k="home.emptyLive" />
                  </p>
                  <Link href="/create">
                    <Button type="button" tone="secondary" className="h-8 px-3 text-[13px]">
                      <StableText k="markets.emptyCta" align="center" />
                    </Button>
                  </Link>
                </div>
                <div className="mt-5 border-t border-[var(--hair)] pt-5">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="home-kicker">
                      <StableText k="home.next" />
                    </span>
                    <span className="num text-[18px] text-white">{openAt ? formatStamp(openAt) : "\u2014"}</span>
                    {mountedNow ? (
                      <LiveCountdown expiry={openUnix} now={now} className="text-[18px] text-white" />
                    ) : (
                      <span className="num font-mono tabular-nums text-[18px] text-white">--:--:--</span>
                    )}
                  </div>
                  <div className="home-next-bar" aria-hidden>
                    <div
                      className="home-next-fill"
                      style={{ width: `${mountedNow ? (((now % 3600) / 3600) * 100).toFixed(2) : 0}%` }}
                    />
                  </div>
                  <p className="mt-3 text-[13px] text-zinc-500">
                    <StableText k="home.nextBody" block />
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>
      </Reveal>

      {merged ? null : (
        <Reveal>
          <section className="home-section">
            <h2 className="home-kicker">
              <StableText k="home.next" />
            </h2>
            <div className="home-next mt-5">
              <div className="num text-[22px] text-white">{openAt ? formatStamp(openAt) : "\u2014"}</div>
              <div className="mt-2">
                {mountedNow ? (
                  <LiveCountdown expiry={openUnix} now={now} className="text-[22px] text-white" />
                ) : (
                  <span className="num font-mono tabular-nums text-[22px] text-white">--:--:--</span>
                )}
              </div>
              <div className="home-next-bar" aria-hidden>
                <div
                  className="home-next-fill"
                  style={{ width: `${mountedNow ? (((now % 3600) / 3600) * 100).toFixed(2) : 0}%` }}
                />
              </div>
              <p className="mt-4 text-[15px] text-zinc-500">
                <StableText k="home.nextBody" block />
              </p>
            </div>
          </section>
        </Reveal>
      )}

      <Reveal>
        <section className="home-section">
          <h2 className="home-kicker">
            <StableText k="home.finished" />
          </h2>
          <div className="mt-5">
            {loading && !markets.length ? (
              <MarketTableSkeleton rows={3} />
            ) : finished.length ? (
              <div className="fade-in">
                <div className="home-fin-strip">
                  {finished.slice(0, 6).map((market) => (
                    <div key={market.address.toBase58()} className="home-fin-item">
                      <MarketCard market={market} />
                    </div>
                  ))}
                </div>
                {finished.length > 6 ? (
                  <div className="mt-3 text-right">
                    <Link href="/markets" className="link-accent text-[15px]">
                      <StableText k="home.viewAllFinished" align="end" /> →
                    </Link>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-[15px] text-zinc-500">
                <StableText k="home.emptyFinished" />
              </p>
            )}
          </div>
        </section>
      </Reveal>

      <section className="home-section home-why">
        <div className="grid gap-6 md:grid-cols-3">
          <div className="home-why-item">
            <div className="home-why-title">
              <StableText k="home.why1Title" block />
            </div>
            <p>
              <StableText k="home.why1" block />
            </p>
          </div>
          <div className="home-why-item">
            <div className="home-why-title">
              <StableText k="home.why2Title" block />
            </div>
            <p>
              <StableText k="home.why2" block />
            </p>
          </div>
          <div className="home-why-item">
            <div className="home-why-title">
              <StableText k="home.why3Title" block />
            </div>
            <p>
              <StableText k="home.why3" block />
            </p>
          </div>
        </div>
      </section>

      <Reveal>
        <section id="how" className="home-section scroll-mt-24">
          <h2 className="home-kicker">
            <StableText k="home.how" />
          </h2>
          <div className="mt-6 grid gap-6 md:grid-cols-3">
            <div className="home-how-card">
              <StableText k="home.how1" block />
            </div>
            <div className="home-how-card">
              <StableText k="home.how2" block />
            </div>
            <div className="home-how-card">
              <StableText k="home.how3" block />
            </div>
          </div>
          <p className="mt-6 grid text-[13px] leading-relaxed text-zinc-500">
            <span
              lang={locale === "zh" ? "en" : "zh-CN"}
              aria-hidden="true"
              className="pointer-events-none col-start-1 row-start-1 select-none invisible"
            >
              {reserveFees}
            </span>
            <span className="col-start-1 row-start-1">
              {feesLead.active}
              <Link href="/help" className="link-accent">
                {feesHelp.active}
              </Link>
              {feesTail.active}
            </span>
          </p>
        </section>
      </Reveal>

      <footer className="home-footer border-t border-[var(--hair)]">
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
          <StableText k="footer.github" />
        </a>
        <span className="home-footer-dot">·</span>
        <StableText k="home.footerNote" />
      </footer>
    </div>
  );
}
