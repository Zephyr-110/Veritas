"use client";

import { useMemo, useState } from "react";
import { COLLATERAL_SYMBOL } from "@/lib/constants";
import { money } from "@/lib/display";
import { isQuoteStale } from "@/lib/chainlink";
import { FEEDS, formatFeedPrice, thresholdToHuman } from "@/lib/feeds";
import { formatCents, formatFixed, fromUi } from "@/lib/format";
import { inferLeffFromReserves, quoteBet } from "@/lib/quote";
import { useFeeds } from "@/hooks/use-feeds";
import type { FeedKey, Side } from "@/lib/types";
import { useT } from "@/i18n/provider";
import { PriceAge } from "./price-age";
import { Button, Field, Kv, PopNum, SegTabs, StableText, TextInput, cx, onSpot, openWalletModal } from "./ui";

const SIM_DECIMALS = 6;
const SIM_SEED_ATOMS = 100_000_000n;
const SIM_PRESETS = ["1", "2", "5", "10"];

export function SimOrderPreview() {
  const { quotes, ready, retry } = useFeeds();
  const t = useT();
  const [feedKey, setFeedKey] = useState<FeedKey>("btc");
  const [side, setSide] = useState<Side>("yes");
  const [above, setAbove] = useState(true);
  const [amount, setAmount] = useState("2");

  const availableFeeds = useMemo(
    () => FEEDS.filter((f) => !isQuoteStale(quotes[f.key])),
    [quotes]
  );

  const activeFeed = useMemo(
    () => availableFeeds.find((f) => f.key === feedKey) ?? availableFeeds[0] ?? null,
    [availableFeeds, feedKey]
  );

  const parsed = useMemo(() => {
    try {
      return { value: fromUi(amount || "0", SIM_DECIMALS), invalid: false };
    } catch {
      return { value: 0n, invalid: amount.trim().length > 0 };
    }
  }, [amount]);

  const simLeff = useMemo(
    () => inferLeffFromReserves(Number(SIM_SEED_ATOMS), Number(SIM_SEED_ATOMS)),
    []
  );

  const quoteOut = useMemo(
    () => quoteBet(SIM_SEED_ATOMS, SIM_SEED_ATOMS, parsed.value, side, simLeff),
    [parsed.value, side, simLeff]
  );

  if (!ready) {
    return (
      <div className="surface stack-4 p-5" aria-busy="true">
        <div className="sk h-4 w-40" />
        <div className="sk h-5 w-64" />
        <div className="sk h-10 w-full" />
        <div className="sk h-10 w-full" />
      </div>
    );
  }

  if (!activeFeed) {
    return (
      <div onMouseMove={onSpot} className="surface stack-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="section-title">
            <StableText k="sim.kicker" />
          </span>
          <span className="border border-[var(--line)] bg-[var(--seg-bg)] px-2 py-0.5 text-[10px] font-semibold tracking-wider text-white">
            <StableText k="sim.badge" align="center" />
          </span>
        </div>
        <p className="text-sm text-zinc-400">
          <StableText k="freshness.feedUnavailable" block />
        </p>
        <div>
          <Button type="button" tone="secondary" className="h-8 px-3 text-xs" onClick={() => void retry()}>
            <StableText k="common.retry" align="center" />
          </Button>
        </div>
      </div>
    );
  }

  const quote = quotes[activeFeed.key];
  const liveSpot = quote.price as number;
  const spotThresholdRaw = BigInt(Math.round(liveSpot * 10 ** activeFeed.decimals));
  const targetLabel = thresholdToHuman(spotThresholdRaw, activeFeed.decimals);
  const sideLabel = side === "yes" ? t("common.yes") : t("common.no");
  const ruleOp = (side === "yes") === above ? "≥" : "<";
  const avgPrice =
    quoteOut.totalOut > 0n && parsed.value > 0n
      ? Number(parsed.value) / Number(quoteOut.totalOut)
      : null;

  return (
    <div id="sim-preview" onMouseMove={onSpot} className="surface scroll-mt-24 stack-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="section-title">
          <StableText k="sim.kicker" />
        </span>
        <span className="border border-[var(--line)] bg-[var(--seg-bg)] px-2 py-0.5 text-[10px] font-semibold tracking-wider text-white">
          <StableText k="sim.badge" align="center" />
        </span>
      </div>

      <div className="stack-1">
        <h3 className="text-base font-medium text-white">
          <StableText k="sim.title" block />
        </h3>
        <p className="text-xs leading-5 text-zinc-400">
          <StableText k="sim.sub" block />
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {availableFeeds.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFeedKey(f.key)}
            className={cx(
              "choice choice-sm",
              f.key === activeFeed.key ? "choice-on font-medium" : ""
            )}
          >
            {f.symbol}
          </button>
        ))}
      </div>

      <div className="grid gap-3 border border-[var(--hair)] bg-[var(--seg-bg)] p-3.5 sm:grid-cols-2">
        <div className="stack-1">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            {activeFeed.symbol} · <StableText k="home.pricesSrc" />
          </span>
          <div className="flex items-baseline gap-2">
            <span className="num text-lg font-semibold text-white">{formatFeedPrice(liveSpot)}</span>
            <PriceAge publishTime={quote.publishTime} />
          </div>
        </div>
        <div className="stack-1 sm:text-right">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            <StableText k="sim.targetLabel" align="end" />
          </span>
          <div className="flex items-center gap-2 sm:justify-end">
            <span className="num text-base font-medium text-zinc-200">{targetLabel}</span>
            <button
              type="button"
              aria-label="direction"
              onClick={() => setAbove((v) => !v)}
              className="border border-[var(--line)] bg-[var(--card-bg)] px-2 py-0.5 font-mono text-xs text-zinc-200 hover:border-zinc-400"
            >
              {above ? "≥" : "<"}
            </button>
          </div>
        </div>
      </div>

      <SegTabs
        value={side}
        onChange={setSide}
        options={[
          {
            value: "yes",
            label: <StableText k="trade.buyYes" align="center" />,
            color: "var(--yes-soft)",
            activeText: "text-[var(--yes)]",
          },
          {
            value: "no",
            label: <StableText k="trade.buyNo" align="center" />,
            color: "var(--no-soft)",
            activeText: "text-[var(--no)]",
          },
        ]}
      />

      <p className="-mt-1 text-xs leading-5 text-zinc-500">
        <StableText
          k="sim.directionHint"
          vars={{ side: sideLabel, op: ruleOp, price: targetLabel }}
          block
        />
      </p>

      <Field label={<StableText k="sim.amountLabel" vars={{ symbol: COLLATERAL_SYMBOL }} />}>
        <TextInput
          inputMode="decimal"
          aria-label={t("sim.amountLabel", { symbol: COLLATERAL_SYMBOL })}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="font-mono tabular-nums"
        />
      </Field>

      <div className="cluster-2">
        {SIM_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className="border border-[var(--hair)] px-3 py-1 text-xs text-zinc-400 transition hover:border-[var(--line)] hover:text-white active:scale-95"
            onClick={() => setAmount(p)}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="stack-2 text-sm">
        <Kv
          k={<StableText k="sim.sharesOut" />}
          v={<PopNum text={`${formatFixed(quoteOut.totalOut, SIM_DECIMALS, 2)} ${sideLabel}`} />}
        />
        {avgPrice != null ? (
          <Kv k={<StableText k="sim.avgPrice" />} v={<PopNum text={formatCents(avgPrice)} />} />
        ) : null}
        {quoteOut.totalOut > 0n ? (
          <Kv k={<StableText k="sim.payout" />} v={<PopNum text={money(quoteOut.totalOut, SIM_DECIMALS)} />} />
        ) : null}
      </div>

      <div className="stack-1 border-t border-[var(--hair)] pt-3 text-xs leading-5 text-zinc-500">
        <p>
          <StableText k="sim.assumption" vars={{ symbol: COLLATERAL_SYMBOL }} block />
        </p>
        <p>
          <StableText k="sim.feeLine" block />
        </p>
      </div>

      <Button
        type="button"
        disabled={parsed.invalid || parsed.value <= 0n}
        onClick={() => openWalletModal()}
      >
        <StableText k="sim.submitCta" align="center" />
      </Button>
    </div>
  );
}
