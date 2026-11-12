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
import { Button, Card, Field, Kv, PopNum, SegTabs, TextInput, useTx } from "./ui";

const PRESETS = ["1", "2", "5", "10"];
const SEG_NEUTRAL = "linear-gradient(to bottom, rgba(255,255,255,0.14), rgba(255,255,255,0.07))";
const SEG_YES = "linear-gradient(to bottom, rgba(52,211,153,0.30), rgba(52,211,153,0.15))";
const SEG_NO = "linear-gradient(to bottom, rgba(251,113,133,0.30), rgba(251,113,133,0.15))";

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

  const disabledReason = !publicKey
    ? t("tradeDisable.connect")
    : !phase.live
      ? t("tradeDisable.ended")
      : parsed.invalid
        ? t("tradeDisable.invalid")
        : parsed.value <= 0n
          ? t("tradeDisable.enter")
          : tab === "bet" && parsed.value > position.collateral
            ? t("tradeDisable.noCollateral", { symbol: COLLATERAL_SYMBOL })
            : tab === "swap" && parsed.value > sellBalance
              ? t("tradeDisable.noShares", { side: otherLabel })
              : !program
                ? t("errors.badAddress")
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
      <div className="text-base font-medium text-white">{t("trade.title")}</div>
      <SegTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "bet", label: t("trade.confirm"), color: SEG_NEUTRAL },
          { value: "swap", label: t("trade.switch"), color: SEG_NEUTRAL },
        ]}
      />
      <SegTabs
        value={side}
        onChange={setSide}
        options={[
          { value: "yes", label: t("trade.buyYes"), color: SEG_YES, activeText: "text-emerald-300" },
          { value: "no", label: t("trade.buyNo"), color: SEG_NO, activeText: "text-rose-300" },
        ]}
      />
      <p className="-mt-2 text-xs leading-5 text-zinc-500">
        {t("trade.gloss", {
          side: sideLabel,
          op: (side === "yes") === market.settleAbove ? "≥" : "<",
          price: thresholdToHuman(market.threshold, market.exponent),
        })}
      </p>
      <Field label={t("trade.youPay")} hint={t("trade.protect", { pct: (slippage / 100).toFixed(1) })}>
        <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono tabular-nums" />
      </Field>
      <div className="-mt-2 text-right text-xs text-zinc-500">
        {t("common.balance", {
          amount:
            tab === "bet"
              ? `${toUi(position.collateral, market.decimals, 2)} ${COLLATERAL_SYMBOL}`
              : `${toUi(sellBalance, market.decimals, 2)} ${otherLabel}`,
        })}
      </div>
      <div className="cluster-2">
        {PRESETS.map((p) => (
          <button key={p} type="button" className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400 transition hover:bg-white/[0.06] active:scale-95" onClick={() => setAmount(p)}>
            {p}
          </button>
        ))}
        <button
          type="button"
          className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400 transition hover:bg-white/[0.06] active:scale-95"
          onClick={() => setAmount(toUi(tab === "bet" ? position.collateral : sellBalance, market.decimals, 6))}
        >
          {t("common.max")}
        </button>
      </div>
      <div className="stack-2 text-sm">
        <Kv
          k={t("trade.youGet")}
          v={<PopNum text={`${toUi(tab === "bet" ? betQuote.totalOut : swapOut, market.decimals, 2)} ${sideLabel}`} />}
        />
        {tab === "bet" && betQuote.totalOut > 0n && parsed.value > 0n ? (
          <Kv k={t("trade.avgPrice")} v={<PopNum text={formatCents(Number(parsed.value) / Number(betQuote.totalOut))} />} />
        ) : null}
        {tab === "swap" ? <p className="text-xs leading-5 text-zinc-500">{t("trade.swapHint")}</p> : null}
        {tab === "bet" && impactPct != null && impactPct > 10 ? (
          <p className="text-xs leading-5 text-amber-300/90">{t("trade.impactWarn", { pct: Math.round(impactPct) })}</p>
        ) : null}
      </div>
      <input
        type="range"
        min={50}
        max={500}
        step={50}
        value={slippage}
        onChange={(e) => setSlippage(Number(e.target.value))}
      />
      <Button type="button" busy={busy} disabled={busy || !!disabledReason} onClick={() => void submit()}>
        {disabledReason ?? (tab === "bet" ? (side === "yes" ? t("trade.buyYes") : t("trade.buyNo")) : t("trade.switch"))}
      </Button>
    </Card>
  );
}
