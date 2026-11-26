"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FEEDS, formatFeedPrice } from "@/lib/feeds";
import { chartPair, fetch24hSparkline, type SparklineData } from "@/lib/chart";
import { isQuoteStale } from "@/lib/chainlink";
import type { FeedKey } from "@/lib/types";
import { useFeeds } from "@/hooks/use-feeds";
import { useNow } from "@/hooks/use-now";
import { AssetBadge } from "./asset-badge";
import { Button, cx, onSpot, StableText } from "./ui";
import { PricePanelSkeleton } from "./skeletons";
import { PriceAge } from "./price-age";

export const FEED_DISPLAY_NAMES: Partial<Record<FeedKey, string>> = {
  btc: "Bitcoin",
  eth: "Ethereum",
  sol: "Solana",
  link: "Chainlink",
};

function PriceValue({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    fromRef.current = value;
    if (from === to) {
      setDisplay(to);
      return;
    }
    setDir(to > from ? "up" : "down");
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(to);
    } else {
      const start = performance.now();
      const dur = 380;
      cancelAnimationFrame(rafRef.current);
      const step = (nowMs: number) => {
        const k = Math.min(1, (nowMs - start) / dur);
        const eased = 1 - Math.pow(1 - k, 3);
        setDisplay(from + (to - from) * eased);
        if (k < 1) rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    }
    const id = window.setTimeout(() => setDir(null), 650);
    return () => window.clearTimeout(id);
  }, [value]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return (
    <span className={cx("home-prices-value", dir === "up" && "flash-up", dir === "down" && "flash-down")}>
      {formatFeedPrice(display)}
    </span>
  );
}

function MiniSparkline({ points, changePct }: SparklineData) {
  if (points.length < 2) return null;
  const w = 64;
  const h = 22;
  const padY = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  const coords = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = span > 0 ? padY + (1 - (p - min) / span) * (h - padY * 2) : h / 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const stroke =
    changePct == null || Math.abs(changePct) < 0.005
      ? "var(--ink-3)"
      : changePct > 0
        ? "var(--yes)"
        : "var(--no)";

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      data-sparkline="true"
      className="block overflow-visible"
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
        points={coords}
      />
    </svg>
  );
}

function formatChangePct(pct: number): string {
  const abs = Math.abs(pct);
  const sign = pct > 0.005 ? "+" : pct < -0.005 ? "-" : "";
  return `${sign}${abs.toFixed(2)}%`;
}

function useFeedSparklines(keys: FeedKey[]): Partial<Record<FeedKey, SparklineData>> {
  const keyStr = keys.join(",");
  const { data } = useQuery({
    queryKey: ["feed-sparklines-24h", keyStr],
    enabled: keys.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const results = await Promise.allSettled(
        keys.map(async (key) => {
          const pair = chartPair(key);
          if (!pair) return [key, null] as const;
          return [key, await fetch24hSparkline(pair)] as const;
        })
      );
      const out: Partial<Record<FeedKey, SparklineData>> = {};
      for (const res of results) {
        if (res.status === "fulfilled" && res.value[1]) {
          out[res.value[0]] = res.value[1];
        }
      }
      return out;
    },
  });
  return data ?? {};
}

export function PricePanel() {
  const { quotes, ready, error, retry } = useFeeds();
  useNow(1000);
  const nowMs = Date.now();
  const visible = FEEDS.filter((feed) => {
    const q = quotes[feed.key];
    return Boolean(q?.available && q.price != null);
  });
  const anyStale = visible.some((feed) => isQuoteStale(quotes[feed.key], nowMs));
  const sparklines = useFeedSparklines(visible.map((f) => f.key));

  if (!ready) return <PricePanelSkeleton />;

  if (!visible.length) {
    return (
      <aside onMouseMove={onSpot} className="surface home-prices panel-float panel-in">
        <div className="home-prices-head">
          <span className="home-kicker flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />
            <StableText k="home.prices" />
          </span>
          <span className="text-xs text-[var(--ink-3)]">
            <StableText k="home.pricesSrc" align="end" />
          </span>
        </div>
        <div className="stack-3 px-4 py-5">
          <p className="py-3 text-sm text-zinc-400">
            <StableText k="freshness.feedUnavailable" block />
          </p>
          <div>
            <Button type="button" tone="secondary" className="h-8 px-3 text-xs" onClick={() => void retry()}>
              <StableText k="common.retry" align="center" />
            </Button>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside onMouseMove={onSpot} className="surface home-prices panel-float panel-in">
      <div className="home-prices-head">
        <span className="home-kicker flex items-center gap-2">
          <span
            className={cx(
              "h-1.5 w-1.5 rounded-full",
              error || anyStale ? "bg-[var(--warn)]" : "live-dot bg-[var(--yes)]"
            )}
          />
          <StableText k="home.prices" />
        </span>
        <span className="text-[11px] text-[var(--ink-3)]">
          <StableText k="home.pricesSrc" align="end" />
        </span>
      </div>
      <div>
        {visible.map((feed) => {
          const q = quotes[feed.key];
          const stale = isQuoteStale(q, nowMs);
          const fullName = FEED_DISPLAY_NAMES[feed.key];
          const spark = sparklines[feed.key];
          const changeTone =
            spark?.changePct == null || Math.abs(spark.changePct) < 0.005
              ? "text-[var(--ink-3)]"
              : spark.changePct > 0
                ? "text-[var(--yes)]"
                : "text-[var(--no)]";

          return (
            <div key={feed.key} className="home-prices-row">
              <div className="home-prices-id">
                <AssetBadge feedKey={feed.key} symbol={feed.symbol} size="md" />
                <div className="min-w-0">
                  {fullName ? (
                    <>
                      <div className="home-prices-name truncate">{fullName}</div>
                      <div className="home-prices-code truncate">{feed.symbol}</div>
                    </>
                  ) : (
                    <div className="home-prices-code-only truncate">{feed.symbol}</div>
                  )}
                </div>
              </div>
              <div className="home-prices-spark">
                {spark ? (
                  <MiniSparkline points={spark.points} changePct={spark.changePct} />
                ) : (
                  <svg width={64} height={22} viewBox="0 0 64 22" aria-hidden="true" className="block">
                    <line x1={0} x2={64} y1={11} y2={11} stroke="var(--hair)" strokeDasharray="2 3" />
                  </svg>
                )}
              </div>
              <div className="home-prices-quote">
                {stale ? (
                  <span
                    className="home-prices-value text-xs font-medium text-[var(--warn)]"
                    data-quote-stale="true"
                  >
                    <StableText k="quotes.stale" align="end" />
                  </span>
                ) : (
                  <PriceValue value={q.price as number} />
                )}
                <div className="home-prices-sub">
                  {spark?.changePct != null ? (
                    <span className={cx("num text-[11px] font-medium", changeTone)}>
                      {formatChangePct(spark.changePct)}
                    </span>
                  ) : null}
                  <PriceAge
                    publishTime={q.publishTime}
                    className="text-right text-[10px] opacity-75"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
