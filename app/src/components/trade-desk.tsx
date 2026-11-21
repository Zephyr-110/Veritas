"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { COLLATERAL_SYMBOL, DEFAULT_SLIPPAGE_BPS } from "@/lib/constants";
import { formatCents, fromUi, toUi } from "@/lib/format";
import { thresholdToHuman } from "@/lib/feeds";
import { applySlippage, quoteBet, quoteSwapOut } from "@/lib/quote";
import { ixSwap, ixUserBetOn } from "@/lib/instructions";
import { marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";
import type { Side } from "@/lib/types";
import { useT } from "@/i18n/provider";
import { Button, Card, Field, Kv, PopNum, SegTabs, StableText, TextInput, useTx } from "./ui";
import { FaucetClaimButton } from "./faucet-claim";

const PRESETS = ["1", "2", "5", "10"];

export function TradeDesk({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const { busy, run } = useTx();
  const now = useNow();
  const t = useT();
  const phase = marketPhase(market, now);

  const [tab, setTab] = useState<"bet" | "swap">("bet");
  const [side, setSide] = useState<Side>("yes");
  const [amount, setAmount] = useState("2");
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE_BPS);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("side");
    if (q === "yes" || q === "no") setSide(q);
  }, []);

  const parsed = useMemo(() => {
    try {
      return { value: fromUi(amount || "0", market.decimals), invalid: false };
    } catch {
      return { value: 0n, invalid: amount.trim().length > 0 };
    }
  }, [amount, market.decimals]);

  const betQuote = quoteBet(market.reserveYes, market.reserveNo, parsed.value, side);
  const curSideCents = (side === "yes" ? market.yesPrice : 1 - market.yesPrice) * 100;
  const avgCents =
    betQuote.totalOut > 0n && parsed.value > 0n ? (Number(parsed.value) / Number(betQuote.totalOut)) * 100 : null;
  const impactPct = avgCents != null && curSideCents > 0 ? (avgCents / curSideCents - 1) * 100 : null;
  const swapOut = quoteSwapOut(
    side === "yes" ? market.reserveYes : market.reserveNo,
    side === "yes" ? market.reserveNo : market.reserveYes,
    parsed.value
  );
  const sellBalance = side === "yes" ? position.no : position.yes;
  const sideLabel = side === "yes" ? t("common.yes") : t("common.no");
  const otherLabel = side === "yes" ? t("common.no") : t("common.yes");

  const disabledReasonKey: { key: string; vars?: Record<string, string | number> } | null = !publicKey
    ? { key: "tradeDisable.connect" }
    : !phase.live
      ? { key: "tradeDisable.ended" }
      : parsed.invalid
        ? { key: "tradeDisable.invalid" }
        : parsed.value <= 0n
          ? { key: "tradeDisable.enter" }
          : tab === "bet" && parsed.value > position.collateral
            ? { key: "tradeDisable.noCollateral", vars: { symbol: COLLATERAL_SYMBOL } }
            : tab === "swap" && parsed.value > sellBalance
              ? { key: "tradeDisable.noShares", vars: { side: otherLabel } }
              : !program
                ? { key: "errors.badAddress" }
                : null;

  const submit = async () => {
    if (!publicKey || !program) return;
    if (tab === "bet") {
      await run(side === "yes" ? t("tx.buyYes") : t("tx.buyNo"), () =>
        ixUserBetOn(program, market, publicKey, {
          collateralAmount: parsed.value,
          tokenType: side,
          minOut: applySlippage(betQuote.swapOut, slippage),
        })
      );
    } else {
      await run(side === "yes" ? t("tx.switchYes") : t("tx.switchNo"), () =>
        ixSwap(program, market, publicKey, {
          amountIn: parsed.value,
          tokenType: side,
          minOut: applySlippage(swapOut, slippage),
        })
      );
    }
  };

  return (
    <Card className="desk flex flex-col gap-4">
      <SegTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "bet", label: <StableText k="trade.confirm" align="center" /> },
          { value: "swap", label: <StableText k="trade.switch" align="center" /> },
        ]}
      />
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
          k="trade.gloss"
          vars={{
            side: sideLabel,
            op: (side === "yes") === market.settleAbove ? "≥" : "<",
            price: thresholdToHuman(market.threshold, market.priceDecimals),
          }}
          block
        />
      </p>
      <Field label={<StableText k="trade.youPay" />}>
        <TextInput
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="font-mono tabular-nums"
        />
      </Field>
      <div className="-mt-2 text-right text-xs text-zinc-500">
        <StableText
          k="common.balance"
          vars={{
            amount:
              tab === "bet"
                ? `${toUi(position.collateral, market.decimals, 2)} ${COLLATERAL_SYMBOL}`
                : `${toUi(sellBalance, market.decimals, 2)} ${otherLabel}`,
          }}
          align="end"
        />
      </div>
      {tab === "bet" && position.collateral === 0n ? (
        <div className="-mt-2 flex justify-end">
          <FaucetClaimButton className="h-8 px-3 text-xs" />
        </div>
      ) : null}
      <div className="cluster-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className="border border-[var(--hair)] px-3 py-1 text-xs text-zinc-400 transition hover:border-[var(--line)] hover:text-white active:scale-95"
            onClick={() => setAmount(p)}
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          className="border border-[var(--hair)] px-3 py-1 text-xs text-zinc-400 transition hover:border-[var(--line)] hover:text-white active:scale-95"
          onClick={() => setAmount(toUi(tab === "bet" ? position.collateral : sellBalance, market.decimals, 6))}
        >
          <StableText k="common.max" align="center" />
        </button>
      </div>
      <div className="stack-2 text-sm">
        <Kv
          k={<StableText k="trade.youGet" />}
          v={<PopNum text={`${toUi(tab === "bet" ? betQuote.totalOut : swapOut, market.decimals, 2)} ${sideLabel}`} />}
        />
        {tab === "bet" && betQuote.totalOut > 0n && parsed.value > 0n ? (
          <Kv
            k={<StableText k="trade.avgPrice" />}
            v={<PopNum text={formatCents(Number(parsed.value) / Number(betQuote.totalOut))} />}
          />
        ) : null}
        {tab === "swap" ? (
          <p className="text-xs leading-5 text-zinc-500">
            <StableText k="trade.swapHint" block />
          </p>
        ) : null}
        {tab === "bet" && impactPct != null && impactPct > 10 ? (
          <p className="text-xs leading-5 text-[var(--warn)]">
            <StableText k="trade.impactWarn" vars={{ pct: Math.round(impactPct) }} block />
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs text-zinc-500">
          <StableText k="trade.slippage" />
        </span>
        <input
          type="range"
          className="min-w-0 flex-1"
          min={50}
          max={500}
          step={50}
          value={slippage}
          onChange={(e) => setSlippage(Number(e.target.value))}
        />
        <span className="num w-11 shrink-0 text-right text-xs text-zinc-300">
          {(slippage / 100).toFixed(1)}%
        </span>
      </div>
      <Button type="button" busy={busy} disabled={busy || !!disabledReasonKey} onClick={() => void submit()}>
        {disabledReasonKey ? (
          <StableText k={disabledReasonKey.key} vars={disabledReasonKey.vars} align="center" />
        ) : tab === "bet" ? (
          <StableText k={side === "yes" ? "trade.buyYes" : "trade.buyNo"} align="center" />
        ) : (
          <StableText k="trade.switch" align="center" />
        )}
      </Button>
    </Card>
  );
}
