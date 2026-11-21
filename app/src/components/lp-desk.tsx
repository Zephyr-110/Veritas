"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { COLLATERAL_SYMBOL } from "@/lib/constants";
import { money } from "@/lib/display";
import { fromUi, toUi } from "@/lib/format";
import { quoteAddLiquidity, quoteWithdrawLiquidity } from "@/lib/quote";
import { ixAddLiquidity, ixGetLiquidity } from "@/lib/instructions";
import { marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";
import { Button, Card, Chip, PopNum, SegTabs, StableText, TextInput, useTx } from "./ui";
import { useT } from "@/i18n/provider";

export function LpDesk({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const { busy, run } = useTx();
  const now = useNow();
  const t = useT();
  const live = marketPhase(market, now).live;
  const [tab, setTab] = useState<"add" | "withdraw">("add");
  const [amount, setAmount] = useState("2");

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

  const disabledReasonKey: { key: string; vars?: Record<string, string | number> } | null = !publicKey
    ? { key: "lpDisable.connect" }
    : parsed.invalid
      ? { key: "lpDisable.invalid" }
      : parsed.value <= 0n
        ? { key: "lpDisable.enter" }
        : tab === "add" && !live
          ? { key: "lpDisable.notLive" }
          : tab === "add" && parsed.value > position.collateral
            ? { key: "lpDisable.noCollateral", vars: { symbol: COLLATERAL_SYMBOL } }
            : tab === "withdraw" && parsed.value > position.lpShares
              ? { key: "lpDisable.noShares" }
              : !program
                ? { key: "errors.badAddress" }
                : null;

  const submit = async () => {
    if (!publicKey || !program) return;
    if (tab === "add") {
      await run(t("tx.addPool"), () => ixAddLiquidity(program, market, publicKey, parsed.value));
    } else {
      await run(t("tx.withdrawPool"), () => ixGetLiquidity(program, market, publicKey, parsed.value));
    }
  };

  return (
    <Card className="stack-4">
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
          <span className="num ml-1.5 text-zinc-100">{toUi(position.lpShares, market.decimals, 2)}</span>
        </span>
        <span className="text-zinc-500">
          <StableText k="lp.poolShares" />
          <span className="num ml-1.5 text-zinc-100">{toUi(market.totalLpShares, market.decimals, 2)}</span>
        </span>
        <span className="text-zinc-500">
          <StableText k="common.pending" />
          <span className="num ml-1.5 text-zinc-100">
            {toUi(position.pendingYes, market.decimals, 4)} / {toUi(position.pendingNo, market.decimals, 4)}
          </span>
        </span>
      </div>
      <SegTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "add", label: <StableText k="lp.add" align="center" /> },
          { value: "withdraw", label: <StableText k="lp.withdraw" align="center" /> },
        ]}
      />
      {tab === "add" ? (
        <div className="text-right text-xs text-zinc-500">
          <StableText
            k="common.balance"
            vars={{ amount: `${toUi(position.collateral, market.decimals, 2)} ${COLLATERAL_SYMBOL}` }}
            align="end"
          />
        </div>
      ) : null}
      <TextInput
        inputMode="decimal"
        aria-label={tab === "add" ? t("lp.add") : t("lp.withdraw")}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="font-mono tabular-nums"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="yes">
          {t("common.yes")}
          <PopNum text={money(tab === "add" ? addQuote.yesIn : wdQuote.yesOut, market.decimals)} />
        </Chip>
        <Chip tone="no">
          {t("common.no")}
          <PopNum text={money(tab === "add" ? addQuote.noIn : wdQuote.noOut, market.decimals)} />
        </Chip>
      </div>
      <p className="text-xs leading-5 text-[var(--warn)]">
        <StableText k="lp.riskNote" block />
      </p>
      <Button type="button" busy={busy} disabled={busy || !!disabledReasonKey} onClick={() => void submit()}>
        {disabledReasonKey ? (
          <StableText k={disabledReasonKey.key} vars={disabledReasonKey.vars} align="center" />
        ) : (
          <StableText k={tab === "add" ? "lp.addSubmit" : "lp.withdrawSubmit"} align="center" />
        )}
      </Button>
    </Card>
  );
}
