"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMarketPhaseTime, useMarketsInfinite, useMarketsPage } from "@/hooks/use-markets";
import { listSection, marketKind, questionTitle, type DurationFilter } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { MarketTable } from "@/components/market-table";
import { MarketsSkeleton } from "@/components/skeletons";
import { SimOrderPreview } from "@/components/sim-preview";
import { Button, DataFreshness, Reveal, StableText, StateBlock, onSpot } from "@/components/ui";
import { TickingCountdown } from "@/components/live";
import { useEffectivePublicKey } from "@/components/guest-session";
import { useT } from "@/i18n/provider";
import type { MarketView } from "@/lib/markets";

type Tape = "hot" | "unsettled" | "history";

const DURATION_FILTERS: ReadonlyArray<{
  id: DurationFilter;
  labelKey:
    | "markets.filterAll"
    | "markets.filter2m"
    | "markets.filter15m"
    | "markets.filter24h"
    | "markets.filterOther";
}> = [
  { id: "all", labelKey: "markets.filterAll" },
  { id: "2m", labelKey: "markets.filter2m" },
  { id: "15m", labelKey: "markets.filter15m" },
  { id: "24h", labelKey: "markets.filter24h" },
  { id: "other", labelKey: "markets.filterOther" },
];

const PAGE_SIZE = 30;

