"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  claimableOf,
  fetchMarketSnapshot,
  marketPhase,
  type MarketView,
  type UserPosition,
} from "@/lib/markets";
import { parseTxError, isSubmissionRejection } from "@/lib/errors";
import { type StraddlingReports, findStraddlingReports, resolveMarketWithChainlink } from "@/lib/resolve";
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
  const { clearMarketErrors } = useToasts();
  const anyBusy = busy || sandboxBusy;
  const marketAddr = market.address.toBase58();
  const prevMarketRef = useRef<{ address: string; status: MarketView["status"] } | null>(null);

  useEffect(() => {
    const prev = prevMarketRef.current;
    if (prev && prev.address === marketAddr && prev.status !== market.status) {
      clearMarketErrors?.(marketAddr);
    }
    prevMarketRef.current = { address: marketAddr, status: market.status };
  }, [clearMarketErrors, market.status, marketAddr]);
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
  const canClaimVoid = isMarketVoided(market) && claimableOf(market, position) > 0n;
  const showSnapshot = phase.inSnapshotWindow && !isSandbox;
  const showResolve = market.status === "open" && phase.expired;
  const isCreator = Boolean(realPublicKey && realPublicKey.equals(market.creator));
  const showBurn = phase.canBurn && isCreator;

  return (
    <div className="stack-4">
      {canMerge || canClaimWinner || canClaimVoid ? (
        <div id="settle-claim" className="scroll-mt-20">
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
                      run(
                        t("tx.cashOut"),
                        () => ixMergeToken(program, market, realPublicKey, mergeable),
                        { marketAddress: marketAddr, action: "merge" }
                      )
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
                    return runSandbox(t("tx.collectWinnings"), build, {
                      marketAddress: marketAddr,
                      action: "redeem",
                    });
                  }
                  return run(t("tx.collectWinnings"), build, {
                    marketAddress: marketAddr,
                    action: "redeem",
                  });
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
        </div>
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
              <ResolveButton market={market} disabled={phase.afterWindow} />
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
                  run(
                    t("tx.cancelMarket"),
                    () => ixVoidMarket(program, market, realPublicKey),
                    { marketAddress: marketAddr, action: "void" }
                  )
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
              run(
                t("tx.burnAccount"),
                () => ixBurnAccount(program, market, realPublicKey),
                { marketAddress: marketAddr, action: "burn" }
              )
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
          run(
            t("tx.takeSnapshot"),
            () => ixTakeSnapshot(program, market, publicKey, new PublicKey(preset.feed)),
            { marketAddress: market.address.toBase58(), action: "snapshot" }
          )
        }
      >
        <StableText k="settle.snapshotSubmit" align="center" />
      </Button>
    </Card>
  );
}

function ResolveButton({ market, disabled }: { market: MarketView; disabled: boolean }) {
  const program = useProgram();
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { effectivePublicKey, isSandbox, locked } = useGuestSession();
  const { busy: sandboxBusy, runSandbox } = useSandboxTx();
  const { push } = useToasts();
  const { bump } = useRefresh();
  const { settings } = useSettings();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<{ key: string; reports: StraddlingReports } | null>(null);
  const { endTs, ocr2State, pdas: { snapshot } } = market;
  const key = [connection.rpcEndpoint, market.address, endTs, ocr2State, snapshot].join("/");
  const reports = ready?.key === key ? ready.reports : null;

  useEffect(() => {
    if (disabled || reports) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delayMs = 4000;
    async function check() {
      try {
        const snap = await fetchMarketSnapshot(connection, snapshot);
        if (!active) return;
        const pair = await findStraddlingReports(connection, ocr2State, endTs, snap);
        if (active) setReady({ key, reports: pair });
      } catch {
        if (active) {
          const wait = delayMs;
          delayMs = Math.min(15_000, delayMs * 2);
          timer = setTimeout(() => void check(), wait);
        }
      }
    }
    void check();
    return () => { active = false; clearTimeout(timer); };
  }, [connection, disabled, endTs, key, ocr2State, reports, snapshot]);

  const onClick = async () => {
    if (!program || !reports || disabled) return;
    const label = t("tx.submitResolve");
    const toastMeta = { marketAddress: market.address.toBase58(), action: "resolve" };
    if (isSandbox && effectivePublicKey) {
      await runSandbox(
        label,
        () =>
          ixResolveMarket(program, market, effectivePublicKey, {
            rawPre: reports.pre.raw,
            rawPost: reports.post.raw,
            hasSnapshot: reports.hasSnapshot,
          }),
        { submissionErrorsOnly: true, ...toastMeta }
      );
      return;
    }
    if (!wallet) return;
    setBusy(true);
    try {
      const sig = await resolveMarketWithChainlink(connection, wallet, program, market, reports);
      const link = sig ? explorerTx(sig, settings.cluster) : null;
      push("ok", label, link ? t("tx.view") : t("tx.confirmed"), link ?? undefined, toastMeta);
      bump();
    } catch (err) {
      const rejected = isSubmissionRejection(err);
      push(
        rejected ? "err" : "info",
        rejected ? t("tx.failed", { label }) : label,
        parseTxError(err),
        undefined,
        toastMeta
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-1">
      <Button
        type="button"
        tone={isSandbox ? "secondary" : "primary"}
        busy={busy || sandboxBusy}
        disabled={busy || sandboxBusy || disabled || !reports || !program ||
          (isSandbox ? locked || !effectivePublicKey : !wallet)}
        onClick={() => void onClick()}
      >
        <StableText k={isSandbox ? "settle.sandboxManualResolve" : "settle.submitResolve"} align="center" />
      </Button>
      {!reports && !disabled && (
        <p role="status" className="text-xs text-zinc-400"><StableText k="settle.reportPending" /></p>
      )}
    </div>
  );
}

function VoidClaim({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { effectivePublicKey, isSandbox, locked } = useGuestSession();
  const { busy, run } = useTx();
  const { busy: sandboxBusy, runSandbox } = useSandboxTx();
  const anyBusy = busy || sandboxBusy;
  const t = useT();
  const evenAmount = (nextSide: Side) => {
    const sideMax = nextSide === "yes" ? position.yes : position.no;
    const even = sideMax - (sideMax % 2n);
    return toUi(even, market.decimals, 6);
  };
  const [side, setSide] = useState<Side>(position.yes >= position.no ? "yes" : "no");
  const max = side === "yes" ? position.yes : position.no;
  const [amount, setAmount] = useState(() => evenAmount(side));
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
        onChange={(nextSide) => {
          if (nextSide === side) return;
          setSide(nextSide);
          setAmount(evenAmount(nextSide));
        }}
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
          const toastMeta = { marketAddress: market.address.toBase58(), action: "redeemVoid" };
          if (isSandbox) {
            return runSandbox(t("tx.collectRefund"), build, toastMeta);
          }
          return run(t("tx.collectRefund"), build, toastMeta);
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
