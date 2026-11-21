"use client";

import { useEffect, useRef, useState } from "react";
import { FEEDS, formatFeedPrice } from "@/lib/feeds";
import { useFeeds } from "@/hooks/use-feeds";
import { Button, cx, onSpot, StableText } from "./ui";
import { PricePanelSkeleton } from "./skeletons";
import { PriceAge } from "./price-age";

function PriceValue({ value }: { value: number }) {
  const [display, setDisplay] = useState(0);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const fromRef = useRef(0);
  const mountedRef = useRef(false);
  const rafRef = useRef(0);

  useEffect(() => {
    const first = !mountedRef.current;
    mountedRef.current = true;
    const from = first ? 0 : fromRef.current;
    const to = value;
    fromRef.current = value;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(to);
      return;
    }
    if (from === to) {
      setDisplay(to);
      return;
    }
    if (!first) setDir(to > from ? "up" : "down");
    const start = performance.now();
    const dur = first ? 700 : 380;
    cancelAnimationFrame(rafRef.current);
    const step = (nowMs: number) => {
      const k = Math.min(1, (nowMs - start) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      setDisplay(from + (to - from) * eased);
      if (k < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    if (first) return;
    const id = window.setTimeout(() => setDir(null), 650);
    return () => window.clearTimeout(id);
  }, [value]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return (
    <span className={cx("num home-prices-value", dir === "up" && "flash-up", dir === "down" && "flash-down")}>
      {formatFeedPrice(display)}
    </span>
  );
}

export function PricePanel() {
  const { quotes, ready, error, retry } = useFeeds();
  if (!ready) return <PricePanelSkeleton />;

  const visible = FEEDS.filter((feed) => {
    const q = quotes[feed.key];
    return Boolean(q?.available && q.price != null);
  });

  if (!visible.length) {
    return (
      <aside onMouseMove={onSpot} className="surface home-prices panel-float panel-in stack-3">
        <div className="flex items-center justify-between gap-3">
          <span className="home-kicker flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />
            <StableText k="home.prices" />
          </span>
          <span className="text-xs text-zinc-500">
            <StableText k="home.pricesSrc" align="end" />
          </span>
        </div>
        <p className="py-6 text-sm text-zinc-400">
          <StableText k="freshness.feedUnavailable" block />
        </p>
        <div>
          <Button type="button" tone="secondary" className="h-8 px-3 text-xs" onClick={() => void retry()}>
            <StableText k="common.retry" align="center" />
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside onMouseMove={onSpot} className="surface home-prices panel-float panel-in">
      <div className="flex items-center justify-between gap-3 pb-1">
        <span className="home-kicker flex items-center gap-2">
          <span className={cx("live-dot h-1.5 w-1.5 rounded-full", error ? "bg-[var(--warn)]" : "bg-[var(--yes)]")} />
          <StableText k="home.prices" />
        </span>
        <span className="text-xs text-zinc-400">
          <StableText k="home.pricesSrc" align="end" />
        </span>
      </div>
      <div className="mt-1">
        {visible.map((feed) => {
          const q = quotes[feed.key];
          return (
            <div key={feed.key} className="home-prices-row">
              <span className="home-prices-pair font-medium">{feed.symbol}</span>
              <span className="flex items-baseline gap-2.5">
                <PriceValue value={q.price as number} />
                <PriceAge publishTime={q.publishTime} />
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
