"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ExternalLink, Eye, EyeOff } from "lucide-react";
import { useFeeds } from "@/hooks/use-feeds";
import { useMarketPhaseTime, useWalletPositionsPage } from "@/hooks/use-markets";
import { useProgram } from "@/hooks/use-program";
import { useWalletBalance } from "@/hooks/use-wallet-balance";
import { maskAmount, useBalanceVisibility } from "@/hooks/use-balance-visibility";
import { subscribeAccountsWithFallback, type SyncMode } from "@/lib/account-sync";
import { isQuoteStale } from "@/lib/chainlink";
import { claimableOf, isVoidedStatus, pendingValueOf, type MarketView, type UserPosition } from "@/lib/markets";
import { fetchRedemptions } from "@/lib/history";
import { localizeError } from "@/lib/errors";
import { explorerAccount, explorerTx, formatFixed, formatUnix, shorten, toUi } from "@/lib/format";
import { kindLabel, marketKind, money, questionTitle, timeCopy } from "@/lib/display";
import { feedByState } from "@/lib/feeds";
import { parsePubkey } from "@/lib/program";
import { pmAmmAccrue } from "@/lib/quote";
import { ataOf } from "@/lib/tokens";
import { useSettings } from "@/components/providers";
import { useGuestSession, type SandboxBalance } from "@/components/guest-session";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, CopyText, DataFreshness, Reveal, StableText, StateBlock, WalletButton, onSpot, openFaucetMenu, openWalletModal } from "@/components/ui";
import { TickingCountdown } from "@/components/live";
import { MeSkeleton } from "@/components/skeletons";
import { useT } from "@/i18n/provider";
import { COLLATERAL_SYMBOL } from "@/lib/constants";

type Row = { market: MarketView; position: UserPosition };

const POS_GRID_CLS =
  "grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-[minmax(13rem,1.9fr)_minmax(6.5rem,0.9fr)_minmax(6.5rem,0.9fr)_minmax(7rem,0.95fr)_minmax(7.5rem,1fr)_minmax(8.5rem,1.2fr)_5rem] lg:items-center";

function formatPoolSharePct(lpShares: bigint, totalLpShares: bigint): string | null {
  if (lpShares <= 0n || totalLpShares <= 0n) return null;
  const pct = (Number(lpShares) / Number(totalLpShares)) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return null;
  if (pct < 0.01) return "<0.01%";
  return `${pct.toFixed(pct >= 10 ? 1 : 2)}%`;
}

function livePricesOf(market: MarketView, now: number): { yesPrice: number; noPrice: number } {
  const hasPmAmm = Boolean(market.lZero && market.lZero > 0n);
  const accrued =
    market.status === "open" && hasPmAmm
      ? pmAmmAccrue(market, now > 0 ? now : market.lastAccrualTs)
      : null;
  const yesPrice = accrued ? accrued.yesPrice : market.yesPrice;
  return { yesPrice, noPrice: 1 - yesPrice };
}

function rowEstimateUsdt(market: MarketView, position: UserPosition, now: number): number {
  if (market.status !== "open") return 0;
  const { yesPrice, noPrice } = livePricesOf(market, now);
  const scale = 10 ** market.decimals;
  const val = (Number(position.yes) / scale) * yesPrice + (Number(position.no) / scale) * noPrice;
  return Number.isFinite(val) ? val : 0;
}

function GuideStep({
  n,
  titleKey,
  bodyKey,
  children,
}: {
  n: number;
  titleKey: string;
  bodyKey: string;
  children?: ReactNode;
}) {
  return (
    <div onMouseMove={onSpot} className="surface flex h-full flex-col gap-3 p-5">
      <span className="num inline-flex h-7 w-7 items-center justify-center border border-[var(--line)] bg-[var(--seg-bg)] text-xs font-semibold text-white">
        0{n}
      </span>
      <div className="font-medium text-white">
        <StableText k={titleKey} block />
      </div>
      <p className="text-sm leading-relaxed text-zinc-400">
        <StableText k={bodyKey} block />
      </p>
      {children ? <div className="mt-auto pt-1">{children}</div> : null}
    </div>
  );
}

function HeaderCell({
  labelKey,
  value,
  accent,
  className,
}: {
  labelKey: string;
  value: string;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[11px] text-zinc-500">
        <StableText k={labelKey} />
      </div>
      <div className={"num mt-0.5 text-[15px] font-medium " + (accent ? "num-accent" : "text-white")}>
        {value}
      </div>
    </div>
  );
}

