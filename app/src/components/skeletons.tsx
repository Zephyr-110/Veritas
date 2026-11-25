"use client";

import { StableText } from "./ui";

export function FetchingNote() {
  return (
    <div className="flex items-center justify-center gap-2 pt-2 text-sm text-zinc-500" aria-hidden>
      <span className="live-dot h-1.5 w-1.5 rounded-full bg-zinc-400" />
      <StableText k="state.fetchingNode" />
    </div>
  );
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Sk({ className }: { className?: string }) {
  return <div className={cx("sk", className)} aria-hidden />;
}

export function PricePanelSkeleton() {
  return (
    <div className="surface home-prices panel-float" aria-hidden>
      <div className="home-prices-head">
        <Sk className="h-3 w-20" />
        <Sk className="h-3 w-24" />
      </div>
      <div>
        {["a", "b", "c", "d", "e", "f"].map((id) => (
          <div key={id} className="home-prices-row">
            <div className="home-prices-id">
              <Sk className="h-8 w-8 shrink-0" />
              <div className="stack-1">
                <Sk className="h-3.5 w-16" />
                <Sk className="h-2.5 w-12" />
              </div>
            </div>
            <div className="home-prices-spark">
              <Sk className="h-4 w-14" />
            </div>
            <div className="home-prices-quote">
              <Sk className="h-4 w-20" />
              <Sk className="mt-1 h-2.5 w-14" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FeatureCardSkeleton() {
  return (
    <div className="surface h-full p-4 stack-3" aria-hidden>
      <Sk className="h-4 w-4/5" />
      <Sk className="ml-auto h-3 w-28" />
      <Sk className="ml-auto h-3 w-20" />
      <Sk className="ml-auto h-3 w-16" />
    </div>
  );
}

export function MarketTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="surface overflow-hidden" aria-hidden>
      <div className="market-head h-9 px-5">
        <Sk className="h-2.5 w-16" />
        <Sk className="ml-auto h-2.5 w-12" />
        <Sk className="ml-auto h-2.5 w-12" />
        <Sk className="ml-auto h-2.5 w-12" />
        <Sk className="ml-auto h-2.5 w-12" />
        <Sk className="ml-auto h-2.5 w-10" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="market-row border-t border-[var(--hair)] px-5">
          <div className="c-name">
            <Sk className="h-3.5 w-4/5" />
          </div>
          <div className="c-yes">
            <Sk className="ml-auto h-3.5 w-14" />
          </div>
          <div className="c-ends">
            <Sk className="ml-auto h-3.5 w-16" />
          </div>
          <div className="c-pool">
            <Sk className="ml-auto h-3.5 w-16" />
          </div>
          <div className="c-status flex justify-end">
            <Sk className="h-5 w-20" />
          </div>
          <div className="c-trade">
            <Sk className="ml-auto h-8 w-14" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <div className="home-hero" aria-hidden>
      <div className="home-hero-grid">
        <div>
          <div className="flex items-center gap-2">
            <Sk className="h-1.5 w-1.5 rounded-full" />
            <Sk className="h-3 w-56" />
          </div>
          <Sk className="home-hero-title-sk mt-5 w-full max-w-xl" />
          <Sk className="mt-4 h-[18px] w-full max-w-lg" />
          <Sk className="mt-2 h-[18px] w-80 max-w-full" />
          <div className="mt-7 flex gap-3">
            <Sk className="h-11 w-32" />
            <Sk className="h-11 w-28" />
          </div>
        </div>
        <PricePanelSkeleton />
      </div>
      <FetchingNote />
    </div>
  );
}

export function MarketsSkeleton() {
  return (
    <div className="split split-markets" aria-hidden>
      <div className="stack-5">
        <Sk className="h-[32px] w-40" />
        <MarketTableSkeleton />
      </div>
      <div className="stack-4">
        <div className="surface p-5 stack-3">
          <Sk className="h-3 w-20" />
          <Sk className="ml-auto h-7 w-28" />
        </div>
        <div className="surface p-5 stack-3">
          <Sk className="h-3 w-16" />
          <Sk className="h-3 w-full" />
          <Sk className="h-3 w-5/6" />
          <Sk className="h-3 w-2/3" />
        </div>
      </div>
      <FetchingNote />
    </div>
  );
}

export function MarketDetailSkeleton() {
  return (
    <div className="stack-6" aria-hidden>
      <div className="stack-3">
        <Sk className="h-3 w-24" />
        <Sk className="h-[32px] w-2/3" />
      </div>
      <div className="split split-detail">
        <div className="stack-4">
          <div className="surface p-5 stack-3">
            <Sk className="h-3 w-16" />
            <Sk className="ml-auto h-8 w-28" />
            <Sk className="ml-auto h-8 w-24" />
          </div>
          <div className="surface p-5 stack-3">
            <Sk className="h-3 w-20" />
            <Sk className="h-3 w-full" />
            <Sk className="h-3 w-5/6" />
            <Sk className="h-3 w-2/3" />
          </div>
        </div>
        <div className="stack-4">
          <div className="surface p-5 stack-4">
            <Sk className="h-4 w-20" />
            <Sk className="h-11 w-full" />
            <Sk className="h-11 w-full" />
            <Sk className="h-11 w-full" />
            <Sk className="h-10 w-full" />
          </div>
        </div>
      </div>
      <FetchingNote />
    </div>
  );
}

export function MeSkeleton() {
  return (
    <div className="stack-6" aria-hidden>
      <Sk className="h-[32px] w-28" />
      <div className="cards-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="surface p-5 stack-3">
            <Sk className="h-4 w-3/4" />
            <Sk className="ml-auto h-3 w-20" />
            <Sk className="ml-auto h-3 w-16" />
            <Sk className="ml-auto h-3 w-24" />
          </div>
        ))}
      </div>
      <FetchingNote />
    </div>
  );
}

export function CreateSkeleton() {
  return (
    <div className="split split-create" aria-hidden>
      <div className="stack-5">
        <Sk className="h-[32px] w-48" />
        <div className="surface p-5 stack-4">
          <Sk className="h-3 w-20" />
          <Sk className="h-11 w-full" />
          <Sk className="h-11 w-full" />
          <Sk className="h-11 w-full" />
          <Sk className="h-12 w-full" />
        </div>
      </div>
      <FeatureCardSkeleton />
    </div>
  );
}
