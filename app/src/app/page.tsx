"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useMarkets } from "@/hooks/use-markets";
import { useNow } from "@/hooks/use-now";
import { marketKind } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { PriceTape } from "@/components/price-tape";
import { MarketTable } from "@/components/market-table";
import { Button, StateBlock } from "@/components/ui";
import { useT } from "@/i18n/provider";

export default function HomePage() {
  const { markets, loading, error, reload } = useMarkets();
  const now = useNow(1000);
  const t = useT();

  const featured = useMemo(() => {
    return markets
      .filter((m) => marketKind(m, now) === "live")
      .sort((a, b) => (a.vault < b.vault ? 1 : -1))
      .slice(0, 3);
  }, [markets, now]);

  return (
    <div className="stack-6">
      <section className="max-w-2xl">
        <h1 className="text-xl font-medium tracking-tight text-zinc-100 md:text-2xl">{t("home.tagline")}</h1>
      </section>
      <PriceTape />
      <section className="stack-3">
        <div className="flex items-end justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-300">{t("home.featured")}</h2>
          <Link href="/markets">
            <Button type="button">{t("home.cta")}</Button>
          </Link>
        </div>
        {error ? (
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
        ) : loading && !markets.length ? (
          <StateBlock kind="loading" title={t("markets.loading")} />
        ) : featured.length ? (
          <MarketTable markets={featured} />
        ) : (
          <StateBlock kind="empty" title={t("home.emptyTitle")} body={t("home.emptyBody")} />
        )}
      </section>
    </div>
  );
}
