"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMarkets } from "@/hooks/use-markets";
import { useProgram } from "@/hooks/use-program";
import { fetchPosition, type MarketView, type UserPosition } from "@/lib/markets";
import { fetchRedemptions, type RedemptionRow } from "@/lib/history";
import { localizeError } from "@/lib/errors";
import { explorerTx, formatUnix, toUi } from "@/lib/format";
import { money } from "@/lib/display";
import { useSettings } from "@/components/providers";
import { Button, StateBlock, WalletButton } from "@/components/ui";
import { MeSkeleton } from "@/components/skeletons";
import { useT } from "@/i18n/provider";

type Row = { market: MarketView; position: UserPosition };

export default function MePage() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const program = useProgram();
  const { markets, loading, error, reload } = useMarkets();
  const { settings } = useSettings();
  const t = useT();
  const [rows, setRows] = useState<Row[]>([]);
  const [redemptions, setRedemptions] = useState<RedemptionRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!publicKey || !program) {
      setRows([]);
      setRedemptions([]);
      return;
    }
    let alive = true;
    setBusy(true);
    void (async () => {
      try {
        const next: Row[] = [];
        for (const market of markets) {
          const position = await fetchPosition(connection, program.programId, market, publicKey);
          if (position.yes > 0n || position.no > 0n || position.lpShares > 0n || position.pendingYes > 0n || position.pendingNo > 0n) {
            next.push({ market, position });
          }
        }
        if (alive) setRows(next);
        const hist = await fetchRedemptions(connection, publicKey, program.programId);
        if (alive) setRedemptions(hist);
      } catch {
        if (alive) setRows([]);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [publicKey, program, markets, connection]);

  const pending = useMemo(
    () => rows.filter((r) => r.position.pendingYes > 0n || r.position.pendingNo > 0n || (r.market.status !== "open" && (r.position.yes > 0n || r.position.no > 0n))),
    [rows]
  );

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

      <section className="stack-3">
        <h2 className="section-title">{t("me.positions")}</h2>
        {rows.length ? (
          <div className="cards-2">
            {rows.map(({ market, position }) => (
              <Link key={market.address.toBase58()} href={"/markets/" + market.address.toBase58()} className="surface p-4 stack-3">
                <div className="truncate text-sm font-medium text-white">{market.title}</div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-zinc-500">{t("me.yes")}</span>
                  <span className="num text-right text-sm">{toUi(position.yes, market.decimals, 2)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-zinc-500">{t("me.no")}</span>
                  <span className="num text-right text-sm">{toUi(position.no, market.decimals, 2)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-zinc-500">{t("me.shares")}</span>
                  <span className="num text-right text-sm">{toUi(position.lpShares, market.decimals, 2)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-zinc-500">{t("me.lpPending")}</span>
                  <span className="num num-accent text-right text-sm">{money(position.pendingYes + position.pendingNo, market.decimals, 4)}</span>
                </div>
              </Link>
            ))}
          </div>
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
      </section>

      <section className="stack-3">
        <h2 className="section-title">{t("me.pending")}</h2>
        {pending.length ? (
          <div className="cards-2">
            {pending.map(({ market, position }) => (
              <Link key={market.address.toBase58() + "-p"} href={"/markets/" + market.address.toBase58()} className="surface p-4 stack-3">
                <div className="truncate text-sm font-medium text-white">{market.title}</div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-zinc-500">{t("lp.pendingYes")}</span>
                  <span className="num num-accent text-right text-sm">{toUi(position.pendingYes, market.decimals, 4)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-zinc-500">{t("lp.pendingNo")}</span>
                  <span className="num num-accent text-right text-sm">{toUi(position.pendingNo, market.decimals, 4)}</span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <StateBlock
            kind="empty"
            title={t("me.emptyPending")}
            action={
              <Link href="/markets">
                <Button type="button">{t("me.emptyCta")}</Button>
              </Link>
            }
          />
        )}
      </section>

      <section className="stack-3">
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
      </section>
    </div>
  );
}
