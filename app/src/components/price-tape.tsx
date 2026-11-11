"use client";

import { FEEDS, formatPythPrice } from "@/lib/feeds";
import { useFeeds } from "@/hooks/use-feeds";
import { useT } from "@/i18n/provider";
import { FlashNum } from "./live";

export function PriceTape() {
  const quotes = useFeeds();
  const t = useT();
  return (
    <div className="surface grid grid-cols-1 divide-y divide-zinc-800/80 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      {FEEDS.map((feed) => {
        const q = quotes[feed.key];
        return (
          <div key={feed.key} className="flex items-baseline justify-between gap-3 px-4 py-3">
            <div>
              <div className="kicker text-[10px] text-zinc-500">{t(feed.labelKey)}</div>
              <div className="mt-1 text-xs text-zinc-600">{feed.symbol}</div>
            </div>
            <div className="text-right">
              {q.available && q.price != null ? (
                <FlashNum value={q.price} className="text-lg font-medium text-white">
                  {formatPythPrice(q.price)}
                </FlashNum>
              ) : (
                <div className="text-sm text-zinc-500">—</div>
              )}
              {!q.available ? (
                <div className="mt-1 text-[10px] text-zinc-600">{t("tape.unavailable")}</div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
