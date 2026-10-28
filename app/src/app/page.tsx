"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMarkets } from "@/hooks/use-markets";
import { useNow } from "@/hooks/use-now";
import { marketPhase } from "@/lib/markets";
import { MarketCard } from "@/components/market-card";
import { Button } from "@/components/ui";

type Filter = "live" | "pending" | "settled" | "all";

export default function HomePage() {
  const { markets, loading, error } = useMarkets();
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    return markets.filter((m) => {
      const phase = marketPhase(m, now);
      if (filter === "all") return true;
      if (filter === "live") return phase.live;
      if (filter === "pending") return m.status === "open" && phase.expired;
      return m.status === "resolved" || m.status === "burn";
    });
  }, [markets, filter, now]);

  const tabs: { id: Filter; label: string }[] = [
    { id: "live", label: "Live" },
    { id: "pending", label: "Pending" },
    { id: "settled", label: "Settled" },
    { id: "all", label: "All" },
  ];

  return (
    <div className="space-y-8">
      <section className="mx-auto max-w-2xl text-center">
        <div className="text-xs font-medium text-zinc-400">
          Veritas Markets · Binary Prediction Protocol on Solana
        </div>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-white md:text-5xl">
          Price the future.
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-zinc-400">
          Buy Yes or No with collateral. Constant-product AMM. After expiry an oracle resolves,
          and winners redeem 1:1.
        </p>
      </section>

      <div className="flex flex-wrap justify-center gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
              filter === tab.id
                ? "bg-white text-zinc-950"
                : "border border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-white"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-400">
          Failed to load markets: {error}
          <div className="mt-2 text-zinc-400">Check the RPC in Settings. The program is already on Devnet.</div>
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-64 animate-pulse rounded-2xl border border-zinc-800/80 bg-zinc-900/40" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-800 p-12 text-center">
          <div className="text-2xl font-bold tracking-tight text-white">No markets yet</div>
          <p className="mt-2 text-sm text-zinc-400">Create one on Devnet and it will appear here.</p>
          <Link href="/create" className="mt-6 inline-block">
            <Button>Create market</Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((market) => (
            <MarketCard key={market.address.toBase58()} market={market} />
          ))}
        </div>
      )}
    </div>
  );
}
