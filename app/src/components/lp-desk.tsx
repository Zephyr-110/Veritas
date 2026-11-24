"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { COLLATERAL_SYMBOL } from "@/lib/constants";
import { money } from "@/lib/display";
import { formatFixed, fromUi } from "@/lib/format";
import { quoteAddLiquidity, quoteWithdrawLiquidity } from "@/lib/quote";
import { ixAddLiquidity, ixGetLiquidity } from "@/lib/instructions";
import { isFinalizedStatus, marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";
import { Button, Card, Chip, PopNum, SegTabs, StableText, TextInput, openWalletModal, useTx } from "./ui";
import { useT } from "@/i18n/provider";
import { useGuestSession } from "./guest-session";

export function LpDesk({
  market,
  position,
  withdrawOnly = false,
}: {
  market: MarketView;
  position: UserPosition;
  withdrawOnly?: boolean;
}) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const { isSandbox, locked } = useGuestSession();
  const { busy, run } = useTx();
  const now = useNow();
  const t = useT();
  const live = marketPhase(market, now).live;
  const onlyWithdraw = withdrawOnly || isFinalizedStatus(market.status);
  const sim = !publicKey && !isSandbox && !onlyWithdraw;
  const [tab, setTab] = useState<"add" | "withdraw">("add");
  const activeTab = onlyWithdraw ? "withdraw" : tab;
  const [amount, setAmount] = useState("2");
  const [withdrawn, setWithdrawn] = useState(false);

  const parsed = useMemo(() => {
    try {
      return { value: fromUi(amount || "0", market.decimals), invalid: false };
    } catch {
      return { value: 0n, invalid: true };
    }
  }, [amount, market.decimals]);

  const addQuote = quoteAddLiquidity(market.reserveYes, market.reserveNo, market.totalLpShares, parsed.value);
  const wdQuote = quoteWithdrawLiquidity(
    market.reserveYes,
    market.reserveNo,
    market.totalLpShares,
    parsed.value,
    position.pendingYes,
    position.pendingNo
  );

  const disabledReasonKey: { key: string; vars?: Record<string, string | number> } | null = isSandbox
    ? activeTab === "add" && !live
      ? { key: "lpDisable.notLive" }
      : null
    : onlyWithdraw && !publicKey
      ? { key: "lpDisable.connect" }
      : parsed.invalid
        ? { key: "lpDisable.invalid" }
        : parsed.value <= 0n
          ? { key: "lpDisable.enter" }
          : activeTab === "add" && !live
            ? { key: "lpDisable.notLive" }
            : sim
              ? null
              : !publicKey
                ? { key: "lpDisable.connect" }
                : activeTab === "add" && parsed.value > position.collateral
                  ? { key: "lpDisable.noCollateral", vars: { symbol: COLLATERAL_SYMBOL } }
                  : activeTab === "withdraw" && parsed.value > position.lpShares
                    ? { key: "lpDisable.noShares" }
                    : !program
                      ? { key: "errors.badAddress" }
                      : null;

  const submit = async () => {
    if (sim || isSandbox) {
      openWalletModal();
      return;
    }
    if (!publicKey || !program) return;
    if (activeTab === "add") {
      await run(t("tx.addPool"), () => ixAddLiquidity(program, market, publicKey, parsed.value));
    } else {
      const sig = await run(t("tx.withdrawPool"), () => ixGetLiquidity(program, market, publicKey, parsed.value));
      if (sig) setWithdrawn(true);
    }
  };

  return (
    <div id="lp-withdraw" className="scroll-mt-20">
      <Card className="stack-4">
        {onlyWithdraw ? (
          <div className="text-base font-medium text-white">
            <StableText k="lp.finalizedTitle" />
          </div>
        ) : sim ? (
          <div className="flex items-start gap-2.5 border border-[var(--line)] bg-[var(--seg-bg)] px-3 py-2 text-xs leading-5 text-zinc-300">
            <span className="shrink-0 border border-[var(--line)] bg-[var(--card-bg)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-white">
              <StableText k="trade.simBadge" align="center" />
            </span>
            <span className="min-w-0">
              <StableText k="lp.simBanner" block />
            </span>
          </div>
        ) : null}
        <div className="stack-1">
          <p className="text-xs leading-5 text-zinc-500">
            <StableText k="lp.subtitle" vars={{ symbol: COLLATERAL_SYMBOL }} block />
          </p>
          <p className="text-xs leading-5 text-zinc-500">
            <StableText k="lp.feeNote" block />
          </p>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
          <span className="text-zinc-500">
            <StableText k="lp.yourShares" />
            <span className="num ml-1.5 text-zinc-100">{formatFixed(position.lpShares, market.decimals, 2)}</span>
          </span>
          <span className="text-zinc-500">
            <StableText k="lp.poolShares" />
            <span className="num ml-1.5 text-zinc-100">{formatFixed(market.totalLpShares, market.decimals, 2)}</span>
          </span>
          <span className="text-zinc-500">
            <StableText k="common.pending" />
            <span className="num ml-1.5 text-zinc-100">
              {formatFixed(position.pendingYes, market.decimals, 4)} / {formatFixed(position.pendingNo, market.decimals, 4)}
            </span>
          </span>
        </div>
        {onlyWithdraw ? null : (
          <SegTabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "add", label: <StableText k="lp.add" align="center" /> },
              { value: "withdraw", label: <StableText k="lp.withdraw" align="center" /> },
            ]}
          />
        )}
        {!sim && activeTab === "add" ? (
          <div className="text-right text-xs text-zinc-500">
            <StableText
              k="common.balance"
              vars={{ amount: `${formatFixed(position.collateral, market.decimals, 2)} ${COLLATERAL_SYMBOL}` }}
              align="end"
            />
          </div>
        ) : null}
        <TextInput
          inputMode="decimal"
          aria-label={activeTab === "add" ? t("lp.add") : t("lp.withdraw")}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="font-mono tabular-nums"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="yes">
            {t("common.yes")}
            <PopNum text={money(activeTab === "add" ? addQuote.yesIn : wdQuote.yesOut, market.decimals)} />
          </Chip>
          <Chip tone="no">
            {t("common.no")}
            <PopNum text={money(activeTab === "add" ? addQuote.noIn : wdQuote.noOut, market.decimals)} />
          </Chip>
        </div>
        {onlyWithdraw ? null : (
          <p className="text-xs leading-5 text-[var(--warn)]">
            <StableText k="lp.riskNote" block />
          </p>
        )}
        <Button
          type="button"
          busy={busy}
          disabled={busy || (isSandbox && locked) || !!disabledReasonKey}
          onClick={() => void submit()}
        >
          {disabledReasonKey ? (
            <StableText k={disabledReasonKey.key} vars={disabledReasonKey.vars} align="center" />
          ) : isSandbox ? (
            <StableText k={activeTab === "add" ? "lp.sandboxAddSubmit" : "lp.sandboxWithdrawSubmit"} align="center" />
          ) : sim ? (
            <StableText k="lp.simSubmit" align="center" />
          ) : (
            <StableText k={activeTab === "add" ? "lp.addSubmit" : "lp.withdrawSubmit"} align="center" />
          )}
        </Button>
        {withdrawn ? (
          <p className="border border-[var(--yes-line)] bg-[var(--yes-soft)] px-3 py-2 text-xs leading-5 text-[var(--yes)]">
            <StableText k="lp.withdrawnRedeemHint" vars={{ symbol: COLLATERAL_SYMBOL }} block />
          </p>
        ) : null}
      </Card>
    </div>
  );
}
