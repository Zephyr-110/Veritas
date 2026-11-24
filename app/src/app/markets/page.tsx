"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMarkets, useMarketPhaseTime } from "@/hooks/use-markets";
import { listSection, marketKind, questionTitle } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { MarketTable } from "@/components/market-table";
import { MarketsSkeleton } from "@/components/skeletons";
import { SimOrderPreview } from "@/components/sim-preview";
import { Button, DataFreshness, Reveal, StableText, StateBlock, onSpot } from "@/components/ui";
import { TickingCountdown } from "@/components/live";
import { useEffectivePublicKey } from "@/components/guest-session";
import { useT } from "@/i18n/provider";
import type { MarketView } from "@/lib/markets";

type Tape = "hot" | "history";

export default function MarketsPage() {
  const publicKey = useEffectivePublicKey();
  const { markets, loading, refreshing, updatedAt, isStaleError, error, reload } = useMarkets();
  const now = useMarketPhaseTime(markets);
  const t = useT();
  const [tape, setTape] = useState<Tape>("hot");
  const [historyLimit, setHistoryLimit] = useState(30);
  const showSim = !publicKey && !loading && markets.filter((m) => listSection(marketKind(m, now)) === "live").length === 0;

  useEffect(() => {
    if (!showSim || typeof window === "undefined" || window.location.hash !== "#sim-preview") return;
    const raf = window.requestAnimationFrame(() => {
      document.getElementById("sim-preview")?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [showSim]);

  const groups = useMemo(() => {
    const live = markets.filter((m) => listSection(marketKind(m, now)) === "live").sort((a, b) => a.expiry - b.expiry);
    const next = markets.filter((m) => listSection(marketKind(m, now)) === "next").sort((a, b) => a.expiry - b.expiry);
    const ended = markets.filter((m) => listSection(marketKind(m, now)) === "ended").sort((a, b) => b.expiry - a.expiry);
    return { live, next, ended };
  }, [markets, now]);

  const nextMarket: MarketView | null = groups.next[0] ?? null;
  const currentLive = [...groups.live].sort((a, b) => a.expiry - b.expiry)[0] ?? null;

  if (error && !markets.length) {
    return (
      <StateBlock
        kind="error"
        title={t("markets.loadError", { error: localizeError(error) })}
        body={<StableText k="markets.loadHint" block />}
        action={
          <Button type="button" tone="secondary" onClick={() => void reload()}>
            <StableText k="common.tryAgain" align="center" />
          </Button>
        }
      />
    );
  }

  if (loading && !markets.length) {
    return <MarketsSkeleton />;
  }

  const endedPreview =
    tape === "hot" && groups.live.length === 0 && groups.next.length === 0 && groups.ended.length > 0;
  const sections =
    tape === "hot"
      ? [
          {
            key: "live",
            titleKey: "markets.live",
            rows: groups.live,
            emptyTitleKey: "markets.emptyLiveTitle",
            emptyBodyKey: "markets.emptyLiveBody",
          },
          ...(endedPreview
            ? [
                {
                  key: "ended",
                  titleKey: "markets.ended" as const,
                  rows: groups.ended,
                  emptyTitleKey: "markets.emptyEndedTitle" as const,
                  emptyBodyKey: "markets.emptyEndedBody" as const,
                },
              ]
            : groups.next.length > 0
              ? [
                  {
                    key: "next",
                    titleKey: "markets.next" as const,
                    rows: groups.next,
                    emptyTitleKey: "markets.emptyNextTitle" as const,
                    emptyBodyKey: "markets.emptyNextBody" as const,
                  },
                ]
              : []),
        ]
      : [
          {
            key: "ended",
            titleKey: "markets.ended",
            rows: groups.ended,
            emptyTitleKey: "markets.emptyEndedTitle",
            emptyBodyKey: "markets.emptyEndedBody",
          },
        ];

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
            {(["hot", "history"] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setTape(id)}
                className={
                  "px-3 py-1 text-xs " +
                  (tape === id ? "seg-on font-medium" : "text-zinc-400 hover:text-white")
                }
              >
                <StableText k={id === "hot" ? "markets.hot" : "markets.history"} align="center" />
              </button>
            ))}
          </div>
        </div>
        <Reveal>
          <div className="stack-5">
            {sections.map((section) => (
              <section key={section.key} className="stack-3">
                <h2 className="section-title">
                  <StableText k={section.titleKey} />
                </h2>
                {section.rows.length ? (
                  <MarketTable markets={section.key === "ended" ? section.rows.slice(0, historyLimit) : section.rows} />
                ) : (
                  <StateBlock
                    kind="empty"
                    title={<StableText k={section.emptyTitleKey} />}
                    body={<StableText k={section.emptyBodyKey} block />}
                    action={
                      section.key === "next" && groups.live.length === 0 ? undefined : (
                        <Link href="/create">
                          <Button type="button" tone={section.key === "live" ? "primary" : "secondary"}>
                            <StableText k="markets.emptyCta" align="center" />
                          </Button>
                        </Link>
                      )
                    }
                  />
                )}
                {section.key === "ended" && section.rows.length > historyLimit && (
                  <Button type="button" tone="secondary" onClick={() => setHistoryLimit((n) => n + 30)}>
                    <StableText k="markets.loadMore" />
                  </Button>
                )}
              </section>
            ))}
          </div>
        </Reveal>
        {!publicKey && groups.live.length === 0 ? (
          <Reveal>
            <SimOrderPreview />
          </Reveal>
        ) : null}
      </div>
      <aside className="desk-rail stack-4 enter-side">
        <Reveal>
          <div onMouseMove={onSpot} className="surface p-5 stack-3">
            <div className="section-title">
              <StableText k={nextMarket ? "markets.nextRound" : "markets.thisRound"} />
            </div>
            {nextMarket ? (
              <>
                <div className="line-clamp-2 leading-snug text-sm text-white">{questionTitle(nextMarket)}</div>
                <div className="text-right">
                  <TickingCountdown expiry={nextMarket.expiry} className="text-[28px] num-accent" />
                </div>
              </>
            ) : currentLive ? (
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
