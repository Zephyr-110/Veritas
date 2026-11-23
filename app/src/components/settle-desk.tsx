"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  COLLATERAL_SYMBOL,
  MAX_SETTLE_DELAY,
  SNAPSHOT_MAX_ENTRIES,
  SNAPSHOT_WINDOW,
} from "@/lib/constants";
import { isMarketVoided, money, resolveHours } from "@/lib/display";
import { feedByState } from "@/lib/feeds";
import { explorerTx, fromUi, toUi } from "@/lib/format";
import {
  ixBurnAccount,
  ixGetCollateral,
  ixMergeToken,
  ixResolveMarket,
  ixTakeSnapshot,
  ixVoidMarket,
} from "@/lib/instructions";
import {
  fetchMarketSnapshot,
  marketPhase,
  type MarketView,
  type UserPosition,
} from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { findStraddlingReports, resolveMarketWithChainlink } from "@/lib/resolve";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";
import { useRefresh, useSettings, useToasts } from "./providers";
import type { Side } from "@/lib/types";
import { useT } from "@/i18n/provider";
import { Button, Card, Field, SegTabs, StableText, TextInput, openWalletModal, useTx } from "./ui";
import { useGuestSession, useSandboxTx } from "./guest-session";

export function SettleDesk({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { publicKey: realPublicKey } = useWallet();
  const { effectivePublicKey, isSandbox, locked } = useGuestSession();
  const { busy, run } = useTx();
  const { busy: sandboxBusy, runSandbox } = useSandboxTx();
  const anyBusy = busy || sandboxBusy;
  const now = useNow();
  const t = useT();
  const phase = marketPhase(market, now);
  const mergeable = position.yes < position.no ? position.yes : position.no;
  const winningAmount =
    market.status === "resolved"
      ? market.winner === "yes"
        ? position.yes
        : position.no
      : 0n;
  const canMerge = market.status === "open" && mergeable > 0n;
  const canClaimWinner = market.status === "resolved" && winningAmount > 0n;
  const canClaimVoid = isMarketVoided(market) && (position.yes > 1n || position.no > 1n);
  const showSnapshot = phase.inSnapshotWindow && !isSandbox;
  const showResolve = market.status === "open" && phase.expired;
  const isCreator = Boolean(realPublicKey && realPublicKey.equals(market.creator));
  const showBurn = phase.canBurn && isCreator;

  return (
    <div className="stack-4">
      {canMerge || canClaimWinner || canClaimVoid ? (
        <Card className="stack-4">
          {canMerge ? (
            <>
              <p className="text-sm text-zinc-400">
                <StableText k="settle.mergeBody" vars={{ symbol: COLLATERAL_SYMBOL }} block />
              </p>
              {isSandbox ? (
                <Button
                  type="button"
                  tone="secondary"
                  disabled={locked}
                  onClick={() => openWalletModal()}
                >
                  <StableText
                    k="settle.sandboxMergeCta"
                    vars={{ amount: money(mergeable, market.decimals) }}
                    align="center"
                  />
                </Button>
              ) : (
                <Button
                  type="button"
                  busy={busy}
                  disabled={busy || !realPublicKey || !program}
                  onClick={() =>
                    realPublicKey &&
                    program &&
                    run(t("tx.cashOut"), () => ixMergeToken(program, market, realPublicKey, mergeable))
                  }
                >
                  <StableText
                    k="settle.cashOut"
                    vars={{ amount: money(mergeable, market.decimals) }}
                    align="center"
                  />
                </Button>
              )}
            </>
          ) : null}
          {canClaimWinner && program ? (
            <Button
              type="button"
              tone={market.winner === "yes" ? "yes" : "no"}
              busy={anyBusy}
              disabled={anyBusy || (isSandbox && locked) || !effectivePublicKey}
              onClick={() => {
                if (!effectivePublicKey) return;
                const mint = market.winner === "yes" ? market.pdas.yesMint : market.pdas.noMint;
                const build = () =>
                  ixGetCollateral(program, market, effectivePublicKey, mint, winningAmount);
                if (isSandbox) {
                  return runSandbox(t("tx.collectWinnings"), build);
                }
                return run(t("tx.collectWinnings"), build);
              }}
            >
              <StableText
                k="settle.collectAmount"
                vars={{ amount: money(winningAmount, market.decimals) }}
                align="center"
              />
            </Button>
          ) : null}
          {canClaimVoid ? <VoidClaim market={market} position={position} /> : null}
        </Card>
      ) : null}

      {showSnapshot ? <SnapshotCard market={market} now={now} /> : null}

      {showResolve ? (
        isSandbox ? (
          <Card className="stack-3">
            <div className="flex items-center gap-2 text-base font-medium text-white">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />
              <StableText k="settle.sandboxPollingTitle" />
            </div>
            <p className="text-sm leading-relaxed text-zinc-400">
              <StableText k="settle.sandboxPollingBody" block />
            </p>
            <div className="cluster-2">
              <SandboxResolveButton market={market} disabled={phase.afterWindow} />
            </div>
            {phase.afterWindow ? (
              <p className="text-xs leading-5 text-[var(--warn)]">
                <StableText k="settle.windowClosed" block />
              </p>
            ) : null}
          </Card>
        ) : (
          <Card className="stack-4">
            <div>
              <div className="text-base font-medium text-white">
                <StableText k={phase.afterWindow ? "settle.cancelRefund" : "settle.resolveTitle"} />
              </div>
              <p className="mt-1 text-sm text-zinc-500">
                <StableText
                  k="settle.resolveBody"
                  vars={{ hours: resolveHours(), delay: MAX_SETTLE_DELAY }}
                  block
                />
              </p>
            </div>
            <div className="cluster-2">
              <ResolveButton market={market} disabled={phase.afterWindow} />
              <Button
                type="button"
                tone={phase.afterWindow ? "primary" : "secondary"}
                busy={busy}
                disabled={busy || !phase.afterWindow || !realPublicKey || !program}
                onClick={() =>
                  realPublicKey &&
                  program &&
                  run(t("tx.cancelMarket"), () => ixVoidMarket(program, market, realPublicKey))
                }
              >
                <StableText k="settle.cancelRefund" align="center" />
              </Button>
            </div>
            {phase.afterWindow ? (
              <p className="text-xs leading-5 text-[var(--warn)]">
                <StableText k="settle.windowClosed" block />
              </p>
            ) : null}
          </Card>
        )
      ) : null}

      {showBurn ? (
        <Card className="stack-4">
          <div>
            <div className="text-base font-medium text-white">
              <StableText k="settle.burnTitle" />
            </div>
            <p className="mt-1 text-sm text-zinc-500">
              <StableText k="settle.burnBody" block />
            </p>
          </div>
          <Button
            type="button"
            tone="secondary"
            busy={busy}
            disabled={busy || !realPublicKey || !program}
            onClick={() =>
              realPublicKey &&
              program &&
              run(t("tx.burnAccount"), () => ixBurnAccount(program, market, realPublicKey))
            }
          >
            <StableText k="settle.burnSubmit" align="center" />
          </Button>
        </Card>
      ) : null}
    </div>
  );
}

function SnapshotCard({ market, now }: { market: MarketView; now: number }) {
  const program = useProgram();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { busy, run } = useTx();
  const { nonce } = useRefresh();
  const t = useT();
  const [count, setCount] = useState<number | null>(null);
  const preset = feedByState(market.ocr2State);
  const secsLeft = Math.max(1, market.endTs + SNAPSHOT_WINDOW - now);

  useEffect(() => {
    let alive = true;
    void fetchMarketSnapshot(connection, market.pdas.snapshot).then((snap) => {
      if (alive) setCount(snap ? snap.entries.length : 0);
    });
    return () => {
      alive = false;
    };
  }, [connection, market.pdas.snapshot, nonce]);

  if (!preset) return null;
  const full = count != null && count >= SNAPSHOT_MAX_ENTRIES;

  return (
    <Card className="stack-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-base font-medium text-white">
          <StableText k="settle.snapshotTitle" />
        </div>
        {count != null ? (
          <span className="num text-xs text-zinc-400">
            <StableText k="settle.snapshotCount" vars={{ count, max: SNAPSHOT_MAX_ENTRIES }} align="end" />
          </span>
        ) : null}
      </div>
      <p className="text-sm text-zinc-500">
        <StableText k="settle.snapshotBody" vars={{ secs: secsLeft }} block />
      </p>
      <Button
        type="button"
        tone="secondary"
        busy={busy}
        disabled={busy || full || !publicKey || !program}
        onClick={() =>
          publicKey &&
          program &&
          run(t("tx.takeSnapshot"), () =>
            ixTakeSnapshot(program, market, publicKey, new PublicKey(preset.feed))
          )
        }
      >
        <StableText k="settle.snapshotSubmit" align="center" />
      </Button>
    </Card>
  );
}

function ResolveButton({ market, disabled = false }: { market: MarketView; disabled?: boolean }) {
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
      const sig = await resolveMarketWithChainlink(connection, wallet, program, market);
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
    <Button
      type="button"
      busy={busy}
      disabled={busy || disabled || !wallet || !program}
      onClick={() => void onClick()}
    >
      <StableText k="settle.submitResolve" align="center" />
    </Button>
  );
}

