"use client";

import { useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { COLLATERAL_SYMBOL, MAX_SETTLE_DELAY } from "@/lib/constants";
import { money, resolveHours } from "@/lib/display";
import { explorerTx, fromUi, toUi } from "@/lib/format";
import { ixGetCollateral, ixMergeToken, ixVoidMarket } from "@/lib/instructions";
import { marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { postPythAndResolve } from "@/lib/resolve-post";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";
import { useRefresh, useSettings, useToasts } from "./providers";
import type { Side } from "@/lib/types";
import { useT } from "@/i18n/provider";
import { Button, Card, Field, TextInput, useTx } from "./ui";

export function SettleDesk({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const { busy, run } = useTx();
  const now = useNow();
  const t = useT();
  const phase = marketPhase(market, now);
  const mergeable = position.yes < position.no ? position.yes : position.no;
  const winningAmount = market.status === "resolved" ? (market.winner === "yes" ? position.yes : position.no) : 0n;
  const canMerge = market.status === "open" && mergeable > 0n;
  const canClaimWinner = market.status === "resolved" && winningAmount > 0n;
  const canClaimVoid = market.status === "burn" && (position.yes > 1n || position.no > 1n);
  const showResolve = market.status === "open" && phase.expired;

  return (
    <div className="stack-4">
      {canMerge || canClaimWinner || canClaimVoid ? (
        <Card className="stack-4">
          {canMerge ? (
            <>
              <p className="text-sm text-zinc-400">{t("settle.mergeBody", { symbol: COLLATERAL_SYMBOL })}</p>
              <Button
                type="button"
                disabled={busy || !publicKey || !program}
                onClick={() => publicKey && program && run(t("tx.cashOut"), () => ixMergeToken(program, market, publicKey, mergeable))}
              >
                {t("settle.cashOut", { amount: money(mergeable, market.decimals) })}
              </Button>
            </>
          ) : null}
          {canClaimWinner && program ? (
            <Button
              type="button"
              tone={market.winner === "yes" ? "yes" : "no"}
              disabled={busy || !publicKey}
              onClick={() => {
                if (!publicKey) return;
                const mint = market.winner === "yes" ? market.pdas.yesMint : market.pdas.noMint;
                return run(t("tx.collectWinnings"), () => ixGetCollateral(program, market, publicKey, mint, winningAmount));
              }}
            >
              {t("settle.collectAmount", { amount: money(winningAmount, market.decimals) })}
            </Button>
          ) : null}
          {canClaimVoid ? <VoidClaim market={market} position={position} /> : null}
        </Card>
      ) : null}

      {showResolve ? (
        <Card className="stack-4">
          <div>
            <div className="text-base font-medium text-white">{t("settle.resolveTitle")}</div>
            <p className="mt-1 text-sm text-zinc-500">
              {t("settle.resolveBody", { hours: resolveHours(), delay: MAX_SETTLE_DELAY })}
            </p>
          </div>
          <div className="cluster-2">
            <ResolveButton market={market} />
            <Button
              type="button"
              tone="secondary"
              disabled={busy || !phase.afterWindow || !publicKey || !program}
              onClick={() => publicKey && program && run(t("tx.cancelMarket"), () => ixVoidMarket(program, market, publicKey))}
            >
              {t("settle.cancelRefund")}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function ResolveButton({ market }: { market: MarketView }) {
  const program = useProgram();
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { push } = useToasts();
  const { bump } = useRefresh();
  const { settings } = useSettings();
  const t = useT();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (!program || !wallet) return;
    setBusy(true);
    try {
      const sigs = await postPythAndResolve(connection, wallet, program, market);
      const sig = sigs[0];
      const link = sig ? explorerTx(sig, settings.cluster) : null;
      push("ok", t("tx.submitResolve"), link ? t("tx.view") : t("tx.confirmed"), link ?? undefined);
      bump();
    } catch (err) {
      push("err", t("tx.failed", { label: t("tx.submitResolve") }), parseTxError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button type="button" disabled={busy || !wallet || !program} onClick={() => void onClick()}>
      {busy ? t("state.confirming") : t("settle.submitResolve")}
    </Button>
  );
}

function VoidClaim({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const { busy, run } = useTx();
  const t = useT();
  const [side, setSide] = useState<Side>(position.yes >= position.no ? "yes" : "no");
  const max = side === "yes" ? position.yes : position.no;
  const even = max - (max % 2n);
  const [amount, setAmount] = useState(toUi(even, market.decimals, 6));
  const parsed = useMemo(() => {
    try {
      return { value: fromUi(amount || "0", market.decimals), invalid: false };
    } catch {
      return { value: 0n, invalid: true };
    }
  }, [amount, market.decimals]);

  return (
    <div className="w-full stack-3 rounded-2xl border border-zinc-800 p-4">
      <div className="cluster-2">
        <Button type="button" tone={side === "yes" ? "yes" : "secondary"} onClick={() => setSide("yes")}>
          {t("settle.refundYes")}
        </Button>
        <Button type="button" tone={side === "no" ? "no" : "secondary"} onClick={() => setSide("no")}>
          {t("settle.refundNo")}
        </Button>
      </div>
      <Field label={t("settle.sharesToRefund")} hint={t("settle.evenHint")}>
        <TextInput value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono tabular-nums" />
      </Field>
      <Button
        type="button"
        disabled={busy || !publicKey || !program || parsed.invalid || parsed.value < 2n || parsed.value > max}
        onClick={() => {
          if (!publicKey || !program) return;
          const mint = side === "yes" ? market.pdas.yesMint : market.pdas.noMint;
          return run(t("tx.collectRefund"), () => ixGetCollateral(program, market, publicKey, mint, parsed.value));
        }}
      >
        {t("settle.collectAmount", { amount: money(parsed.value / 2n, market.decimals) })}
      </Button>
    </div>
  );
}
