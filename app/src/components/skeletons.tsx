"use client";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Sk({ className }: { className?: string }) {
  return <div className={cx("sk", className)} aria-hidden />;
}

export function PriceTapeSkeleton() {
  return (
    <div className="home-tape" aria-hidden>
      {["a", "b"].map((id, index) => (
        <span key={id} className="home-tape-item">
          {index > 0 ? <span className="home-tape-sep">｜</span> : null}
          <Sk className="h-3.5 w-16" />
          <Sk className="h-3.5 w-20" />
        </span>
      ))}
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

export function MarketTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="surface overflow-hidden" aria-hidden>
      <div className="market-head h-8 px-4">
        <Sk className="h-2 w-16" />
        <Sk className="ml-auto h-2 w-12" />
        <Sk className="ml-auto h-2 w-12" />
        <Sk className="ml-auto h-2 w-12" />
        <Sk className="ml-auto h-2 w-10" />
        <Sk className="ml-auto h-2 w-10" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="market-row px-4">
          <div className="c-name">
            <Sk className="h-3 w-4/5" />
          </div>
          <div className="c-yes">
            <Sk className="ml-auto h-3 w-14" />
          </div>
          <div className="c-ends">
            <Sk className="ml-auto h-3 w-16" />
          </div>
          <div className="c-pool">
            <Sk className="ml-auto h-3 w-16" />
          </div>
          <div className="c-status flex justify-end">
            <Sk className="h-4 w-14 rounded-full" />
          </div>
          <div className="c-trade">
            <Sk className="ml-auto h-7 w-12 rounded-2xl" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <div className="home-hero" aria-hidden>
      <div>
        <div className="flex items-center gap-2">
          <Sk className="h-1.5 w-1.5 rounded-full" />
          <Sk className="h-3 w-56" />
        </div>
        <Sk className="home-hero-title-sk mt-6 w-full max-w-xl" />
        <Sk className="mt-4 h-[18px] w-full max-w-lg" />
        <Sk className="mt-2 h-[18px] w-80 max-w-full" />
        <div className="mt-8 flex gap-3">
          <Sk className="h-10 w-28 rounded-2xl" />
          <Sk className="h-10 w-24 rounded-2xl" />
        </div>
      </div>
      <PriceTapeSkeleton />
    </div>
  );
}

export function MarketsSkeleton() {
  return (
    <div className="split split-markets" aria-hidden>
      <div className="stack-5">
        <Sk className="h-[30px] w-40" />
        <MarketTableSkeleton />
      </div>
      <div className="stack-4">
        <div className="surface p-4 stack-3">
          <Sk className="h-3 w-20" />
          <Sk className="ml-auto h-7 w-28" />
        </div>
        <div className="surface p-4 stack-3">
          <Sk className="h-3 w-16" />
          <Sk className="h-3 w-full" />
          <Sk className="h-3 w-5/6" />
          <Sk className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  );
}

export function MarketDetailSkeleton() {
  return (
    <div className="stack-6" aria-hidden>
      <div className="stack-3">
        <Sk className="h-3 w-24" />
        <Sk className="h-[30px] w-2/3" />
      </div>
      <div className="split split-detail">
        <div className="stack-4">
          <div className="surface p-4 stack-3">
            <Sk className="h-3 w-16" />
            <Sk className="ml-auto h-8 w-28" />
            <Sk className="ml-auto h-8 w-24" />
          </div>
          <div className="surface p-4 stack-3">
            <Sk className="h-3 w-20" />
            <Sk className="h-3 w-full" />
            <Sk className="h-3 w-5/6" />
            <Sk className="h-3 w-2/3" />
          </div>
        </div>
        <div className="stack-4">
          <div className="surface p-4 stack-4">
            <Sk className="h-4 w-20" />
            <Sk className="h-11 w-full" />
            <Sk className="h-11 w-full" />
            <Sk className="h-11 w-full" />
            <Sk className="h-10 w-full rounded-2xl" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function MeSkeleton() {
  return (
    <div className="stack-6" aria-hidden>
      <Sk className="h-[30px] w-28" />
      <div className="cards-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="surface p-4 stack-3">
            <Sk className="h-4 w-3/4" />
            <Sk className="ml-auto h-3 w-20" />
            <Sk className="ml-auto h-3 w-16" />
            <Sk className="ml-auto h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function CreateSkeleton() {
  return (
    <div className="split split-create" aria-hidden>
      <div className="stack-5">
        <Sk className="h-[30px] w-48" />
        <div className="surface p-4 stack-4">
          <Sk className="h-3 w-20" />
          <Sk className="h-11 w-full" />
          <Sk className="h-11 w-full" />
          <Sk className="h-11 w-full" />
          <Sk className="h-12 w-full rounded-2xl" />
        </div>
      </div>
      <FeatureCardSkeleton />
    </div>
  );
}