function SandboxResolveButton({
  market,
  disabled = false,
}: {
  market: MarketView;
  disabled?: boolean;
}) {
  const program = useProgram();
  const { connection } = useConnection();
  const { effectivePublicKey, isSandbox, locked } = useGuestSession();
  const { busy: sandboxBusy, runSandbox } = useSandboxTx();
  const t = useT();

  const onClick = () => {
    if (!program || !isSandbox || !effectivePublicKey) return;
    void runSandbox(t("tx.submitResolve"), async () => {
      const snapshot = await fetchMarketSnapshot(connection, market.pdas.snapshot);
      const found = await findStraddlingReports(connection, market.ocr2State, market.endTs, snapshot);
      return ixResolveMarket(program, market, effectivePublicKey, {
        rawPre: found.pre.raw,
        rawPost: found.post.raw,
        hasSnapshot: found.hasSnapshot,
      });
    });
  };

  return (
    <Button
      type="button"
      tone="secondary"
      busy={sandboxBusy}
      disabled={sandboxBusy || locked || disabled || !isSandbox || !effectivePublicKey || !program}
      onClick={onClick}
    >
      <StableText k="settle.sandboxManualResolve" align="center" />
    </Button>
  );
}

function VoidClaim({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { effectivePublicKey, isSandbox, locked } = useGuestSession();
  const { busy, run } = useTx();
  const { busy: sandboxBusy, runSandbox } = useSandboxTx();
  const anyBusy = busy || sandboxBusy;
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
    <div className="w-full stack-3 border border-[var(--hair)] bg-[var(--seg-bg)] p-4">
      <SegTabs
        value={side}
        onChange={setSide}
        options={[
          {
            value: "yes",
            label: <StableText k="settle.refundYes" align="center" />,
            color: "var(--yes-soft)",
            activeText: "text-[var(--yes)]",
          },
          {
            value: "no",
            label: <StableText k="settle.refundNo" align="center" />,
            color: "var(--no-soft)",
            activeText: "text-[var(--no)]",
          },
        ]}
      />
      <Field label={<StableText k="settle.sharesToRefund" />} hint={<StableText k="settle.evenHint" />}>
        <TextInput
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="font-mono tabular-nums"
        />
      </Field>
      <Button
        type="button"
        busy={anyBusy}
        disabled={
          anyBusy ||
          (isSandbox && locked) ||
          !effectivePublicKey ||
          !program ||
          parsed.invalid ||
          parsed.value < 2n ||
          parsed.value > max
        }
        onClick={() => {
          if (!effectivePublicKey || !program) return;
          const mint = side === "yes" ? market.pdas.yesMint : market.pdas.noMint;
          const build = () =>
            ixGetCollateral(program, market, effectivePublicKey, mint, parsed.value);
          if (isSandbox) {
            return runSandbox(t("tx.collectRefund"), build);
          }
          return run(t("tx.collectRefund"), build);
        }}
      >
        <StableText
          k="settle.collectAmount"
          vars={{ amount: money(parsed.value / 2n, market.decimals) }}
          align="center"
        />
      </Button>
    </div>
  );
}
