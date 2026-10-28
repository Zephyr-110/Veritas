"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { fromUi, toUi } from "@/lib/format";
import { quoteAddLiquidity, quoteWithdrawLiquidity } from "@/lib/quote";
import { ixAddLiquidity, ixGetLiquidity } from "@/lib/instructions";
import { marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";
import { Button, Card, Field, TextInput, useTx } from "./ui";

export function LpDesk({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const { busy, run } = useTx();
  const now = useNow();
  const phase = marketPhase(market, now);
  const [tab, setTab] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("1");

  const parsed = useMemo(() => {
    try {
      return fromUi(amount || "0", market.decimals);
    } catch {
      return 0n;
    }
  }, [amount, market.decimals]);

  const add = quoteAddLiquidity(market.yesPool, market.noPool, market.lpSupply, parsed);
  const remove = quoteWithdrawLiquidity(market.yesPool, market.noPool, market.lpSupply, parsed);

  const disabled =
    !publicKey
      ? "Connect wallet first"
      : parsed <= 0n
        ? "Enter an amount"
        : tab === "add" && !phase.live
          ? "Only live markets can take liquidity"
          : tab === "add" && parsed > position.collateral
            ? "Not enough collateral"
            : tab === "remove" && parsed > position.lp
              ? "Not enough LP"
              : tab === "remove" && market.status === "upcoming"
                ? "Cannot withdraw yet"
                : null;

  const submit = async () => {
    if (!publicKey) return;
    if (tab === "add") {
      await run("Add liquidity", () => ixAddLiquidity(program, market, publicKey, parsed));
    } else {
      await run("Withdraw LP", () => ixGetLiquidity(program, market, publicKey, parsed));
    }
  };

  return (
    <Card>
      <div className="mb-1 font-bold tracking-tight text-2xl">Liquidity</div>
      <p className="mb-4 text-xs leading-relaxed text-mute">
        Deposits mint Yes and No in pool ratio. Leftovers stay in your wallet. Withdrawals return Yes and No,
        not collateral.
      </p>
      <div className="mb-4 flex rounded-md bg-bg p-1">
        {(["add", "remove"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`flex-1 rounded-md py-2 text-sm ${tab === item ? "bg-panel2 text-ink" : "text-mute"}`}
          >
            {item === "add" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>
      <Field
        label={tab === "add" ? "Collateral" : "LP shares"}
        hint={
          tab === "add"
            ? `Balance ${toUi(position.collateral, market.decimals)}`
            : `Held ${toUi(position.lp, market.decimals)}`
        }
      >
        <div className="flex gap-2">
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Button
            type="button"
            tone="ghost"
            onClick={() =>
              setAmount(toUi(tab === "add" ? position.collateral : position.lp, market.decimals, 6))
            }
          >
            MAX
          </Button>
        </div>
      </Field>
      <div className="mt-4 space-y-1 rounded-md bg-bg px-4 py-3 text-sm text-mute">
        {tab === "add" ? (
          <>
            <Row k="Yes in" v={toUi(add.yesIn, market.decimals)} />
            <Row k="No in" v={toUi(add.noIn, market.decimals)} />
            <Row k="LP out" v={toUi(add.lpOut, market.decimals)} />
            {add.leftoverYes > 0n ? <Row k="Leftover Yes" v={toUi(add.leftoverYes, market.decimals)} /> : null}
            {add.leftoverNo > 0n ? <Row k="Leftover No" v={toUi(add.leftoverNo, market.decimals)} /> : null}
          </>
        ) : (
          <>
            <Row k="Yes out" v={toUi(remove.yesOut, market.decimals)} />
            <Row k="No out" v={toUi(remove.noOut, market.decimals)} />
          </>
        )}
      </div>
      <Button type="button" className="mt-5 w-full py-3" disabled={busy || !!disabled} onClick={() => void submit()}>
        {busy ? "Submitting…" : disabled ?? (tab === "add" ? "Add liquidity" : "Withdraw LP")}
      </Button>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span>{k}</span>
      <span className="font-mono text-ink">{v}</span>
    </div>
  );
}
