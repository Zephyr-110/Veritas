"use client";

import { useNow } from "@/hooks/use-now";
import { cx, StableText } from "./ui";

/**
 * How old the displayed price print is, from the print's own Chainlink
 * publish time, ticking once a second. Fixed minimum width prevents
 * EN <-> ZH age text from shifting neighboring numerals.
 */
export function PriceAge({
  publishTime,
  className = "min-w-[4.75rem] text-right text-[11px]",
}: {
  publishTime: number | null;
  className?: string;
}) {
  const now = useNow(1000);

  if (publishTime == null || now <= 0) return null;
  const age = Math.max(0, now - publishTime);
  const key =
    age < 60
      ? "quotes.ageSec"
      : age < 3600
        ? "quotes.ageMin"
        : "quotes.ageHour";
  const count = age < 60 ? age : age < 3600 ? Math.floor(age / 60) : Math.floor(age / 3600);
  const tone =
    age > 300
      ? "text-[var(--warn)]"
      : age > 30
        ? "text-zinc-500"
        : "text-zinc-400";
  const stamp = new Date(publishTime * 1000).toLocaleTimeString("en-GB", { hour12: false });

  return (
    <span title={stamp} className={cx("num inline-block whitespace-nowrap", tone, className)}>
      <StableText k={key} vars={{ n: count }} align="end" />
    </span>
  );
}
