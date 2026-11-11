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
import { Button, Card, Field, Kv, TextInput, useTx } from "./ui";

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
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Kv k={t("lp.yourShares")} v={toUi(position.lpShares, market.decimals, 2)} />
        <Kv k={t("lp.poolShares")} v={toUi(market.totalLpShares, market.decimals, 2)} />
        <Kv k={t("lp.pendingYes")} v={toUi(position.pendingYes, market.decimals, 4)} />
        <Kv k={t("lp.pendingNo")} v={toUi(position.pendingNo, market.decimals, 4)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" tone={tab === "add" ? "primary" : "secondary"} onClick={() => setTab("add")}>
          {t("lp.add")}
        </Button>
        <Button type="button" tone={tab === "withdraw" ? "primary" : "secondary"} onClick={() => setTab("withdraw")}>
          {t("lp.withdraw")}
        </Button>
      </div>
      <Field label={tab === "add" ? t("lp.add") : t("lp.withdraw")}>
        <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono tabular-nums" />
      </Field>
      <div className="stack-2 text-sm">
        {tab === "add" ? (
          <>
            <Kv k={t("common.yes")} v={money(addQuote.yesIn, market.decimals)} />
            <Kv k={t("common.no")} v={money(addQuote.noIn, market.decimals)} />
          </>
        ) : (
          <>
            <Kv k={t("common.yes")} v={money(wdQuote.yesOut, market.decimals)} />
            <Kv k={t("common.no")} v={money(wdQuote.noOut, market.decimals)} />
          </>
        )}
      </div>
      <Button type="button" disabled={busy || !!disabled} onClick={() => void submit()}>
        {busy ? t("state.confirming") : disabled ?? (tab === "add" ? t("lp.addSubmit") : t("lp.withdrawSubmit"))}
      </Button>
    </Card>
  );
}
