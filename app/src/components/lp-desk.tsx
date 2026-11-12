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
import { useT } from "@/i18n/provider";
import { Button, Card, Chip, PopNum, SegTabs, TextInput, useTx } from "./ui";

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

  const disabled =
    !publicKey
      ? t("lpDisable.connect")
      : parsed.invalid
        ? t("lpDisable.invalid")
        : parsed.value <= 0n
          ? t("lpDisable.enter")
          : tab === "add" && !live
            ? t("lpDisable.notLive")
            : tab === "add" && parsed.value > position.collateral
              ? t("lpDisable.noCollateral", { symbol: COLLATERAL_SYMBOL })
              : tab === "withdraw" && parsed.value > position.lpShares
                ? t("lpDisable.noShares")
                : !program
                  ? t("errors.badAddress")
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
      <div>
        <div className="text-base font-medium text-white">{t("lp.title")}</div>
        <p className="mt-1 text-xs text-zinc-500">{t("lp.subtitle", { symbol: COLLATERAL_SYMBOL })}</p>
        <p className="mt-1 text-xs text-zinc-500">{t("lp.feeNote")}</p>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        <span className="text-zinc-500">
          {t("lp.yourShares")}
          <span className="num ml-1.5 text-zinc-100">{toUi(position.lpShares, market.decimals, 2)}</span>
        </span>
        <span className="text-zinc-500">
          {t("lp.poolShares")}
          <span className="num ml-1.5 text-zinc-100">{toUi(market.totalLpShares, market.decimals, 2)}</span>
        </span>
        <span className="text-zinc-500">
          {t("common.pending")}
          <span className="num ml-1.5 text-zinc-100">
            {toUi(position.pendingYes, market.decimals, 4)} / {toUi(position.pendingNo, market.decimals, 4)}
          </span>
        </span>
      </div>
      <SegTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "add", label: t("lp.add"), color: "linear-gradient(to bottom, rgba(255,255,255,0.14), rgba(255,255,255,0.07))" },
          { value: "withdraw", label: t("lp.withdraw"), color: "linear-gradient(to bottom, rgba(255,255,255,0.14), rgba(255,255,255,0.07))" },
        ]}
      />
      {tab === "add" ? (
        <div className="text-right text-xs text-zinc-500">
          {t("common.balance", { amount: `${toUi(position.collateral, market.decimals, 2)} ${COLLATERAL_SYMBOL}` })}
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
      <p className="text-xs leading-5 text-amber-300/80">{t("lp.riskNote")}</p>
      <Button type="button" busy={busy} disabled={busy || !!disabled} onClick={() => void submit()}>
        {disabled ?? (tab === "add" ? t("lp.addSubmit") : t("lp.withdrawSubmit"))}
      </Button>
    </Card>
  );
}
