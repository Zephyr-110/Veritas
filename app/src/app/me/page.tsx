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
import { Button, Card, StateBlock } from "@/components/ui";
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
    return <StateBlock kind="wallet" title={t("state.connectWallet")} body={t("me.connect")} />;
  }
  if (error) {
    return (
      <StateBlock
        kind="error"
        title={t("markets.loadError", { error: localizeError(error) })}
        action={<Button type="button" tone="secondary" onClick={() => void reload()}>{t("common.tryAgain")}</Button>}
      />
    );
  }
  if ((loading || busy) && !rows.length) {
    return <StateBlock kind="loading" title={t("me.loading")} />;
  }

  return (
    <div className="stack-6">
      <h1 className="text-xl font-medium text-white">{t("me.title")}</h1>

      <section className="stack-3">
        <h2 className="text-sm font-medium text-zinc-300">{t("me.positions")}</h2>
        {rows.length ? (
          <Card className="stack-3">
            {rows.map(({ market, position }) => (
              <Link key={market.address.toBase58()} href={"/markets/" + market.address.toBase58()} className="grid grid-cols-2 gap-2 border-b border-zinc-800/80 py-3 last:border-0 md:grid-cols-5">
                <div className="col-span-2 truncate text-sm text-white md:col-span-1">{market.title}</div>
                <div className="num text-right text-sm">{t("me.yes")} {toUi(position.yes, market.decimals, 2)}</div>
                <div className="num text-right text-sm">{t("me.no")} {toUi(position.no, market.decimals, 2)}</div>
                <div className="num text-right text-sm">{t("me.shares")} {toUi(position.lpShares, market.decimals, 2)}</div>
                <div className="num text-right text-sm text-cyan-200">{t("me.lpPending")} {money(position.pendingYes + position.pendingNo, market.decimals, 4)}</div>
              </Link>
            ))}
          </Card>
        ) : (
          <StateBlock kind="empty" title={t("me.emptyPositions")} />
        )}
      </section>

      <section className="stack-3">
        <h2 className="text-sm font-medium text-zinc-300">{t("me.pending")}</h2>
        {pending.length ? (
          <Card className="stack-3">
            {pending.map(({ market, position }) => (
              <Link key={market.address.toBase58() + "-p"} href={"/markets/" + market.address.toBase58()} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate text-sm text-white">{market.title}</span>
                <span className="num text-sm text-cyan-200">
                  {t("lp.pendingYes")} {toUi(position.pendingYes, market.decimals, 4)} · {t("lp.pendingNo")} {toUi(position.pendingNo, market.decimals, 4)}
                </span>
              </Link>
            ))}
          </Card>
        ) : (
          <StateBlock kind="empty" title={t("me.emptyPending")} />
        )}
      </section>

      <section className="stack-3">
        <h2 className="text-sm font-medium text-zinc-300">{t("me.redemptions")}</h2>
        {redemptions.length ? (
          <Card className="stack-2">
            {redemptions.map((row) => {
              const href = explorerTx(row.signature, settings.cluster);
              return (
                <div key={row.signature} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-zinc-300">{row.label}</span>
                  <span className="num text-zinc-500">{row.when ? formatUnix(row.when) : "—"}</span>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" className="text-xs text-white underline">
                      {t("tx.view")}
                    </a>
                  ) : null}
                </div>
              );
            })}
          </Card>
        ) : (
          <StateBlock kind="empty" title={t("me.emptyRedeem")} />
        )}
      </section>
    </div>
  );
}
