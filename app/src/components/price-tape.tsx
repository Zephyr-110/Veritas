"use client";

import { useEffect, useRef, useState } from "react";
import { FEEDS, formatPythPrice } from "@/lib/feeds";
import { useFeeds } from "@/hooks/use-feeds";
import { useT } from "@/i18n/provider";
import { cx } from "./ui";
import { PricePanelSkeleton } from "./skeletons";

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
    const dur = first ? 950 : 450;
    cancelAnimationFrame(rafRef.current);
    const step = (nowMs: number) => {
      const k = Math.min(1, (nowMs - start) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      setDisplay(from + (to - from) * eased);
      if (k < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    if (first) return;
    const id = window.setTimeout(() => setDir(null), 700);
    return () => window.clearTimeout(id);
  }, [value]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return (
    <span className={cx("num home-prices-value", dir === "up" && "flash-up", dir === "down" && "flash-down")}>
      {formatPythPrice(display)}
    </span>
  );
}

export function PricePanel() {
  const { quotes, ready } = useFeeds();
  const t = useT();
  if (!ready) return <PricePanelSkeleton />;
  const visible = FEEDS.filter((feed) => {
    const q = quotes[feed.key];
    return Boolean(q?.available && q.price != null);
  });
  if (!visible.length) return null;
  return (
    <aside className="surface home-prices panel-float panel-in">
      <div className="flex items-center justify-between gap-3">
        <span className="home-kicker flex items-center gap-2">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />
          {t("home.prices")}
        </span>
        <span className="text-xs text-zinc-600">{t("home.pricesSrc")}</span>
      </div>
      <div className="mt-1">
        {visible.map((feed) => {
          const q = quotes[feed.key];
          return (
            <div key={feed.key} className="home-prices-row">
              <span className="home-prices-pair">{t(feed.labelKey)}</span>
              <PriceValue value={q.price as number} />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
