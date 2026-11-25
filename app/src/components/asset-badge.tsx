"use client";

import { useEffect, useState } from "react";
import type { FeedKey } from "@/lib/types";
import { cx } from "./ui";

export const TOKEN_LOGOS: Partial<Record<FeedKey, string>> = {
  btc: "/tokens/btc.svg",
  eth: "/tokens/eth.svg",
  sol: "/tokens/sol.svg",
  link: "/tokens/link.svg",
  usdc: "/tokens/usdc.svg",
  usdt: "/tokens/usdt.svg",
};

function fallbackMonogram(symbol?: string, feedKey?: FeedKey | null): string {
  const raw = (symbol || feedKey || "?").split("/")[0].replace(/[^A-Za-z0-9]/g, "");
  return (raw.slice(0, 2) || "?").toUpperCase();
}

const BADGE_SIZE = {
  sm: { box: "h-7 w-7", icon: 24 },
  md: { box: "h-8 w-8", icon: 28 },
  lg: { box: "h-9 w-9", icon: 32 },
} as const;

export function AssetBadge({
  feedKey,
  symbol,
  size = "md",
  className,
}: {
  feedKey?: FeedKey | null;
  symbol?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const logoSrc = feedKey ? TOKEN_LOGOS[feedKey] : undefined;
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [logoSrc]);

  const showLogo = Boolean(logoSrc && !imgFailed);
  const { box: boxClass, icon: iconSize } = BADGE_SIZE[size];

  return (
    <span
      aria-hidden="true"
      data-asset-logo={showLogo ? feedKey ?? undefined : "fallback"}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-none select-none",
        !showLogo && "border border-[var(--hair)] bg-[var(--seg-bg)]",
        boxClass,
        className
      )}
    >
      {showLogo ? (
        <img
          src={logoSrc}
          alt=""
          width={iconSize}
          height={iconSize}
          className="block object-contain"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span className="font-mono text-[10px] font-semibold tracking-tight text-[var(--ink-2)]">
          {fallbackMonogram(symbol, feedKey)}
        </span>
      )}
    </span>
  );
}
