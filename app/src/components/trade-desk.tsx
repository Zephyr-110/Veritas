"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { COLLATERAL_SYMBOL, DEFAULT_SLIPPAGE_BPS } from "@/lib/constants";
import { money } from "@/lib/display";
import { fromUi, toUi } from "@/lib/format";
import { applySlippage, quoteBet, quoteSwapOut } from "@/lib/quote";
import { ixSwap, ixUserBetOn } from "@/lib/instructions";
import { marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";
import type { Side } from "@/lib/types";
import { useT } from "@/i18n/provider";
import { Button, Card, Field, Kv, TextInput, useTx } from "./ui";

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
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setTab("bet")}
          className={`rounded-xl border px-3 py-2 text-sm ${tab === "bet" ? "border-white bg-white text-zinc-950" : "border-zinc-800 text-zinc-400"}`}
        >
          {t("trade.confirm")}
        </button>
        <button
          type="button"
          onClick={() => setTab("swap")}
          className={`rounded-xl border px-3 py-2 text-sm ${tab === "swap" ? "border-white bg-white text-zinc-950" : "border-zinc-800 text-zinc-400"}`}
        >
          {t("trade.switch")}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" tone={side === "yes" ? "yes" : "secondary"} onClick={() => setSide("yes")}>
          {t("trade.buyYes")}
        </Button>
        <Button type="button" tone={side === "no" ? "no" : "secondary"} onClick={() => setSide("no")}>
          {t("trade.buyNo")}
        </Button>
      </div>
      <Field label={t("trade.youPay")} hint={t("trade.protect", { pct: (slippage / 100).toFixed(1) })}>
        <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono tabular-nums" />
      </Field>
      <div className="cluster-2">
        {PRESETS.map((p) => (
          <button key={p} type="button" className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400" onClick={() => setAmount(p)}>
            {p}
          </button>
        ))}
        <button
          type="button"
          className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400"
          onClick={() => setAmount(toUi(tab === "bet" ? position.collateral : sellBalance, market.decimals, 6))}
        >
          {t("common.max")}
        </button>
      </div>
      <div className="stack-2 text-sm">
        <Kv k={t("trade.youGet")} v={money(tab === "bet" ? betQuote.totalOut : swapOut, market.decimals)} />
        <Kv k={sideLabel} v={toUi(side === "yes" ? position.yes : position.no, market.decimals, 2)} />
      </div>
      <input
        type="range"
        min={50}
        max={500}
        step={50}
        value={slippage}
        onChange={(e) => setSlippage(Number(e.target.value))}
      />
      <Button type="button" disabled={busy || !!disabledReason} onClick={() => void submit()}>
        {busy ? t("state.confirming") : disabledReason ?? (tab === "bet" ? (side === "yes" ? t("trade.buyYes") : t("trade.buyNo")) : t("trade.switch"))}
      </Button>
    </Card>
  );
}
