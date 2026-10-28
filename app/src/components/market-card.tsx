"use client";

import Link from "next/link";
import { countdown, formatUnix, toUi } from "@/lib/format";
import { marketPhase, type MarketView } from "@/lib/markets";
import { useNow } from "@/hooks/use-now";
import { Chip, StatusChip } from "./ui";

function sidePercents(yesPrice: number): { yes: number; no: number } {
  const raw = Number.isFinite(yesPrice) ? yesPrice : 0.5;
  const yes = Math.max(0, Math.min(100, Math.round(raw * 100)));
  return { yes, no: 100 - yes };
}

export function MarketCard({ market }: { market: MarketView }) {
  const now = useNow(1000);
  const phase = marketPhase(market, now);
  const { yes, no } = sidePercents(market.yesPrice);
  const href = `/m/${market.address.toBase58()}`;
  const liq = toUi(market.vault, market.decimals);
  const timeLabel = phase.live
    ? `⏱ ${countdown(market.expiry, now)} left`
    : formatUnix(market.expiry);

  return (
    <article className="flex h-full flex-col rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5 backdrop-blur-md transition-all hover:border-zinc-700/80">
      <div className="mb-3 flex items-start justify-between gap-3">
        <StatusChip status={market.status} />
        {market.status === "resolved" ? (
          <Chip tone={market.winner === "yes" ? "yes" : "no"}>Winner {market.winner.toUpperCase()}</Chip>
        ) : null}
      </div>

      <Link href={href} className="block">
        <h3 className="min-h-[3.2rem] text-lg font-bold leading-snug tracking-tight text-white hover:text-zinc-100">
          {market.title || "Untitled market"}
        </h3>
      </Link>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div className="flex h-full w-full">
          <div className="h-full bg-emerald-500" style={{ width: `${yes}%` }} />
          <div className="h-full bg-rose-500" style={{ width: `${no}%` }} />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link
          href={`${href}?side=yes`}
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 py-2.5 text-center text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
        >
          Buy Yes · {yes}%
        </Link>
        <Link
          href={`${href}?side=no`}
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 py-2.5 text-center text-sm font-medium text-rose-400 transition-colors hover:bg-rose-500/20"
        >
          Buy No · {no}%
        </Link>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-zinc-400">
        <span className="rounded-full border border-zinc-800 bg-zinc-950/40 px-2.5 py-1 font-mono">
          {timeLabel}
        </span>
        <span className="font-mono">Liq {liq}</span>
      </div>
    </article>
  );
}
