"use client";

import Link from "next/link";
import { useMemo, type CSSProperties } from "react";
import { useMarketPhaseTime, useMarketsPage } from "@/hooks/use-markets";
import { listSection, marketKind, questionTitle } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { ORACLE_CENSUS_URL } from "@/lib/constants";
import type { MarketView } from "@/lib/markets";
import { DemoVideo } from "@/components/demo-video";
import { PricePanel } from "@/components/price-tape";
import { MarketTable } from "@/components/market-table";
import { MarketCard } from "@/components/market-card";
import { MarketTableSkeleton } from "@/components/skeletons";
import { Button, DataFreshness, Reveal, StableText, onSpot } from "@/components/ui";
import { TickingCountdown } from "@/components/live";
import { useGuestSession } from "@/components/guest-session";
import { useLocale, useT } from "@/i18n/provider";
import { tPair } from "@/i18n/store";

export default function HomePage() {
  const {
    hydrated,
    mode,
    effectivePublicKey: publicKey,
    hasSavedKey,
    entering,
    locked,
    lastError,
    enterSandbox,
  } = useGuestSession();
  const liveQuery = useMarketsPage({ section: "live", duration: "all", page: 1, pageSize: 20 });
  const endedQuery = useMarketsPage({ section: "ended", duration: "all", page: 1, pageSize: 12 });
  const now = useMarketPhaseTime(liveQuery.markets);
  const t = useT();
  const locale = useLocale();
  const mountedNow = now > 0;

  const live = useMemo(
    () =>
      mountedNow
        ? liveQuery.markets
            .filter((market) => marketKind(market, now) === "live")
            .sort((a, b) => a.expiry - b.expiry)
        : [],
    [liveQuery.markets, mountedNow, now]
  );
  const nextMarket = null as MarketView | null;
  const preview = useMemo(
    () =>
      mountedNow
        ? endedQuery.markets
            .filter((market) => listSection(marketKind(market, now)) === "ended")
            .sort((a, b) => b.expiry - a.expiry)
            .slice(0, 12)
        : [],
    [endedQuery.markets, mountedNow, now]
  );
  const refreshing = liveQuery.refreshing || endedQuery.refreshing;
  const updatedAt = liveQuery.updatedAt ?? endedQuery.updatedAt;
  const isStaleError = liveQuery.isStaleError || endedQuery.isStaleError;
  const error = liveQuery.error ?? endedQuery.error;
  const reload = async () => {
    await Promise.all([liveQuery.reload(), endedQuery.reload()]);
  };
  const merged = !liveQuery.loading && !liveQuery.error && live.length === 0;

  const feesLead = tPair("home.howFeesLead", undefined, locale);
  const feesHelp = tPair("home.howHelp", undefined, locale);
  const feesTail = tPair("home.howFeesTail", undefined, locale);
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
              <div className="fade-in flex items-center justify-start gap-2 text-[12px] font-medium tracking-[0.12em] text-zinc-400">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--yes)]" />
                <StableText k="home.badge" />
              </div>
              <h1 className="mt-4">
                <span className="line-mask">
                  <span className="line-inner mh-title" style={{ animationDelay: "40ms" }}>
                    <StableText k="home.titleA" align="start" />
                  </span>
                </span>
                <span className="line-mask">
                  <span className="line-inner mh-title" style={{ animationDelay: "90ms" }}>
                    <StableText k="home.titleB" align="start" />
                  </span>
                </span>
              </h1>
            </div>
            <div className="mt-6 flex flex-col items-start">
              <p className="home-sub rise-in text-left" style={{ animationDelay: "130ms" }}>
                <StableText k="home.subtitle" block />
              </p>
              <div
                className="rise-in mt-7 flex flex-wrap justify-start gap-3"
                style={{ animationDelay: "180ms" }}
              >
                <Link href="/markets">
                  <Button type="button" className="h-11 px-6">
                    <StableText k="home.cta" align="center" />
                  </Button>
                </Link>
                {mode === "none" ? (
                  <Button
                    type="button"
                    tone="secondary"
                    className="h-11 px-6"
                    busy={entering}
                    disabled={locked}
                    onClick={() => void enterSandbox()}
                  >
                    <StableText
                      k={hasSavedKey ? "sandbox.resumeAction" : "sandbox.enterAction"}
                      align="center"
                    />
                  </Button>
                ) : null}
                <Link href="#how">
                  <Button type="button" tone="secondary" className="h-11 px-6">
                    <StableText k="home.howCta" align="center" />
                  </Button>
                </Link>
              </div>
              {mode === "none" && lastError ? (
                <p
                  role="alert"
                  className="mt-3 max-w-lg border border-[var(--no)]/45 bg-[var(--no-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--no)] lg:text-left"
                >
                  {lastError}
                </p>
              ) : null}
            </div>
          </div>
          <PricePanel />
        </div>
      </section>

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
            ) : liveQuery.loading && !liveQuery.markets.length ? (
              <MarketTableSkeleton rows={4} />
            ) : live.length ? (
              <div className="fade-in stack-3">
                {hydrated && !publicKey ? (
                  <p className="text-xs text-zinc-400">
                    <StableText k="home.simLiveHint" block />
                  </p>
                ) : null}
                <MarketTable markets={live} useIndexedVault />
              </div>
            ) : (
              <div className="surface fade-in p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-[15px] text-zinc-400">
                    <StableText k="home.emptyLive" />
                  </p>
                  {hydrated && !publicKey ? (
                    <Link href="/markets#sim-preview">
                      <Button type="button" tone="primary" className="h-8 px-3 text-[13px]">
                        <StableText k="home.simCta" align="center" />
                      </Button>
                    </Link>
                  ) : null}
                  <Link href="/create">
                    <Button type="button" tone="secondary" className="h-8 px-3 text-[13px]">
                      <StableText k="markets.emptyCta" align="center" />
                    </Button>
                  </Link>
                </div>
                {nextMarket ? (
                  <div className="mt-5 border-t border-[var(--hair)] pt-5">
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span className="home-kicker">
                        <StableText k="home.next" />
                      </span>
                      <Link
                        href={`/markets/${nextMarket.address.toBase58()}`}
                        className="link-accent text-[15px] text-white"
                      >
                        {questionTitle(nextMarket)}
                      </Link>
                      {mountedNow ? (
                        <TickingCountdown expiry={nextMarket.expiry} className="text-[18px] text-white" />
                      ) : null}
                    </div>
                    <p className="mt-3 text-[13px] text-zinc-500">
                      <StableText k="home.nextBody" block />
                    </p>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section className="py-3">
          <div onMouseMove={onSpot} className="surface overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hair)] px-5 py-3">
              <span className="home-kicker flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                <StableText k="home.settleKicker" />
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-zinc-400">
                  <StableText k="home.settleRuleTag" align="end" />
                </span>
                <Link
                  href="/help#settlement"
                  className="link-accent inline-flex items-center text-xs"
                >
                  <StableText k="home.whyMore" />
                </Link>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hair)] bg-[var(--seg-bg)] px-5 py-2.5 text-xs">
              <a href={ORACLE_CENSUS_URL} className="link-accent">
                <StableText k="home.settleCensusLabel" />
              </a>
              <span className="num font-semibold text-white">
                <StableText k="home.settleCensusValue" align="end" />
              </span>
            </div>

            <div className="grid divide-y divide-[var(--hair)] md:grid-cols-3 md:divide-x md:divide-y-0">
              <div className="flex flex-col gap-1.5 px-5 py-4">
                <span className="num flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-[var(--yes)]">
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--yes)]" />
                  <StableText k="home.settleNode1Tag" />
                </span>
                <div className="text-[15px] font-medium text-[var(--ink-strong)]">
                  <StableText k="home.settleNode1Title" block />
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">
                  <StableText k="home.settleNode1Sub" block />
                </p>
              </div>

              <div className="flex flex-col gap-1.5 px-5 py-4">
                <span className="num text-[11px] font-medium tracking-wider text-zinc-400">
                  <StableText k="home.settleNode2Tag" />
                </span>
                <div className="text-[15px] font-medium text-[var(--ink-strong)]">
                  <StableText k="home.settleNode2Title" block />
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">
                  <StableText k="home.settleNode2Sub" block />
                </p>
              </div>

              <div className="flex flex-col gap-1.5 px-5 py-4">
                <span className="num text-[11px] font-medium tracking-wider text-zinc-500">
                  <StableText k="home.settleNode3Tag" />
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

      <DemoVideo />

      {merged || !nextMarket ? null : (
        <Reveal>
          <section className="home-section">
            <h2 className="home-kicker">
              <StableText k="home.next" />
            </h2>
            <div className="home-next mt-5">
              <Link
                href={`/markets/${nextMarket.address.toBase58()}`}
                className="link-accent block text-[17px] font-medium text-white"
              >
                {questionTitle(nextMarket)}
              </Link>
              <div className="mt-2">
                {mountedNow ? (
                  <TickingCountdown expiry={nextMarket.expiry} className="text-[22px] text-white" />
                ) : (
                  <span className="num font-mono tabular-nums text-[22px] text-white">--:--:--</span>
                )}
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
            {endedQuery.loading && !endedQuery.markets.length ? (
              <MarketTableSkeleton rows={3} />
            ) : preview.length ? (
              <div className="fade-in">
                {preview.length >= 2 ? (
                  <div className="home-fin-marquee">
                    <div
                      className="home-fin-track"
                      style={{ "--fin-dur": `${Math.max(24, preview.length * 6)}s` } as CSSProperties}
                    >
                      <div className="home-fin-group">
                        {preview.map((market) => (
                          <div key={market.address.toBase58()} className="home-fin-item">
                            <MarketCard market={market} vault={market.vault} />
                          </div>
                        ))}
                      </div>
                      <div className="home-fin-group home-fin-dup" aria-hidden="true">
                        {preview.map((market) => (
                          <div key={`dup-${market.address.toBase58()}`} className="home-fin-item">
                            <MarketCard market={market} vault={market.vault} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="home-fin-strip">
                    {preview.map((market) => (
                      <div key={market.address.toBase58()} className="home-fin-item">
                        <MarketCard market={market} vault={market.vault} />
                      </div>
                    ))}
                  </div>
                )}
                {endedQuery.total > 6 ? (
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
            <Link
              href="/help#permissionless"
              className="link-accent mt-auto inline-flex self-start pt-3 items-center text-xs"
            >
              <StableText k="home.whyMore" />
            </Link>
          </div>
          <div className="home-why-item">
            <div className="home-why-title">
              <StableText k="home.why2Title" block />
            </div>
            <p>
              <StableText k="home.why2" block />
            </p>
            <Link
              href="/help#settlement"
              className="link-accent mt-auto inline-flex self-start pt-3 items-center text-xs"
            >
              <StableText k="home.whyMore" />
            </Link>
          </div>
          <div className="home-why-item">
            <div className="home-why-title">
              <StableText k="home.why3Title" block />
            </div>
            <p>
              <StableText k="home.why3" block />
            </p>
            <Link
              href="/help#pm-amm"
              className="link-accent mt-auto inline-flex self-start pt-3 items-center text-xs"
            >
              <StableText k="home.whyMore" />
            </Link>
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
              <span className="num mb-3 inline-flex h-7 w-7 items-center justify-center border border-[var(--line)] bg-[var(--seg-bg)] text-xs font-semibold text-white">
                01
              </span>
              <StableText k="home.how1" block />
            </div>
            <div className="home-how-card">
              <span className="num mb-3 inline-flex h-7 w-7 items-center justify-center border border-[var(--line)] bg-[var(--seg-bg)] text-xs font-semibold text-white">
                02
              </span>
              <StableText k="home.how2" block />
            </div>
            <div className="home-how-card">
              <span className="num mb-3 inline-flex h-7 w-7 items-center justify-center border border-[var(--line)] bg-[var(--seg-bg)] text-xs font-semibold text-white">
                03
              </span>
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
    </div>
  );
}
