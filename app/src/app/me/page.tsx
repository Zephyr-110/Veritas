"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMarkets } from "@/hooks/use-markets";
import { useProgram } from "@/hooks/use-program";
import { fetchPosition, isFinalizedStatus, isVoidedStatus, type MarketView, type UserPosition } from "@/lib/markets";
import { fetchRedemptions } from "@/lib/history";
import { localizeError } from "@/lib/errors";
import { explorerTx, formatUnix, toUi } from "@/lib/format";
import { kindLabel, marketKind, questionTitle, timeCopy } from "@/lib/display";
import { useRefresh, useSettings } from "@/components/providers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, DataFreshness, Reveal, StableText, StateBlock, WalletButton, onSpot, openFaucetMenu } from "@/components/ui";
import { useNow } from "@/hooks/use-now";
import { MeSkeleton } from "@/components/skeletons";
import { useT } from "@/i18n/provider";
import { COLLATERAL_SYMBOL } from "@/lib/constants";

type Row = { market: MarketView; position: UserPosition };

function claimableOf(market: MarketView, position: UserPosition): bigint {
  if (market.status === "resolved") return market.winner === "yes" ? position.yes : position.no;
  if (isVoidedStatus(market.status)) {
    return position.yes > 1n || position.no > 1n ? (position.yes + position.no) / 2n : 0n;
  }
  return 0n;
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

function Stat({ labelKey, value, accent }: { labelKey: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-[6.5rem] shrink-0">
      <div className="text-[11px] text-zinc-500">
        <StableText k={labelKey} />
      </div>
      <div className={"num mt-0.5 text-[15px] font-medium " + (accent ? "num-accent" : "")}>{value}</div>
    </div>
  );
}

export default function MePage() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const program = useProgram();
  const { markets, loading, refreshing, updatedAt, isStaleError, error, reload } = useMarkets();
  const { settings } = useSettings();
  const { nonce } = useRefresh();
  const now = useNow(1000);
  const queryClient = useQueryClient();
  const t = useT();
  const programId = program?.programId.toBase58() ?? "";
  const wallet = publicKey?.toBase58() ?? "";
  const marketIds = markets.map((m) => m.address.toBase58()).join(",");

  const positionsQuery = useQuery({
    queryKey: ["positions", connection.rpcEndpoint, programId, wallet, marketIds],
    queryFn: async () => {
      const all = await Promise.all(
        markets.map(async (market) => ({
          market,
          position: await fetchPosition(connection, program!.programId, market, publicKey!),
        }))
      );
      return all.filter(
        (r) =>
          r.position.yes > 0n ||
          r.position.no > 0n ||
          r.position.lpShares > 0n ||
          r.position.pendingYes > 0n ||
          r.position.pendingNo > 0n
      );
    },
    enabled: Boolean(program && publicKey && markets.length),
  });
  const redemptionsQuery = useQuery({
    queryKey: ["redemptions", connection.rpcEndpoint, programId, wallet],
    queryFn: () => fetchRedemptions(connection, publicKey!, program!.programId),
    enabled: Boolean(program && publicKey),
  });

  useEffect(() => {
    if (nonce > 0) {
      void queryClient.invalidateQueries({ queryKey: ["positions"] });
      void queryClient.invalidateQueries({ queryKey: ["redemptions"] });
    }
  }, [nonce, queryClient]);

  const rows: Row[] = positionsQuery.data ?? [];
  const redemptions = redemptionsQuery.data ?? [];
  const busy = (Boolean(publicKey) && positionsQuery.isPending) || redemptionsQuery.isPending;

  if (!publicKey) {
    return (
      <div className="stack-6 fade-in">
        <h1 className="page-title">
          <StableText k="me.title" />
        </h1>
        <StateBlock
          kind="wallet"
          title={<StableText k="state.connectWallet" />}
          body={<StableText k="me.connect" block />}
          action={<WalletButton />}
        />
        <Reveal>
          <section className="stack-3">
            <h2 className="section-title">
              <StableText k="help.quickTitle" />
            </h2>
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
          </section>
        </Reveal>
      </div>
    );
  }
  if (error && !markets.length) {
    return (
      <StateBlock
        kind="error"
        title={t("markets.loadError", { error: localizeError(error) })}
        action={
          <Button type="button" tone="secondary" onClick={() => void reload()}>
            <StableText k="common.tryAgain" align="center" />
          </Button>
        }
      />
    );
  }
  if ((loading || busy) && !rows.length && markets.length > 0) {
    return <MeSkeleton />;
  }
  if (loading && !markets.length) {
    return <MeSkeleton />;
  }

  const finalizedRows = rows.filter(({ market }) => isFinalizedStatus(market.status));
  const claimCount = finalizedRows.filter(({ market, position }) => claimableOf(market, position) > 0n).length;
  const claimTotal = finalizedRows.reduce(
    (a, { market, position }) => a + Number(toUi(claimableOf(market, position), market.decimals, 2)),
    0
  );
  const lpUnclaimed = finalizedRows.some(
    ({ position }) => position.lpShares > 0n || position.pendingYes > 0n || position.pendingNo > 0n
  );

  return (
    <div className="stack-6 fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="page-title">
          <StableText k="me.title" />
        </h1>
        <DataFreshness
          updatedAt={updatedAt}
          refreshing={refreshing || positionsQuery.isFetching}
          staleError={isStaleError}
          onRefresh={() => {
            void reload();
            void positionsQuery.refetch();
            void redemptionsQuery.refetch();
          }}
        />
      </div>

      <Reveal>
        <section className="stack-3">
          <h2 className="section-title">
            <StableText k="me.positions" />
          </h2>
          {rows.length ? (
            <>
              <div onMouseMove={onSpot} className="surface flex flex-wrap gap-x-10 gap-y-4 p-6">
                <Stat labelKey="me.sumMarkets" value={String(rows.length)} />
                <Stat
                  labelKey="me.sumYes"
                  value={rows.reduce((a, r) => a + Number(toUi(r.position.yes, r.market.decimals, 2)), 0).toFixed(2)}
                />
                <Stat
                  labelKey="me.sumNo"
                  value={rows.reduce((a, r) => a + Number(toUi(r.position.no, r.market.decimals, 2)), 0).toFixed(2)}
                />
                <Stat
                  labelKey="me.sumPending"
                  value={rows
                    .reduce((a, r) => a + Number(toUi(r.position.pendingYes + r.position.pendingNo, r.market.decimals, 4)), 0)
                    .toFixed(4)}
                  accent
                />
              </div>
              {claimCount > 0 || lpUnclaimed ? (
                <div onMouseMove={onSpot} className="surface stack-2 p-4">
                  {claimCount > 0 ? (
                    <p className="void-text text-sm leading-6">
                      <StableText
                        k="me.unclaimedBanner"
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
              <div className="stack-3">
                {rows.map(({ market, position }) => {
                  const kind = marketKind(market, now);
                  const claimable = claimableOf(market, position);
                  const hasLp = position.lpShares > 0n || position.pendingYes > 0n || position.pendingNo > 0n;
                  const action: {
                    key: "markets.open" | "markets.actionSettle" | "markets.actionVoid" | "me.actionClaim" | "markets.view";
                    cls: string;
                  } =
                    kind === "live"
                      ? { key: "markets.open", cls: "text-zinc-200" }
                      : kind === "awaiting"
                        ? { key: "markets.actionSettle", cls: "text-zinc-200" }
                        : kind === "voidable"
                          ? { key: "markets.actionVoid", cls: "void-text" }
                          : (kind === "resolved" || kind === "staleVoid" || kind === "windowVoid") &&
                              (claimable > 0n || hasLp)
                            ? { key: "me.actionClaim", cls: "text-white font-semibold" }
                            : { key: "markets.view", cls: "text-zinc-400" };
                  return (
                    <Link
                      key={market.address.toBase58()}
                      href={"/markets/" + market.address.toBase58()}
                      onMouseMove={onSpot}
                      className="surface flex flex-wrap items-center gap-x-8 gap-y-3 p-5"
                    >
                      <div className="min-w-[13rem] flex-1">
                        <div className="truncate text-sm font-medium text-white">{questionTitle(market)}</div>
                        <div className="mt-1 text-xs text-zinc-500">
                          {kindLabel(kind, market)} · {timeCopy(market, now)}
                        </div>
                      </div>
                      <Stat labelKey="me.yes" value={toUi(position.yes, market.decimals, 2)} />
                      <Stat labelKey="me.no" value={toUi(position.no, market.decimals, 2)} />
                      <Stat labelKey="me.shares" value={toUi(position.lpShares, market.decimals, 2)} />
                      <div className="shrink-0">
                        <Stat
                          labelKey="me.lpPending"
                          value={toUi(position.pendingYes + position.pendingNo, market.decimals, 4)}
                          accent
                        />
                        {position.pendingYes > 0n || position.pendingNo > 0n ? (
                          <div className="mt-1 w-28 text-[11px] leading-4 text-zinc-500">
                            {position.pendingYes > 0n ? (
                              <div>
                                {t("lp.pendingYes")} {toUi(position.pendingYes, market.decimals, 4)}
                              </div>
                            ) : null}
                            {position.pendingNo > 0n ? (
                              <div>
                                {t("lp.pendingNo")} {toUi(position.pendingNo, market.decimals, 4)}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <span className={`shrink-0 text-sm font-medium ${action.cls}`}>
                        <StableText k={action.key} align="end" /> →
                      </span>
                    </Link>
                  );
                })}
              </div>
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
          {redemptions.length ? (
            <div className="cards-2">
              {redemptions.map((row) => {
                const href = explorerTx(row.signature, settings.cluster);
                return (
                  <div key={row.signature} onMouseMove={onSpot} className="surface p-4 stack-2">
                    <div className="text-sm text-zinc-200">{row.label}</div>
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
