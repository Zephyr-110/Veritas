"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMarkets } from "@/hooks/use-markets";
import { useNow } from "@/hooks/use-now";
import { listSection, marketKind } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { MarketTable } from "@/components/market-table";
import { MarketsSkeleton } from "@/components/skeletons";
import { Button, StateBlock } from "@/components/ui";
import { LiveCountdown } from "@/components/live";
import { useT } from "@/i18n/provider";
import type { MarketView } from "@/lib/markets";

type Tape = "hot" | "history";

export default function MarketsPage() {
  const { markets, loading, error, reload } = useMarkets();
  const now = useNow(1000);
  const t = useT();
  const [tape, setTape] = useState<Tape>("hot");

  const groups = useMemo(() => {
    const live = markets.filter((m) => listSection(marketKind(m, now)) === "live");
    const next = markets.filter((m) => listSection(marketKind(m, now)) === "next").sort((a, b) => a.expiry - b.expiry);
    const ended = markets.filter((m) => listSection(marketKind(m, now)) === "ended");
    return { live, next, ended };
  }, [markets, now]);

  const nextMarket: MarketView | null = groups.next[0] ?? null;
  const currentLive = [...groups.live].sort((a, b) => a.expiry - b.expiry)[0] ?? null;

  if (error) {
    return (
      <StateBlock
        kind="error"
        title={t("markets.loadError", { error: localizeError(error) })}
        body={t("markets.loadHint")}
        action={
          <Button type="button" tone="secondary" onClick={() => void reload()}>
            {t("common.tryAgain")}
          </Button>
        }
      />
    );
  }

  if (loading && !markets.length) {
    return <MarketsSkeleton />;
  }

  const sections =
    tape === "hot"
      ? [
          { key: "live", title: t("markets.live"), rows: groups.live, emptyTitle: t("markets.emptyLiveTitle"), emptyBody: t("markets.emptyLiveBody") },
          { key: "next", title: t("markets.next"), rows: groups.next, emptyTitle: t("markets.emptyNextTitle"), emptyBody: t("markets.emptyNextBody") },
        ]
      : [{ key: "ended", title: t("markets.ended"), rows: groups.ended, emptyTitle: t("markets.emptyEndedTitle"), emptyBody: t("markets.emptyEndedBody") }];

  return (
    <div className="split split-markets">
      <div className="stack-5 fade-in">
        <div className="flex items-end justify-between gap-3">
          <h1 className="page-title">{t("markets.title")}</h1>
          <div className="cluster-2 rounded-full border border-zinc-800 p-1">
            {(["hot", "history"] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setTape(id)}
                className={"rounded-full px-3 py-1 text-xs " + (tape === id ? "bg-accent text-zinc-950" : "text-zinc-400")}
              >
                {t(id === "hot" ? "markets.hot" : "markets.history")}
              </button>
            ))}
          </div>
        </div>
        {sections.map((section) => (
          <section key={section.key} className="stack-3">
            <h2 className="section-title">{section.title}</h2>
            {section.rows.length ? (
              <MarketTable markets={section.rows} actionHref={tape === "history" ? "view" : "open"} />
            ) : (
              <StateBlock
                kind="empty"
                title={section.emptyTitle}
                body={section.emptyBody}
                action={
                  <Link href="/create">
                    <Button type="button">{t("markets.emptyCta")}</Button>
                  </Link>
                }
              />
            )}
          </section>
        ))}
      </div>
      <aside className="desk-rail stack-4">
        <div className="surface p-4 stack-3">
          <div className="section-title">{nextMarket ? t("markets.nextRound") : t("markets.thisRound")}</div>
          {nextMarket ? (
            <>
              <div className="truncate text-sm text-white">{nextMarket.title}</div>
              <div className="text-right">
                <LiveCountdown expiry={nextMarket.expiry} now={now} className="text-[28px] num-accent" />
              </div>
            </>
          ) : currentLive ? (
            <>
              <div className="truncate text-sm text-white">{currentLive.title}</div>
              <div className="text-right">
                <LiveCountdown expiry={currentLive.expiry} now={now} className="text-[28px] num-accent" />
              </div>
            </>
          ) : (
            <p className="text-sm text-zinc-500">{t("markets.noNext")}</p>
          )}
        </div>
        <div className="surface p-4 stack-3">
          <div className="section-title">{t("markets.rulesTitle")}</div>
          <p className="text-[15px] leading-relaxed text-zinc-400">{t("markets.rule1")}</p>
          <p className="text-[15px] leading-relaxed text-zinc-400">{t("markets.rule2")}</p>
          <p className="text-[15px] leading-relaxed text-zinc-400">{t("markets.rule3")}</p>
          <Link href="/help" className="link-accent text-[15px]">
            {t("markets.rulesMore")}
          </Link>
        </div>
      </aside>
    </div>
  );
}
