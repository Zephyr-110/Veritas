"use client";

import { useT } from "@/i18n/provider";
import { useNow } from "@/hooks/use-now";

/**
 * How old the displayed price print is, from the print's own Pyth
 * publish time, ticking once a second. A price on this site always
 * carries its age: a stale print labels itself instead of passing as
 * a live one (standing no-fake-data rule). Renders nothing when the
 * print has no publish time.
 */
export function PriceAge({
  publishTime,
  className = "text-[10px] text-zinc-400",
}: {
  publishTime: number | null;
  className?: string;
}) {
  const t = useT();
  const now = useNow(1000);

  if (publishTime == null) return null;
  const age = Math.max(0, now - publishTime);
  const label =
    age < 60
      ? t("quotes.ageSec", { n: age })
      : age < 3600
        ? t("quotes.ageMin", { n: Math.floor(age / 60) })
        : t("quotes.ageHour", { n: Math.floor(age / 3600) });
  return <span className={className}>{label}</span>;
}
