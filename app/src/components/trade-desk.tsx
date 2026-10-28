"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { DEFAULT_SLIPPAGE_BPS } from "@/lib/constants";
import { fromUi, toUi } from "@/lib/format";
import { applySlippage, quoteBet, quoteSwapOut } from "@/lib/quote";
import { ixSwap, ixUserBetOn } from "@/lib/instructions";
import { marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";
import type { Side } from "@/lib/types";
import { Button, Card, Field, TextInput, useTx } from "./ui";

export function TradeDesk({
  market,
  position,
}: {
  market: MarketView;
  position: UserPosition;
}) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const { busy, run } = useTx();
  const now = useNow();
  const phase = marketPhase(market, now);
  const isOracle = !!publicKey && publicKey.equals(market.oracle);

  const [tab, setTab] = useState<"bet" | "swap">("bet");
  const [side, setSide] = useState<Side>("yes");
  const [amount, setAmount] = useState("1");
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE_BPS);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("side");
    if (q === "yes" || q === "no") setSide(q);
  }, []);

  const parsed = useMemo(() => {
    try {
      return fromUi(amount || "0", market.decimals);
    } catch {
      return 0n;
    }
  }, [amount, market.decimals]);

  const betQuote = quoteBet(market.yesPool, market.noPool, parsed, side);
  const swapOut = quoteSwapOut(
    side === "yes" ? market.yesPool : market.noPool,
    side === "yes" ? market.noPool : market.yesPool,
    parsed
  );
  const sellBalance = side === "yes" ? position.no : position.yes;

  const disabledReason = !publicKey
    ? "Connect wallet first"
    : isOracle
      ? "Oracle cannot trade"
      : !phase.live
        ? "This market is not live"
        : parsed <= 0n
          ? "Enter an amount"
          : tab === "bet" && parsed > position.collateral
            ? "Not enough collateral"
            : tab === "swap" && parsed > sellBalance
              ? "Not enough tokens"
              : null;

  const submit = async () => {
    if (!publicKey) return;
    if (tab === "bet") {
      await run("Buy", () =>
        ixUserBetOn(program, market, publicKey, {
          collateralAmount: parsed,
          tokenType: side,
          minOut: applySlippage(betQuote.swapOut, slippage),
        })
      );
    } else {
      await run("Swap", () =>
        ixSwap(program, market, publicKey, {
          amountIn: parsed,
          tokenType: side,
          minOut: applySlippage(swapOut, slippage),
        })
      );
    }
  };

  return (
    <Card>
      <div className="mb-4 flex rounded-md bg-bg p-1">
        {(["bet", "swap"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`flex-1 rounded-md py-2 text-sm ${tab === item ? "bg-panel2 text-ink" : "text-mute"}`}
          >
            {item === "bet" ? "Buy" : "Swap"}
          </button>
        ))}
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setSide("yes")}
          className={`rounded-xl border px-3 py-3 text-left transition-colors ${
            side === "yes"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              : "border-zinc-800 text-zinc-400 hover:border-zinc-700"
          }`}
        >
          <div className="text-xs">{tab === "bet" ? "Buy Yes" : "Swap to Yes"}</div>
          <div className="text-2xl font-bold tracking-tight">{Math.round((Number.isFinite(market.yesPrice) ? market.yesPrice : 0) * 100)}%</div>
        </button>
        <button
          type="button"
          onClick={() => setSide("no")}
          className={`rounded-xl border px-3 py-3 text-left transition-colors ${
            side === "no"
              ? "border-rose-500/30 bg-rose-500/10 text-rose-400"
              : "border-zinc-800 text-zinc-400 hover:border-zinc-700"
          }`}
        >
          <div className="text-xs">{tab === "bet" ? "Buy No" : "Swap to No"}</div>
          <div className="text-2xl font-bold tracking-tight">{Math.round((Number.isFinite(market.noPrice) ? market.noPrice : 0) * 100)}%</div>
        </button>
      </div>
      <Field
        label={tab === "bet" ? "Collateral" : side === "yes" ? "Sell No" : "Sell Yes"}
        hint={
          tab === "bet"
            ? `Balance ${toUi(position.collateral, market.decimals)}`
            : `Balance ${toUi(sellBalance, market.decimals)}`
        }
      >
        <div className="flex gap-2">
          <TextInput
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
          />
          <Button
            type="button"
            tone="ghost"
            onClick={() =>
              setAmount(toUi(tab === "bet" ? position.collateral : sellBalance, market.decimals, 6))
            }
          >
            MAX
          </Button>
        </div>
      </Field>
      <div className="mt-4 space-y-1 rounded-md bg-bg px-4 py-3 text-sm text-mute">
        {tab === "bet" ? (
          <>
            <div className="flex justify-between">
              <span>Est. {side.toUpperCase()} out</span>
              <span className="font-mono text-ink">{toUi(betQuote.totalOut, market.decimals)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span>Swap portion (slippage protected)</span>
              <span className="font-mono">{toUi(betQuote.swapOut, market.decimals)}</span>
            </div>
          </>
        ) : (
          <div className="flex justify-between">
            <span>Est. {side.toUpperCase()} out</span>
            <span className="font-mono text-ink">{toUi(swapOut, market.decimals)}</span>
          </div>
        )}
        <div className="flex justify-between text-xs">
          <span>Fee 0.30%</span>
          <span>Slippage {slippage / 100}%</span>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        {[50, 100, 300].map((bps) => (
          <button
            key={bps}
            type="button"
            onClick={() => setSlippage(bps)}
            className={`rounded-md px-3 py-1 text-xs ${slippage === bps ? "bg-accent text-bg" : "bg-bg text-mute"}`}
          >
            {bps / 100}%
          </button>
        ))}
      </div>
      <Button
        type="button"
        tone={side === "yes" ? "yes" : "no"}
        className="mt-5 w-full py-3"
        disabled={busy || !!disabledReason}
        onClick={() => void submit()}
      >
        {busy ? "Submitting…" : disabledReason ?? (tab === "bet" ? `Buy ${side.toUpperCase()}` : `Swap to ${side.toUpperCase()}`)}
      </Button>
      {isOracle ? (
        <p className="mt-3 text-xs leading-relaxed text-accent">
          This wallet is the oracle. The program blocks oracle trades. Switch to another wallet to buy.
        </p>
      ) : null}
    </Card>
  );
}