export default function MarketsPage() {
  const publicKey = useEffectivePublicKey();
  const t = useT();
  const [tape, setTape] = useState<Tape>("hot");
  const [duration, setDuration] = useState<DurationFilter>("all");

  const liveQuery = useMarketsPage({
    section: "live",
    duration,
    page: 1,
    pageSize: PAGE_SIZE,
    enabled: tape === "hot",
  });
  const railLiveQuery = useMarketsPage({
    section: "live",
    duration: "all",
    page: 1,
    pageSize: 1,
    enabled: tape !== "hot" || duration !== "all",
  });
  const unsettledQuery = useMarketsInfinite({
    section: "unsettled",
    duration,
    pageSize: PAGE_SIZE,
    enabled: tape === "unsettled",
  });

  const phaseSource = useMemo(
    () =>
      tape === "hot"
        ? liveQuery.markets
        : tape === "unsettled"
          ? unsettledQuery.markets
          : railLiveQuery.markets,
    [liveQuery.markets, unsettledQuery.markets, railLiveQuery.markets, tape]
  );
  const now = useMarketPhaseTime(phaseSource);

  const liveMarkets = useMemo(
    () =>
      liveQuery.markets
        .filter((m) => listSection(marketKind(m, now)) === "live")
        .sort((a, b) => a.expiry - b.expiry),
    [liveQuery.markets, now]
  );

  const unsettledMarkets = useMemo(
    () =>
      unsettledQuery.markets
        .filter((m) => listSection(marketKind(m, now)) === "unsettled")
        .sort((a, b) => b.expiry - a.expiry),
    [unsettledQuery.markets, now]
  );

  const historyEnabled =
    tape === "history" || (tape === "hot" && !liveQuery.loading && liveMarkets.length === 0);
  const historyQuery = useMarketsInfinite({
    section: "ended",
    duration,
    pageSize: PAGE_SIZE,
    enabled: historyEnabled,
  });

  const endedMarkets = useMemo(
    () =>
      historyQuery.markets
        .filter((m) => listSection(marketKind(m, now)) === "ended")
        .sort((a, b) => b.expiry - a.expiry),
    [historyQuery.markets, now]
  );

  const railSource = tape === "hot" && duration === "all" ? liveQuery : railLiveQuery;
  const railLiveMarkets = useMemo(
    () =>
      railSource.markets
        .filter((m) => listSection(marketKind(m, now)) === "live")
        .sort((a, b) => a.expiry - b.expiry),
    [now, railSource.markets]
  );

  const showSim = !publicKey && !railSource.loading && railLiveMarkets.length === 0;

  useEffect(() => {
    if (!showSim || typeof window === "undefined" || window.location.hash !== "#sim-preview") return;
    const raf = window.requestAnimationFrame(() => {
      document.getElementById("sim-preview")?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [showSim]);

  const currentLive: MarketView | null = railLiveMarkets[0] ?? null;

  const activeError =
    tape === "hot"
      ? liveQuery.error
      : tape === "unsettled"
        ? unsettledQuery.error
        : historyQuery.error;
  const hasAnyRows =
    tape === "hot"
      ? liveMarkets.length > 0 || endedMarkets.length > 0
      : tape === "unsettled"
        ? unsettledMarkets.length > 0
        : endedMarkets.length > 0;
  const initialLoading =
    tape === "hot"
      ? (liveQuery.loading && !liveQuery.markets.length) ||
        (historyEnabled && liveMarkets.length === 0 && historyQuery.loading && !historyQuery.markets.length)
      : tape === "unsettled"
        ? unsettledQuery.loading && !unsettledQuery.markets.length
        : historyQuery.loading && !historyQuery.markets.length;

  const reload = async () => {
    await Promise.all([
      tape === "hot" ? liveQuery.reload() : Promise.resolve(),
      tape === "unsettled" ? unsettledQuery.reload() : Promise.resolve(),
      historyEnabled ? historyQuery.reload() : Promise.resolve(),
      tape !== "hot" || duration !== "all" ? railLiveQuery.reload() : Promise.resolve(),
    ]);
  };

  if (activeError && !hasAnyRows) {
    return (
      <StateBlock
        kind="error"
        title={t("markets.loadError", { error: localizeError(activeError) })}
        body={<StableText k="markets.loadHint" block />}
        action={
          <Button type="button" tone="secondary" onClick={() => void reload()}>
            <StableText k="common.tryAgain" align="center" />
          </Button>
        }
      />
    );
  }

  if (initialLoading && !hasAnyRows) {
    return <MarketsSkeleton />;
  }

  const endedPreview = tape === "hot" && liveMarkets.length === 0 && endedMarkets.length > 0;
  type SectionSpec = {
    key: "live" | "unsettled" | "ended";
    titleKey: "markets.live" | "markets.unsettled" | "markets.ended";
    rows: MarketView[];
    emptyTitleKey: "markets.emptyLiveTitle" | "markets.emptyUnsettledTitle" | "markets.emptyEndedTitle";
    emptyBodyKey?: "markets.emptyLiveBody" | "markets.emptyEndedBody";
  };
  const sections: SectionSpec[] =
    tape === "hot"
      ? [
          {
            key: "live",
            titleKey: "markets.live",
            rows: liveMarkets,
            emptyTitleKey: "markets.emptyLiveTitle",
            emptyBodyKey: "markets.emptyLiveBody",
          },
          ...(endedPreview
            ? [
                {
                  key: "ended" as const,
                  titleKey: "markets.ended" as const,
                  rows: endedMarkets,
                  emptyTitleKey: "markets.emptyEndedTitle" as const,
                  emptyBodyKey: "markets.emptyEndedBody" as const,
                },
              ]
            : []),
        ]
      : tape === "unsettled"
        ? [
            {
              key: "unsettled",
              titleKey: "markets.unsettled",
              rows: unsettledMarkets,
              emptyTitleKey: "markets.emptyUnsettledTitle",
            },
          ]
        : [
            {
              key: "ended",
              titleKey: "markets.ended",
              rows: endedMarkets,
              emptyTitleKey: "markets.emptyEndedTitle",
              emptyBodyKey: "markets.emptyEndedBody",
            },
          ];

  const updatedAt =
    tape === "hot"
      ? liveQuery.updatedAt ?? historyQuery.updatedAt
      : tape === "unsettled"
        ? unsettledQuery.updatedAt
        : historyQuery.updatedAt;
  const refreshing =
    tape === "hot"
      ? liveQuery.refreshing || historyQuery.refreshing
      : tape === "unsettled"
        ? unsettledQuery.refreshing
        : historyQuery.refreshing;
  const isStaleError =
    tape === "hot"
      ? liveQuery.isStaleError || historyQuery.isStaleError
      : tape === "unsettled"
        ? unsettledQuery.isStaleError
        : historyQuery.isStaleError;

  return (
    <div className="split split-markets">
      <div className="stack-5 enter-up">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="stack-1">
            <h1 className="page-title">
              <StableText k="markets.title" />
            </h1>
            <DataFreshness
              updatedAt={updatedAt}
              refreshing={refreshing}
              staleError={isStaleError}
              onRefresh={() => void reload()}
            />
          </div>
          <div className="cluster-2 seg-slot p-1">
            {(["hot", "unsettled", "history"] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setTape(id)}
                className={
                  "px-3 py-1 text-xs " +
                  (tape === id ? "seg-on font-medium" : "text-zinc-400 hover:text-white")
                }
              >
                <StableText
                  k={id === "hot" ? "markets.hot" : id === "unsettled" ? "markets.unsettled" : "markets.history"}
                  align="center"
                />
              </button>
            ))}
          </div>
        </div>
        <div className="cluster-2 flex-wrap" role="group" aria-label={t("markets.title")}>
          {DURATION_FILTERS.map((chip) => {
            const active = duration === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                aria-pressed={active}
                onClick={() => setDuration(chip.id)}
                className={
                  "border px-3 py-1 text-xs transition-colors " +
                  (active
                    ? "border-[var(--line)] bg-[var(--seg-bg)] font-medium text-white"
                    : "border-[var(--hair)] text-zinc-400 hover:border-[var(--line)] hover:text-white")
                }
              >
                <StableText k={chip.labelKey} align="center" />
              </button>
            );
          })}
        </div>
        <Reveal>
          <div className="stack-5">
            {sections.map((section) => (
              <section key={section.key} className="stack-3">
                <h2 className="section-title">
                  <StableText k={section.titleKey} />
                </h2>
                {section.rows.length ? (
                  <MarketTable markets={section.rows} useIndexedVault />
                ) : (
                  <StateBlock
                    kind="empty"
                    title={<StableText k={section.emptyTitleKey} />}
                    body={section.emptyBodyKey ? <StableText k={section.emptyBodyKey} block /> : undefined}
                    action={
                      duration !== "all" ? (
                        <Button type="button" tone="secondary" onClick={() => setDuration("all")}>
                          <StableText k="markets.clearFilter" align="center" />
                        </Button>
                      ) : section.key === "unsettled" ? undefined : (
                        <Link href="/create">
                          <Button type="button" tone={section.key === "live" ? "primary" : "secondary"}>
                            <StableText k="markets.emptyCta" align="center" />
                          </Button>
                        </Link>
                      )
                    }
                  />
                )}
                {section.key === "unsettled" && unsettledQuery.hasMore && (
                  <Button
                    type="button"
                    tone="secondary"
                    busy={unsettledQuery.loadingMore}
                    onClick={() => void unsettledQuery.loadMore()}
                  >
                    <StableText k="markets.loadMore" />
                  </Button>
                )}
                {section.key === "ended" && historyQuery.hasMore && (
                  <Button
                    type="button"
                    tone="secondary"
                    busy={historyQuery.loadingMore}
                    onClick={() => void historyQuery.loadMore()}
                  >
                    <StableText k="markets.loadMore" />
                  </Button>
                )}
              </section>
            ))}
          </div>
        </Reveal>
        {!publicKey && railLiveMarkets.length === 0 ? (
          <Reveal>
            <SimOrderPreview />
          </Reveal>
        ) : null}
      </div>
      <aside className="desk-rail stack-4 enter-side">
        <Reveal>
          <div onMouseMove={onSpot} className="surface p-5 stack-3">
            <div className="section-title">
              <StableText k="markets.thisRound" />
            </div>
            {currentLive ? (
              <>
                <div className="line-clamp-2 leading-snug text-sm text-white">{questionTitle(currentLive)}</div>
                <div className="text-right">
                  <TickingCountdown expiry={currentLive.expiry} className="text-[28px] num-accent" />
                </div>
              </>
            ) : (
              <p className="text-sm text-zinc-500">
                <StableText k="markets.noNext" block />
              </p>
            )}
          </div>
        </Reveal>
        <Reveal>
          <div onMouseMove={onSpot} className="surface p-5 stack-3">
            <div className="section-title">
              <StableText k="markets.rulesTitle" />
            </div>
            <p className="text-[14px] leading-relaxed text-zinc-400">
              <StableText k="markets.rule1" block />
            </p>
            <p className="text-[14px] leading-relaxed text-zinc-400">
              <StableText k="markets.rule2" block />
            </p>
            <p className="text-[14px] leading-relaxed text-zinc-400">
              <StableText k="markets.rule3" block />
            </p>
            <Link href="/help" className="link-accent text-[14px]">
              <StableText k="markets.rulesMore" />
            </Link>
          </div>
        </Reveal>
      </aside>
    </div>
  );
}
