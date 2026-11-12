"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMarkets } from "@/hooks/use-markets";
import { useProgram } from "@/hooks/use-program";
import { fetchPosition, type MarketView, type UserPosition } from "@/lib/markets";
import { fetchRedemptions } from "@/lib/history";
import { localizeError } from "@/lib/errors";
import { explorerTx, formatUnix, toUi } from "@/lib/format";
import { kindLabel, marketKind, money, questionTitle, timeCopy } from "@/lib/display";
import { useRefresh, useSettings } from "@/components/providers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Reveal, StateBlock, WalletButton } from "@/components/ui";
import { useNow } from "@/hooks/use-now";
import { MeSkeleton } from "@/components/skeletons";
import { useT } from "@/i18n/provider";

type Row = { market: MarketView; position: UserPosition };

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="w-24 shrink-0">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className={"num mt-0.5 text-[15px] " + (accent ? "num-accent" : "")}>{value}</div>
    </div>
  );
}

export default function MePage() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const program = useProgram();
  const { markets, loading, error, reload } = useMarkets();
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
      <StateBlock
        kind="wallet"
        title={t("state.connectWallet")}
        body={t("me.connect")}
        action={<WalletButton />}
      />
    );
  }
  if (error) {
    return (
      <StateBlock
        kind="error"
        title={t("markets.loadError", { error: localizeError(error) })}
        action={
          <Button type="button" tone="secondary" onClick={() => void reload()}>
            {t("common.tryAgain")}
          </Button>
        }
      />
    );
  }
  if ((loading || busy) && !rows.length) {
    return <MeSkeleton />;
  }

  return (
    <div className="stack-6 fade-in">
      <h1 className="page-title">{t("me.title")}</h1>

      <Reveal><section className="stack-3">
        <h2 className="section-title">{t("me.positions")}</h2>
        {rows.length ? (
          <>
            <div className="surface flex flex-wrap gap-x-12 gap-y-4 p-6">
              <Stat label={t("me.sumMarkets")} value={String(rows.length)} />
              <Stat label={t("me.sumYes")} value={rows.reduce((a, r) => a + Number(toUi(r.position.yes, r.market.decimals, 2)), 0).toFixed(2)} />
              <Stat label={t("me.sumNo")} value={rows.reduce((a, r) => a + Number(toUi(r.position.no, r.market.decimals, 2)), 0).toFixed(2)} />
              <Stat label={t("me.sumPending")} value={rows.reduce((a, r) => a + Number(toUi(r.position.pendingYes + r.position.pendingNo, r.market.decimals, 4)), 0).toFixed(4)} accent />
            </div>
            <div className="stack-3">
              {rows.map(({ market, position }) => (
                <Link key={market.address.toBase58()} href={"/markets/" + market.address.toBase58()} className="surface flex flex-wrap items-center gap-x-10 gap-y-3 p-4">
                  <div className="min-w-[13rem] flex-1">
                    <div className="truncate text-sm font-medium text-white">{questionTitle(market)}</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {kindLabel(marketKind(market, now), market)} · {timeCopy(market, now)}
                    </div>
                  </div>
                  <Stat label={t("me.yes")} value={toUi(position.yes, market.decimals, 2)} />
                  <Stat label={t("me.no")} value={toUi(position.no, market.decimals, 2)} />
                  <Stat label={t("me.shares")} value={toUi(position.lpShares, market.decimals, 2)} />
                  <Stat label={t("me.lpPending")} value={toUi(position.pendingYes + position.pendingNo, market.decimals, 4)} accent />
                  {position.pendingYes > 0n ? <Stat label={t("lp.pendingYes")} value={toUi(position.pendingYes, market.decimals, 4)} accent /> : null}
                  {position.pendingNo > 0n ? <Stat label={t("lp.pendingNo")} value={toUi(position.pendingNo, market.decimals, 4)} accent /> : null}
                </Link>
              ))}
            </div>
          </>
        ) : (
          <StateBlock
            kind="empty"
            title={t("me.emptyPositions")}
              action={
                <Link href="/markets">
                  <Button type="button">{t("me.emptyCta")}</Button>
                </Link>
              }
            />
        )}
      </section></Reveal>

      <Reveal><section className="stack-3">
        <h2 className="section-title">{t("me.redemptions")}</h2>
        {redemptions.length ? (
          <div className="cards-2">
            {redemptions.map((row) => {
              const href = explorerTx(row.signature, settings.cluster);
              return (
                <div key={row.signature} className="surface p-4 stack-2">
                  <div className="text-sm text-zinc-200">{row.label}</div>
                  <div className="num text-right text-xs text-zinc-500">{row.when ? formatUnix(row.when) : "\u2014"}</div>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" className="link-accent text-xs">
                      {t("tx.view")}
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <StateBlock
            kind="empty"
            title={t("me.emptyRedeem")}
              action={
                <Link href="/markets">
                  <Button type="button">{t("me.emptyCta")}</Button>
                </Link>
              }
            />
        )}
      </section></Reveal>
    </div>
  );
}
