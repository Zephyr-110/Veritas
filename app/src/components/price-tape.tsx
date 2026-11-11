"use client";

import { useEffect, useRef, useState } from "react";
import { FEEDS, formatPythPrice } from "@/lib/feeds";
import { useFeeds } from "@/hooks/use-feeds";
import { useT } from "@/i18n/provider";
import { cx } from "./ui";
import { PriceTapeSkeleton } from "./skeletons";

function FlashAccent({ value, children }: { value: number; children: string }) {
  const prev = useRef(value);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (value === prev.current) return;
    prev.current = value;
    setOn(true);
    const id = window.setTimeout(() => setOn(false), 650);
    return () => window.clearTimeout(id);
  }, [value]);

  return <span className={cx("num home-tape-price", on && "flash-accent")}>{children}</span>;
}

export function PriceTape() {
  const { quotes, ready } = useFeeds();
  const t = useT();
  if (!ready) return <PriceTapeSkeleton />;
  const visible = FEEDS.filter((feed) => {
    const q = quotes[feed.key];
    return Boolean(q?.available && q.price != null);
  });
  if (!visible.length) return null;
  return (
    <div className="home-tape fade-in">
      {visible.map((feed, index) => {
        const q = quotes[feed.key];
        return (
          <span key={feed.key} className="home-tape-item">
            {index > 0 ? <span className="home-tape-sep">｜</span> : null}
            <span className="home-tape-pair">{t(feed.labelKey)}</span>
            <FlashAccent value={q.price as number}>{formatPythPrice(q.price)}</FlashAccent>
          </span>
        );
      })}
    </div>
  );
}
