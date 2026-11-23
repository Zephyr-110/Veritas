"use client";

import type { ReactNode } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";
import { useT } from "@/i18n/provider";
import { feedByState } from "@/lib/feeds";
import { explorerAccount, explorerTx, toUi } from "@/lib/format";
import { fetchMarketSnapshot, type MarketView } from "@/lib/markets";
import { fetchRuling, findPushSignatures, witnessCounts } from "@/lib/ruling-evidence";
import { useSettings } from "./providers";
import { Card } from "./ui";

function Source({ href, children }: { href?: string | null; children: ReactNode }) {
  return href ? <a className="link-accent" href={href} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;
}

export function RulingEvidence({ market }: { market: MarketView }) {
  const { connection } = useConnection();
  const { settings } = useSettings();
  const t = useT();
  const key = ["ruling", connection.rpcEndpoint, settings.programId, market.address.toBase58(), market.finishTs];
  const resolve = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchRuling(connection, new PublicKey(settings.programId), market, signal),
    staleTime: Infinity,
  });
  const snapshot = useQuery({
    queryKey: [...key, "snapshot"],
    queryFn: () => fetchMarketSnapshot(connection, market.pdas.snapshot),
  });
  const ruling = resolve.data;
  const feed = feedByState(market.ocr2State)?.feed;
  const pushes = useQuery({
    queryKey: [...key, "pushes", ruling?.signature, feed],
    enabled: Boolean(ruling && feed),
    queryFn: ({ signal }) => findPushSignatures(connection, new PublicKey(feed!), ruling!, signal),
  });
  const counts = ruling ? witnessCounts(snapshot.data ?? null, ruling.pre, ruling.post) : null;
  const rulingLink = ruling && explorerTx(ruling.signature, settings.cluster);
  const witnessLink = explorerAccount(market.pdas.snapshot.toBase58(), settings.cluster);
  const incomplete = !ruling || !pushes.data?.pre || !pushes.data.post || snapshot.isError;
  return (
    <Card className="stack-2">
      <h2 className="section-title">{t("market.evidence")}</h2>
      {ruling ? <>
        {(["pre", "post"] as const).map((side, i) => {
          const r = ruling[side];
          const sig = pushes.data?.[side];
          const pushLink = sig && explorerTx(sig, settings.cluster);
          const price = toUi(r.median, market.priceDecimals, market.priceDecimals);
          return <p key={side} className="num text-sm">
            {t("evidence." + side)} · {t("evidence.id")} <Source href={pushLink}>{r.epoch}/{r.round}</Source>
            {counts && <> · {t("evidence.counter")} <Source href={witnessLink}>{counts[i]}</Source></>}
            {" · "}{t("evidence.price")} <Source href={pushLink}>{side === "post" ? <strong>{price}</strong> : price}</Source>
            {" · "}{t("evidence.time")} <Source href={pushLink}>{new Date(r.observationsTimestamp * 1000).toISOString().replace(".000Z", "Z")}</Source>
            {sig && <> · <Source href={pushLink}>{t("evidence.push")}</Source></>}
          </p>;
        })}
        <p className="text-sm">{counts ?
          <Source href={witnessLink}>{t("evidence.gap", { count: counts[1] - counts[0] - 1 })}</Source> :
          t(snapshot.isPending ? "evidence.loading" : snapshot.isError ? "evidence.witnessUnavailable" : "evidence.noWitness")}</p>
        <footer className="text-xs text-zinc-400">{t("evidence.proof")} · <Source href={rulingLink}>{t("evidence.resolve")}</Source></footer>
      </> : <p className="text-sm">{t(resolve.isFetching ? "evidence.loading" : "evidence.unavailable")}</p>}
      {incomplete && !resolve.isFetching && !pushes.isFetching && !snapshot.isFetching &&
        <button className="link-accent text-xs" onClick={() => {
          if (!ruling) void resolve.refetch();
          if (ruling && feed) void pushes.refetch();
          if (snapshot.isError) void snapshot.refetch();
        }}>{t("common.tryAgain")}</button>}
    </Card>
  );
}