export default function MePage() {
  const {
    effectivePublicKey,
    isSandbox,
    hasSavedKey,
    storageAvailable,
    entering,
    locked,
    lastError,
    balanceStale,
    balanceUpdatedAt,
    enterSandbox,
  } = useGuestSession();
  const { connection } = useConnection();
  const program = useProgram();
  const { settings } = useSettings();
  const t = useT();
  const queryClient = useQueryClient();
  const walletBalance = useWalletBalance();
  const { hidden: hideBalances, toggle: toggleBalances } = useBalanceVisibility();
  const { quotes, ready: quotesReady } = useFeeds();
  const [guideOpen, setGuideOpen] = useState(true);
  const [syncMode, setSyncMode] = useState<SyncMode>("live");
  const programId = program?.programId.toBase58() ?? "";
  const wallet = effectivePublicKey?.toBase58() ?? "";

  const positionsQuery = useWalletPositionsPage({
    wallet,
    programId,
    pageSize: 30,
    enabled: Boolean(program && effectivePublicKey),
  });
  const rows: Row[] = positionsQuery.rows;
  const summary = positionsQuery.summary;
  const phaseMarkets = useMemo(() => rows.map((r) => r.market), [rows]);
  const now = useMarketPhaseTime(phaseMarkets);

  useEffect(() => {
    if (!isSandbox || !wallet || !rows.length) return;
    const match = rows.find((r) => r.market.collateralMint.toBase58() === settings.collateralMint.trim());
    if (!match) return;
    const balKey = ["sandbox-balance", connection.rpcEndpoint, settings.collateralMint, wallet];
    queryClient.setQueryData<SandboxBalance>(balKey, (prev) =>
      prev && prev.usdtAtoms !== match.position.collateral
        ? { ...prev, usdtAtoms: match.position.collateral }
        : prev
    );
  }, [connection.rpcEndpoint, isSandbox, queryClient, rows, settings.collateralMint, wallet]);

  const redemptionsQuery = useQuery({
    queryKey: ["redemptions", connection.rpcEndpoint, programId, wallet],
    queryFn: () => fetchRedemptions(connection, effectivePublicKey!, program!.programId),
    enabled: Boolean(program && effectivePublicKey),
  });

  const posRefetchRef = useRef(positionsQuery.reload);
  posRefetchRef.current = positionsQuery.reload;
  const redRefetchRef = useRef(redemptionsQuery.refetch);
  redRefetchRef.current = redemptionsQuery.refetch;
  const balRefetchRef = useRef(walletBalance.refetch);
  balRefetchRef.current = walletBalance.refetch;
  const hasProgram = Boolean(program);
  const collateralTp =
    rows.find((r) => r.market.collateralMint.toBase58() === settings.collateralMint.trim())?.market.tokenProgram ??
    TOKEN_PROGRAM_ID;
  const tpAddr = collateralTp.toBase58();

  useEffect(() => {
    if (!wallet || !hasProgram) {
      setSyncMode("live");
      return;
    }
    const ownerPk = new PublicKey(wallet);
    const mintPk = parsePubkey(settings.collateralMint);
    const accounts: PublicKey[] = [ownerPk];
    if (mintPk) {
      try {
        accounts.push(ataOf(mintPk, ownerPk, new PublicKey(tpAddr)));
      } catch {
        // jsdom Buffer polyfill can disrupt findProgramAddressSync in unit tests.
      }
    }
    return subscribeAccountsWithFallback({
      connection,
      accounts,
      onRefresh: async () => {
        await posRefetchRef.current(true);
        await redRefetchRef.current({ throwOnError: true });
        await balRefetchRef.current();
      },
      onModeChange: setSyncMode,
    });
  }, [connection, hasProgram, settings.collateralMint, tpAddr, wallet]);

  const redemptions = redemptionsQuery.data ?? [];
  const busy = (Boolean(effectivePublicKey) && positionsQuery.loading) || redemptionsQuery.isPending;

  const openPositionEstUsdt = useMemo(
    () => rows.reduce((acc, { market, position }) => acc + rowEstimateUsdt(market, position, now), 0),
    [rows, now]
  );

  const totalLpUi = useMemo(
    () => rows.reduce((acc, { market, position }) => acc + Number(toUi(position.lpShares, market.decimals, 2)), 0),
    [rows]
  );

  if (!effectivePublicKey) {
    return (
      <div className="stack-6 fade-in">
        <h1 className="page-title">
          <StableText k="me.title" />
        </h1>
        <StateBlock
          kind="wallet"
          title={<StableText k="state.connectWallet" />}
          body={<StableText k="me.connect" block />}
          action={
            <div className="stack-2 w-full">
              <div className="cluster-2 justify-center">
                <WalletButton />
                <Button
                  type="button"
                  tone="secondary"
                  busy={entering}
                  disabled={locked}
                  onClick={() => void enterSandbox()}
                >
                  <StableText k={hasSavedKey ? "sandbox.resumeAction" : "sandbox.enterAction"} align="center" />
                </Button>
              </div>
              {lastError ? (
                <p
                  role="alert"
                  className="mx-auto max-w-md border border-[var(--no)]/45 bg-[var(--no-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--no)]"
                >
                  {lastError}
                </p>
              ) : null}
            </div>
          }
        />
        <Reveal>
          <section className="stack-3">
            <button
              type="button"
              onClick={() => setGuideOpen((v) => !v)}
              aria-expanded={guideOpen}
              className="section-title flex items-center gap-2 text-left transition-colors hover:text-white"
            >
              <StableText k="help.quickTitle" />
              <span className={`text-xs transition-transform ${guideOpen ? "rotate-180" : ""}`}>▾</span>
            </button>
            {guideOpen ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <GuideStep n={1} titleKey="help.q1Title" bodyKey="help.q1" />
                <GuideStep n={2} titleKey="help.q2Title" bodyKey="help.q2">
                  <button
                    type="button"
                    onClick={() => openFaucetMenu()}
                    className="link-accent text-left text-sm"
                  >
                    <StableText k="me.claimOnHelp" />
                  </button>
                </GuideStep>
                <GuideStep n={3} titleKey="help.q3Title" bodyKey="help.q3">
                  <Link href="/markets" className="link-accent text-sm">
                    <StableText k="me.emptyCta" />
                  </Link>
                </GuideStep>
              </div>
            ) : null}
          </section>
        </Reveal>
      </div>
    );
  }
  if (positionsQuery.error && !rows.length) {
    return (
      <StateBlock
        kind="error"
        title={t("markets.loadError", { error: localizeError(positionsQuery.error) })}
        action={
          <Button type="button" tone="secondary" onClick={() => void positionsQuery.reload(true)}>
            <StableText k="common.tryAgain" align="center" />
          </Button>
        }
      />
    );
  }
  if (busy && !rows.length) {
    return <MeSkeleton />;
  }

  const claimCount = summary.claimCount;
  const claimTotal = summary.claimTotal;
  const lpUnclaimed = summary.lpUnclaimed;
  const explorerAccountHref = explorerAccount(wallet, settings.cluster);

  const availableUsdt = walletBalance.data
    ? Number(walletBalance.data.usdtAtoms) / 10 ** walletBalance.data.usdtDecimals
    : null;
  const totalUsdt =
    availableUsdt != null ? availableUsdt + claimTotal + summary.sumPending + openPositionEstUsdt : null;
  const nowMs = Date.now();

  return (
    <div className="stack-6 fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="page-title">
          <StableText k="me.title" />
        </h1>
        <DataFreshness
          updatedAt={
            Math.max(
              positionsQuery.updatedAt ?? 0,
              walletBalance.updatedAt ?? 0,
              isSandbox ? balanceUpdatedAt ?? 0 : 0
            ) || null
          }
          refreshing={positionsQuery.refreshing || walletBalance.refreshing}
          staleError={Boolean(
            positionsQuery.isStaleError ||
              (positionsQuery.error && rows.length > 0) ||
              syncMode === "stale" ||
              walletBalance.stale ||
              (isSandbox && balanceStale)
          )}
          onRefresh={() => {
            void positionsQuery.reload(true);
            void redemptionsQuery.refetch();
            void walletBalance.refetch();
          }}
        />
      </div>

      {isSandbox ? (
        <div
          onMouseMove={onSpot}
          className="surface flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium text-white">
              <StableText k="sandbox.title" />
            </span>
            <CopyText value={wallet} label={shorten(wallet, 6, 6)} />
            {explorerAccountHref ? (
              <a
                href={explorerAccountHref}
                target="_blank"
                rel="noreferrer"
                className="link-accent inline-flex items-center gap-1"
              >
                <span>Solana Explorer</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
            <span className="text-zinc-400">
              <StableText k={storageAvailable ? "sandbox.meBarNote" : "sandbox.memoryOnlyNote"} />
            </span>
          </div>
          <Button
            type="button"
            tone="secondary"
            className="h-7 px-2.5 text-xs"
            disabled={locked}
            onClick={() => openWalletModal()}
          >
            <StableText k="sandbox.connectReal" align="center" />
          </Button>
        </div>
      ) : null}

      <section
        data-testid="me-account-overview"
        onMouseMove={onSpot}
        className="surface stack-4 p-5"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">
            <StableText k="me.overviewTitle" />
          </h2>
          <button
            type="button"
            onClick={toggleBalances}
            aria-label={t(hideBalances ? "common.showBalances" : "common.hideBalances")}
            className="inline-flex items-center gap-1.5 border border-[var(--hair)] px-2.5 py-1 text-[11px] text-zinc-400 transition-colors hover:border-[var(--line)] hover:text-white"
          >
            {hideBalances ? (
              <EyeOff className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Eye className="h-3.5 w-3.5" aria-hidden />
            )}
            <StableText k={hideBalances ? "common.showBalances" : "common.hideBalances"} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <div>
            <div className="text-[11px] text-zinc-500">
              <StableText k={isSandbox ? "me.acctTestBalance" : "me.acctAvailable"} />
            </div>
            <div
              key={availableUsdt != null ? maskAmount(availableUsdt.toFixed(2), hideBalances) : "na"}
              className="pop-num num mt-0.5 text-[15px] font-medium text-white"
            >
              {availableUsdt != null ? maskAmount(availableUsdt.toFixed(2), hideBalances) : "—"}
            </div>
          </div>

          <div>
            <div className="text-[11px] text-zinc-500">
              <StableText k="me.acctRedeemable" />
            </div>
            <div className={"num mt-0.5 text-[15px] font-medium " + (claimTotal > 0 ? "num-accent" : "text-white")}>
              {maskAmount(claimTotal.toFixed(2), hideBalances)}
            </div>
          </div>

          <div>
            <div className="text-[11px] text-zinc-500">
              <StableText k="me.acctMakerPending" />
            </div>
            <div
              className={
                "num mt-0.5 text-[15px] font-medium " + (summary.sumPending > 0 ? "num-accent" : "text-white")
              }
            >
              {maskAmount(summary.sumPending.toFixed(4), hideBalances)}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <StableText k="me.acctPositionEst" />
              <span className="border border-[var(--hair)] bg-[var(--seg-bg)] px-1 py-0 text-[10px] text-zinc-400">
                <StableText k="me.acctEstTag" />
              </span>
            </div>
            <div className="num mt-0.5 text-[15px] font-medium text-white">
              {hideBalances
                ? maskAmount("", true)
                : openPositionEstUsdt > 0
                  ? `~${openPositionEstUsdt.toFixed(2)}`
                  : "0.00"}
            </div>
          </div>

          <div>
            <div className="text-[11px] text-zinc-500">
              <StableText k="me.acctTotal" />
            </div>
            <div className="num mt-0.5 text-[15px] font-semibold text-white">
              {totalUsdt != null
                ? hideBalances
                  ? maskAmount("", true)
                  : openPositionEstUsdt > 0
                    ? `~${totalUsdt.toFixed(2)}`
                    : totalUsdt.toFixed(2)
                : "—"}
            </div>
          </div>
        </div>

        {!isSandbox ? (
          <div
            data-testid="me-overview-sol-row"
            className="flex items-center justify-between border-t border-[var(--hair)] pt-3 text-xs"
          >
            <span className="text-zinc-500">
              <StableText k="me.acctSol" />
            </span>
            <span
              key={
                walletBalance.data
                  ? maskAmount((walletBalance.data.solLamports / 1e9).toFixed(4), hideBalances, "SOL")
                  : "sol-na"
              }
              className="pop-num num font-medium text-zinc-200"
            >
              {walletBalance.data
                ? maskAmount((walletBalance.data.solLamports / 1e9).toFixed(4), hideBalances, "SOL")
                : "—"}
            </span>
          </div>
        ) : null}
      </section>

      <Reveal>
        <section className="stack-3">
          <h2 className="section-title">
            <StableText k="me.positions" />
          </h2>
          {rows.length ? (
            <>
              {claimCount > 0 || lpUnclaimed ? (
                <div onMouseMove={onSpot} className="surface stack-2 p-4">
                  {claimCount > 0 ? (
                    <p className="void-text text-sm leading-6">
                      <StableText
                        k={claimCount === 1 ? "me.unclaimedBannerOne" : "me.unclaimedBanner"}
                        vars={{ count: claimCount, amount: `${claimTotal.toFixed(2)} ${COLLATERAL_SYMBOL}` }}
                        block
                      />
                    </p>
                  ) : null}
                  {lpUnclaimed ? (
                    <p className="void-text text-sm leading-6">
                      <StableText k="me.unclaimedLp" block />
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="surface overflow-hidden">
                <div
                  data-testid="me-positions-header"
                  className={`${POS_GRID_CLS} border-b border-[var(--line)] bg-[var(--seg-bg)] px-5 py-4`}
                >
                  <HeaderCell
                    labelKey="me.sumMarkets"
                    value={String(summary.totalMarkets)}
                    className="col-span-2 lg:col-span-1"
                  />
                  <HeaderCell labelKey="me.sumYes" value={summary.sumYes.toFixed(2)} />
                  <HeaderCell labelKey="me.sumNo" value={summary.sumNo.toFixed(2)} />
                  <HeaderCell labelKey="me.shares" value={totalLpUi.toFixed(2)} />
                  <HeaderCell
                    labelKey="me.sumMakerPending"
                    value={summary.sumPending.toFixed(4)}
                    accent={summary.sumPending > 0}
                  />
                  <HeaderCell
                    labelKey="me.sumRedeemable"
                    value={`${claimTotal.toFixed(2)} ${COLLATERAL_SYMBOL}`}
                    accent={claimTotal > 0}
                  />
                  <div className="hidden text-right text-[11px] text-zinc-500 lg:block">
                    <StableText k="common.action" align="end" />
                  </div>
                </div>

                <div className="divide-y divide-[var(--hair)]">
                  {rows.map(({ market, position }) => {
                    const kind = marketKind(market, now);
                    const claimable = claimableOf(market, position);
                    const isBackfilledVoid = isVoidedStatus(market.status) && market.finishTs <= 0;
                    const hasLp =
                      !isBackfilledVoid &&
                      (position.lpShares > 0n || position.pendingYes > 0n || position.pendingNo > 0n);
                    const isLegacyV1 = !(market.startTs && market.startTs > 0);
                    const action: {
                      key: "markets.open" | "markets.actionSettle" | "markets.actionVoid" | "me.actionClaim" | "markets.view";
                      cls: string;
                    } =
                      kind === "live"
                        ? { key: "markets.open", cls: "text-zinc-200" }
                        : !isLegacyV1 && kind === "awaiting"
                          ? { key: "markets.actionSettle", cls: "text-zinc-200" }
                          : !isLegacyV1 && kind === "voidable"
                            ? { key: "markets.actionVoid", cls: "void-text" }
                            : (kind === "resolved" || kind === "staleVoid" || kind === "windowVoid") &&
                                (claimable > 0n || hasLp)
                              ? { key: "me.actionClaim", cls: "text-white font-semibold" }
                              : { key: "markets.view", cls: "text-zinc-400" };
                    const claimAnchor =
                      action.key !== "me.actionClaim"
                        ? ""
                        : claimable > 0n
                          ? "#settle-claim"
                          : hasLp
                            ? "#lp-withdraw"
                            : "";
                    const rowHref = "/markets/" + market.address.toBase58() + claimAnchor;

                    const yesLost =
                      market.status === "resolved" && market.winner === "no" && position.yes > 0n;
                    const noLost =
                      market.status === "resolved" && market.winner === "yes" && position.no > 0n;
                    const lpPct = formatPoolSharePct(position.lpShares, market.totalLpShares);
                    const rowEst = rowEstimateUsdt(market, position, now);

                    const preset = feedByState(market.ocr2State);
                    const quote = preset ? quotes[preset.key] : undefined;
                    const quoteValid = Boolean(
                      market.status === "open" &&
                        quotesReady &&
                        quote?.available &&
                        quote?.price != null &&
                        !isQuoteStale(quote, nowMs)
                    );
                    const thresholdNum = Number(market.threshold) * 10 ** -market.priceDecimals;
                    const aheadSide: "YES" | "NO" | null =
                      quoteValid && Number.isFinite(thresholdNum) && thresholdNum > 0
                        ? (market.settleAbove
                            ? (quote!.price as number) >= thresholdNum
                            : (quote!.price as number) < thresholdNum)
                          ? "YES"
                          : "NO"
                        : null;

                    return (
                      <Link
                        key={market.address.toBase58()}
                        href={rowHref}
                        onMouseMove={onSpot}
                        className={`${POS_GRID_CLS} px-5 py-4 transition-colors hover:bg-white/[0.02]`}
                      >
                        <div className="col-span-2 min-w-0 lg:col-span-1">
                          <div className="truncate text-sm font-medium text-white">{questionTitle(market)}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                            <span>
                              {kindLabel(kind, market)} ·{" "}
                              {kind === "live" ? (
                                <TickingCountdown expiry={market.expiry} />
                              ) : (
                                timeCopy(market, now)
                              )}
                            </span>
                            {aheadSide ? (
                              <span
                                className={
                                  aheadSide === "YES"
                                    ? "font-medium text-[var(--yes)]"
                                    : "font-medium text-[var(--no)]"
                                }
                              >
                                · <StableText k="me.rowAhead" vars={{ side: aheadSide }} />
                              </span>
                            ) : null}
                          </div>
                        </div>

                        <div className="min-w-0">
                          <div className="text-[11px] text-zinc-500 lg:hidden">
                            <StableText k="me.yes" />
                          </div>
                          <div
                            className={`num text-[15px] font-medium ${
                              yesLost ? "text-zinc-500 line-through" : "text-white"
                            }`}
                          >
                            {formatFixed(position.yes, market.decimals, 2)}
                          </div>
                          {yesLost ? (
                            <div className="mt-0.5 text-[11px] text-zinc-500">
                              <StableText k="me.lostZero" />
                            </div>
                          ) : market.status === "open" && position.yes > 0n ? (
                            <div className="num mt-0.5 text-[11px] text-zinc-400">
                              <StableText
                                k="me.rowWinPayout"
                                vars={{ amount: money(position.yes, market.decimals) }}
                              />
                            </div>
                          ) : null}
                        </div>

                        <div className="min-w-0">
                          <div className="text-[11px] text-zinc-500 lg:hidden">
                            <StableText k="me.no" />
                          </div>
                          <div
                            className={`num text-[15px] font-medium ${
                              noLost ? "text-zinc-500 line-through" : "text-white"
                            }`}
                          >
                            {formatFixed(position.no, market.decimals, 2)}
                          </div>
                          {noLost ? (
                            <div className="mt-0.5 text-[11px] text-zinc-500">
                              <StableText k="me.lostZero" />
                            </div>
                          ) : market.status === "open" && position.no > 0n ? (
                            <div className="num mt-0.5 text-[11px] text-zinc-400">
                              <StableText
                                k="me.rowWinPayout"
                                vars={{ amount: money(position.no, market.decimals) }}
                              />
                            </div>
                          ) : null}
                        </div>

                        <div className="min-w-0">
                          <div className="text-[11px] text-zinc-500 lg:hidden">
                            <StableText k="me.shares" />
                          </div>
                          <div className="num text-[15px] font-medium text-white">
                            {formatFixed(position.lpShares, market.decimals, 2)}
                          </div>
                          {lpPct ? (
                            <div className="num mt-0.5 text-[11px] text-zinc-400">
                              <StableText k="me.rowPoolShare" vars={{ pct: lpPct }} />
                            </div>
                          ) : null}
                          {isSandbox ? (
                            <div className="mt-0.5 text-[11px] text-zinc-500">
                              <StableText k="me.lpRequiresReal" />
                            </div>
                          ) : null}
                        </div>

                        <div className="min-w-0">
                          <div className="text-[11px] text-zinc-500 lg:hidden">
                            <StableText k="me.lpPending" />
                          </div>
                          <div className="num num-accent text-[15px] font-medium">
                            {formatFixed(pendingValueOf(market, position), market.decimals, 4)}
                          </div>
                          {position.pendingYes > 0n || position.pendingNo > 0n ? (
                            <div className="mt-0.5 text-[11px] leading-4 text-zinc-500">
                              {position.pendingYes > 0n ? (
                                <div>
                                  {t("lp.pendingYes")} {formatFixed(position.pendingYes, market.decimals, 4)}
                                </div>
                              ) : null}
                              {position.pendingNo > 0n ? (
                                <div>
                                  {t("lp.pendingNo")} {formatFixed(position.pendingNo, market.decimals, 4)}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        <div className="min-w-0">
                          <div className="text-[11px] text-zinc-500 lg:hidden">
                            <StableText k="markets.colStatus" />
                          </div>
                          {market.status === "resolved" ? (
                            claimable > 0n ? (
                              <div className="num text-xs font-medium text-[var(--yes)]">
                                <StableText
                                  k="me.rowRedeemable"
                                  vars={{ amount: money(claimable, market.decimals) }}
                                />
                              </div>
                            ) : position.yes > 0n || position.no > 0n ? (
                              <div className="text-xs text-zinc-500">
                                <StableText k="me.lostZero" />
                              </div>
                            ) : (
                              <div className="num text-xs text-zinc-500">—</div>
                            )
                          ) : isVoidedStatus(market.status) ? (
                            claimable > 0n ? (
                              <div className="num text-xs font-medium text-zinc-200">
                                <StableText
                                  k="me.rowRedeemable"
                                  vars={{ amount: money(claimable, market.decimals) }}
                                />
                              </div>
                            ) : (
                              <div className="num text-xs text-zinc-500">—</div>
                            )
                          ) : position.yes > 0n || position.no > 0n ? (
                            <div className="num text-xs text-zinc-300">
                              <StableText
                                k="me.rowEstValue"
                                vars={{ amount: `~${rowEst.toFixed(2)} ${COLLATERAL_SYMBOL}` }}
                              />
                            </div>
                          ) : (
                            <div className="num text-xs text-zinc-500">—</div>
                          )}
                        </div>

                        <div className="col-span-2 flex justify-end lg:col-span-1">
                          <span className={`shrink-0 text-sm font-medium ${action.cls}`}>
                            <StableText k={action.key} align="end" /> →
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>

              {positionsQuery.hasMore ? (
                <Button
                  type="button"
                  tone="secondary"
                  busy={positionsQuery.loadingMore}
                  onClick={() => void positionsQuery.loadMore()}
                >
                  <StableText k="markets.loadMore" />
                </Button>
              ) : null}
            </>
          ) : (
            <StateBlock
              kind="empty"
              title={<StableText k="me.emptyPositions" />}
              action={
                <Link href="/markets">
                  <Button type="button">
                    <StableText k="me.emptyCta" align="center" />
                  </Button>
                </Link>
              }
            />
          )}
        </section>
      </Reveal>

      <Reveal>
        <section className="stack-3">
          <h2 className="section-title">
            <StableText k="me.redemptions" />
          </h2>
          {redemptionsQuery.isError ? (
            <StateBlock
              kind="error"
              title={<StableText k="me.redeemError" />}
              body={<StableText k="me.redeemErrorHint" block />}
              action={
                <Button type="button" tone="secondary" onClick={() => void redemptionsQuery.refetch()}>
                  <StableText k="common.retry" align="center" />
                </Button>
              }
            />
          ) : redemptions.length ? (
            <div className="cards-2">
              {redemptions.map((row) => {
                const href = explorerTx(row.signature, settings.cluster);
                const address = row.market.toBase58();
                const market = rows.find((r) => r.market.address.equals(row.market))?.market;
                const symbol = row.mint.toBase58() === settings.collateralMint ? COLLATERAL_SYMBOL : shorten(row.mint.toBase58());
                return (
                  <div key={row.id} onMouseMove={onSpot} className="surface p-4 stack-2">
                    <div className="text-xs text-zinc-400"><StableText k="me.redeemTx" /></div>
                    <Link className="link-accent" href={`/markets/${address}`}>
                      {market?.title ? questionTitle(market) : row.title || shorten(address)}
                    </Link>
                    <div className="num flex gap-2 text-sm text-zinc-200">
                      {row.side && <strong>{row.side}</strong>}
                      {row.payout && (
                        <span title={`${toUi(row.payout.atoms, row.payout.decimals, row.payout.decimals)} ${symbol}`}>
                          {formatFixed(row.payout.atoms, row.payout.decimals, 2)} {symbol}
                        </span>
                      )}
                    </div>
                    <div className="num text-right text-xs text-zinc-500">
                      {row.when ? formatUnix(row.when) : "\u2014"}
                    </div>
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer" className="link-accent text-xs">
                        <StableText k="tx.view" />
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              <StableText k="me.emptyRedeem" block />
            </p>
          )}
        </section>
      </Reveal>
    </div>
  );
}
