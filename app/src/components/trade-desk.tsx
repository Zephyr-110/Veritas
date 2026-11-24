"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { COLLATERAL_SYMBOL, DEFAULT_SLIPPAGE_BPS } from "@/lib/constants";
import { formatCents, formatFixed, fromUi, toUi } from "@/lib/format";
import { money } from "@/lib/display";
import { thresholdToHuman } from "@/lib/feeds";
import { applySlippage, pmAmmAccrue, quoteBet, quoteSwapOut } from "@/lib/quote";
import { ixSwap, ixUserBetOn } from "@/lib/instructions";
import { marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";
import type { Side } from "@/lib/types";
import { useT } from "@/i18n/provider";
import { Button, Card, Field, Kv, PopNum, SegTabs, StableText, TextInput, openWalletModal, useTx } from "./ui";
import { FaucetClaimButton } from "./faucet-claim";
import { useGuestSession, useSandboxTx } from "./guest-session";

const PRESETS = ["1", "2", "5", "10"];

export function TradeDesk({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { publicKey: realPublicKey } = useWallet();
  const { isSandbox, effectivePublicKey, enterSandbox, refillSandbox, refillNotice, locked, lastError } =
    useGuestSession();
  const { busy, run } = useTx();
  const { busy: sandboxBusy, runSandbox } = useSandboxTx();
  const now = useNow();
  const t = useT();
  const phase = marketPhase(market, now);
  const sim = !effectivePublicKey;
  const anyBusy = busy || sandboxBusy;

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

  const hasPmAmm = Boolean(market.lZero && market.lZero > 0n);
  const accrued = useMemo(
    () => (hasPmAmm ? pmAmmAccrue(market, now > 0 ? now : market.lastAccrualTs) : null),
    [hasPmAmm, market, now]
  );
  const effYes = accrued ? BigInt(Math.max(1, Math.round(accrued.reserveYes))) : market.reserveYes;
  const effNo = accrued ? BigInt(Math.max(1, Math.round(accrued.reserveNo))) : market.reserveNo;
  const effL = accrued && accrued.lEff > 0 ? accrued.lEff : undefined;

  const betQuote = quoteBet(effYes, effNo, parsed.value, side, effL);
  const baseYesPrice = accrued ? accrued.yesPrice : market.yesPrice;
  const curSideCents = (side === "yes" ? baseYesPrice : 1 - baseYesPrice) * 100;
  const avgCents =
    betQuote.totalOut > 0n && parsed.value > 0n ? (Number(parsed.value) / Number(betQuote.totalOut)) * 100 : null;
  const impactPct = avgCents != null && curSideCents > 0 ? (avgCents / curSideCents - 1) * 100 : null;
  const swapOut = quoteSwapOut(
    side === "yes" ? effYes : effNo,
    side === "yes" ? effNo : effYes,
    parsed.value,
    effL
  );
  const sellBalance = side === "yes" ? position.no : position.yes;
  const sideLabel = side === "yes" ? t("common.yes") : t("common.no");
  const otherLabel = side === "yes" ? t("common.no") : t("common.yes");

  const sandboxSwapBlocked = isSandbox && tab === "swap";

  const disabledReasonKey: { key: string; vars?: Record<string, string | number> } | null = !phase.live
    ? { key: "tradeDisable.ended" }
    : sandboxSwapBlocked
      ? null
      : parsed.invalid
        ? { key: "tradeDisable.invalid" }
        : parsed.value <= 0n
          ? { key: "tradeDisable.enter" }
          : sim
            ? null
            : tab === "bet" && parsed.value > position.collateral
              ? { key: "tradeDisable.noCollateral", vars: { symbol: COLLATERAL_SYMBOL } }
              : tab === "swap" && parsed.value > sellBalance
                ? { key: "tradeDisable.noShares", vars: { side: otherLabel } }
                : !program
                  ? { key: "errors.badAddress" }
                  : null;

  const submit = async () => {
    if (sim || sandboxSwapBlocked) {
      openWalletModal();
      return;
    }
    if (!effectivePublicKey || !program) return;
    if (tab === "bet") {
      const label = side === "yes" ? t("tx.buyYes") : t("tx.buyNo");
      const build = () =>
        ixUserBetOn(program, market, effectivePublicKey, {
          collateralAmount: parsed.value,
          tokenType: side,
          minOut: applySlippage(betQuote.swapOut, slippage),
        });
      if (isSandbox) {
        await runSandbox(label, build);
      } else if (realPublicKey) {
        await run(label, build);
      }
    } else if (realPublicKey) {
      await run(side === "yes" ? t("tx.switchYes") : t("tx.switchNo"), () =>
        ixSwap(program, market, realPublicKey, {
          amountIn: parsed.value,
          tokenType: side,
          minOut: applySlippage(swapOut, slippage),
        })
      );
    }
  };

  const outShares = tab === "bet" ? betQuote.totalOut : swapOut;
  const submitLabelKey = sim
    ? tab === "bet"
      ? side === "yes"
        ? "trade.simSubmitBuyYes"
        : "trade.simSubmitBuyNo"
      : "trade.simSubmitSwap"
    : sandboxSwapBlocked
      ? "trade.sandboxSwapCta"
      : tab === "bet"
        ? side === "yes"
          ? "trade.buyYes"
          : "trade.buyNo"
        : "trade.switch";

  return (
    <Card className="desk flex flex-col gap-4">
      {sim ? (
        <div className="flex items-start gap-2.5 border border-[var(--line)] bg-[var(--seg-bg)] px-3 py-2 text-xs leading-5 text-zinc-300">
          <span className="shrink-0 border border-[var(--line)] bg-[var(--card-bg)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-white">
            <StableText k="trade.simBadge" align="center" />
          </span>
          <div className="min-w-0">
            <StableText k="trade.simBanner" block />
            <button
              type="button"
              disabled={locked}
              onClick={() => void enterSandbox()}
              className="link-accent mt-1 inline-block text-left text-xs font-medium disabled:opacity-50"
            >
              <StableText k="sandbox.tryInline" />
            </button>
            {lastError ? (
              <p
                role="alert"
                className="mt-2 border border-[var(--no)]/45 bg-[var(--no-soft)] px-2.5 py-1.5 text-xs leading-relaxed text-[var(--no)]"
              >
                {lastError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
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
      {sim ? null : (
        <div className="-mt-2 text-right text-xs text-zinc-500">
          <StableText
            k="common.balance"
            vars={{
              amount:
                tab === "bet"
                  ? `${formatFixed(position.collateral, market.decimals, 2)} ${COLLATERAL_SYMBOL}`
                  : `${formatFixed(sellBalance, market.decimals, 2)} ${otherLabel}`,
            }}
            align="end"
          />
        </div>
      )}
      {!sim && tab === "bet" && position.collateral === 0n ? (
        <div className="-mt-2 flex justify-end">
          {isSandbox ? (
            <Button
              type="button"
              tone="secondary"
              className="h-8 px-3 text-xs"
              busy={locked}
              disabled={locked}
              onClick={() => void refillSandbox()}
            >
              <StableText k="sandbox.refillBtn" align="center" />
            </Button>
          ) : (
            <FaucetClaimButton className="h-8 px-3 text-xs" />
          )}
        </div>
      ) : null}
      {isSandbox && refillNotice && <p role="status" className="text-xs text-zinc-300"><StableText k={refillNotice} /></p>}
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
        {sim || sandboxSwapBlocked ? null : (
          <button
            type="button"
            className="border border-[var(--hair)] px-3 py-1 text-xs text-zinc-400 transition hover:border-[var(--line)] hover:text-white active:scale-95"
            onClick={() => setAmount(toUi(tab === "bet" ? position.collateral : sellBalance, market.decimals, 6))}
          >
            <StableText k="common.max" align="center" />
          </button>
        )}
      </div>
      <div className="stack-2 text-sm">
        <Kv
          k={<StableText k={sim ? "trade.simYouGet" : "trade.youGet"} />}
          v={<PopNum text={`${formatFixed(outShares, market.decimals, 2)} ${sideLabel}`} />}
        />
        {tab === "bet" && betQuote.totalOut > 0n && parsed.value > 0n ? (
          <Kv
            k={<StableText k={sim ? "trade.simAvgPrice" : "trade.avgPrice"} />}
            v={<PopNum text={formatCents(Number(parsed.value) / Number(betQuote.totalOut))} />}
          />
        ) : null}
        {sim && outShares > 0n ? (
          <Kv
            k={<StableText k="trade.simPayout" />}
            v={<PopNum text={money(outShares, market.decimals)} />}
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
      <Button
        type="button"
        busy={anyBusy}
        disabled={anyBusy || (isSandbox && locked) || !!disabledReasonKey}
        onClick={() => void submit()}
      >
        {disabledReasonKey ? (
          <StableText k={disabledReasonKey.key} vars={disabledReasonKey.vars} align="center" />
        ) : (
          <StableText k={submitLabelKey} align="center" />
        )}
      </Button>
    </Card>
  );
}
