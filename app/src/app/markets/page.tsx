"use client";

import { useMemo, useState } from "react";
import { useMarkets } from "@/hooks/use-markets";
import { useNow } from "@/hooks/use-now";
import { listSection, marketKind } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { MarketTable } from "@/components/market-table";
import { Button, StateBlock } from "@/components/ui";
import { useT } from "@/i18n/provider";

type Tape = "hot" | "history";

export default function MarketsPage() {
  const { markets, loading, error, reload } = useMarkets();
  const now = useNow(1000);
  const t = useT();
  const [tape, setTape] = useState<Tape>("hot");

  const groups = useMemo(() => {
    const live = markets.filter((m) => listSection(marketKind(m, now)) === "live");
    const next = markets.filter((m) => listSection(marketKind(m, now)) === "next");
    const ended = markets.filter((m) => listSection(marketKind(m, now)) === "ended");
    return { live, next, ended };
  }, [markets, now]);

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
    return <StateBlock kind="loading" title={t("markets.loading")} />;
  }

  const sections =
    tape === "hot"
      ? [
          { key: "live", title: t("markets.live"), rows: groups.live, emptyTitle: t("markets.emptyLiveTitle"), emptyBody: t("markets.emptyLiveBody") },
          { key: "next", title: t("markets.next"), rows: groups.next, emptyTitle: t("markets.emptyNextTitle"), emptyBody: t("markets.emptyNextBody") },
        ]
      : [{ key: "ended", title: t("markets.ended"), rows: groups.ended, emptyTitle: t("markets.emptyEndedTitle"), emptyBody: t("markets.emptyEndedBody") }];

  return (
    <div className="stack-5">
      <div className="flex items-end justify-between gap-3">
        <h1 className="text-xl font-medium text-white">{t("markets.title")}</h1>
        <div className="cluster-2 rounded-full border border-zinc-800 p-1">
          {(["hot", "history"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTape(id)}
              className={"rounded-full px-3 py-1 text-xs " + (tape === id ? "bg-white text-zinc-950" : "text-zinc-400")}
            >
              {t(id === "hot" ? "markets.hot" : "markets.history")}
            </button>
          ))}
        </div>
      </div>
      {sections.map((section) => (
        <section key={section.key} className="stack-3">
          <h2 className="text-sm font-medium text-zinc-300">{section.title}</h2>
          {section.rows.length ? (
            <MarketTable markets={section.rows} actionHref={tape === "history" ? "view" : "open"} />
          ) : (
            <StateBlock kind="empty" title={section.emptyTitle} body={section.emptyBody} />
          )}
        </section>
      ))}
    </div>
  );
}
