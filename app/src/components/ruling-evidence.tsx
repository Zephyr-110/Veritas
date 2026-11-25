"use client";

import type { ReactNode } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";
import { useT } from "@/i18n/provider";
import { feedByState } from "@/lib/feeds";
import { explorerAccount, explorerTx, toUi } from "@/lib/format";
import type { EvidenceResponse, SettlementEvidenceDto } from "@/lib/market-dto";
import { fetchMarketSnapshot, type MarketView } from "@/lib/markets";
import { fetchRuling, findPushSignatures, witnessCounts } from "@/lib/ruling-evidence";
import { useSettings } from "./providers";
import { Card } from "./ui";

function Source({ href, children }: { href?: string | null; children: ReactNode }) {
  return href ? (
    <a className="link-accent" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function CachedRulingEvidence({
  evidence,
  cluster,
}: {
  evidence: SettlementEvidenceDto;
  cluster: string;
}) {
  const t = useT();
  const rulingLink = explorerTx(evidence.resolveSignature, cluster) ?? evidence.resolveTxUrl;
  const witnessLink = explorerAccount(evidence.snapshotAddress, cluster);
  const sides = [
    {
      side: "pre" as const,
      epoch: evidence.preEpoch,
      round: evidence.preRound,
      counter: evidence.preCounter,
      price: evidence.prePrice,
      timestamp: evidence.preTimestamp,
      pushSig: evidence.prePushSignature,
      pushUrl: evidence.prePushTxUrl,
    },
    {
      side: "post" as const,
      epoch: evidence.postEpoch,
      round: evidence.postRound,
      counter: evidence.postCounter,
      price: evidence.postPrice,
      timestamp: evidence.postTimestamp,
      pushSig: evidence.postPushSignature,
      pushUrl: evidence.postPushTxUrl,
    },
  ];
  const hasCounters = evidence.preCounter != null && evidence.postCounter != null;

  return (
    <Card className="stack-2">
      <h2 className="section-title">{t("market.evidence")}</h2>
      {sides.map((item) => {
        const pushLink = item.pushSig
          ? explorerTx(item.pushSig, cluster) ?? item.pushUrl
          : item.pushUrl;
        const price = toUi(
          BigInt(item.price),
          evidence.priceDecimals,
          evidence.priceDecimals
        );
        return (
          <p key={item.side} className="num text-sm">
            {t("evidence." + item.side)} · {t("evidence.id")} {item.epoch}/{item.round}
            {hasCounters && item.counter != null && (
              <> · {t("evidence.counter")} {item.counter}</>
            )}
            {" · "}
            {t("evidence.price")} {item.side === "post" ? <strong>{price}</strong> : price}
            {" · "}
            {t("evidence.time")}{" "}
            {new Date(item.timestamp * 1000).toISOString().replace(".000Z", "Z")}
            {pushLink && (
              <>
                {" "}
                · <Source href={pushLink}>{t("evidence.push")}</Source>
              </>
            )}
          </p>
        );
      })}
      <p className="text-sm">
        {hasCounters && evidence.missingCount != null ? (
          <Source href={witnessLink}>
            {t("evidence.gap", { count: evidence.missingCount })}
          </Source>
        ) : (
          t("evidence.noWitness")
        )}
      </p>
      <footer className="text-xs text-zinc-400">
        {t("evidence.proof")} · <Source href={rulingLink}>{t("evidence.resolve")}</Source>
      </footer>
    </Card>
  );
}

export function RulingEvidence({ market }: { market: MarketView }) {
  const { connection } = useConnection();
  const { settings } = useSettings();
  const t = useT();
  const key = [
    "ruling",
    connection.rpcEndpoint,
    settings.programId,
    market.address.toBase58(),
    market.finishTs,
  ];

  const dbEvidence = useQuery({
    queryKey: ["ruling-db", settings.programId, market.address.toBase58(), market.finishTs],
    queryFn: async (): Promise<EvidenceResponse> => {
      try {
        const params = new URLSearchParams({ programId: settings.programId });
        const res = await fetch(
          `/api/evidence/${market.address.toBase58()}?${params.toString()}`
        );
        if (!res.ok) return { found: false, evidence: null };
        return (await res.json()) as EvidenceResponse;
      } catch {
        return { found: false, evidence: null };
      }
    },
    staleTime: Infinity,
  });

  const needsFallback = dbEvidence.isFetched && !dbEvidence.data?.found;

  const resolve = useQuery({
    queryKey: key,
    enabled: needsFallback,
    queryFn: ({ signal }) => fetchRuling(connection, new PublicKey(settings.programId), market, signal),
    staleTime: Infinity,
  });
  const snapshot = useQuery({
    queryKey: [...key, "snapshot"],
    enabled: needsFallback,
    queryFn: () => fetchMarketSnapshot(connection, market.pdas.snapshot),
  });
  const ruling = resolve.data;
  const feed = feedByState(market.ocr2State)?.feed;
  const pushes = useQuery({
    queryKey: [...key, "pushes", ruling?.signature, feed],
    enabled: Boolean(needsFallback && ruling && feed),
    queryFn: ({ signal }) => findPushSignatures(connection, new PublicKey(feed!), ruling!, signal),
  });

  if (dbEvidence.data?.found && dbEvidence.data.evidence) {
    return (
      <CachedRulingEvidence
        evidence={dbEvidence.data.evidence}
        cluster={settings.cluster}
      />
    );
  }

  const counts = ruling ? witnessCounts(snapshot.data ?? null, ruling.pre, ruling.post) : null;
  const rulingLink = ruling && explorerTx(ruling.signature, settings.cluster);
  const witnessLink = explorerAccount(market.pdas.snapshot.toBase58(), settings.cluster);
  const incomplete =
    needsFallback && (!ruling || !pushes.data?.pre || !pushes.data.post || snapshot.isError);
  return (
    <Card className="stack-2">
      <h2 className="section-title">{t("market.evidence")}</h2>
      {ruling ? (
        <>
          {(["pre", "post"] as const).map((side, i) => {
            const r = ruling[side];
            const sig = pushes.data?.[side];
            const pushLink = sig && explorerTx(sig, settings.cluster);
            const price = toUi(r.median, market.priceDecimals, market.priceDecimals);
            return (
              <p key={side} className="num text-sm">
                {t("evidence." + side)} · {t("evidence.id")} {r.epoch}/{r.round}
                {counts && <> · {t("evidence.counter")} {counts[i]}</>}
                {" · "}
                {t("evidence.price")} {side === "post" ? <strong>{price}</strong> : price}
                {" · "}
                {t("evidence.time")}{" "}
                {new Date(r.observationsTimestamp * 1000).toISOString().replace(".000Z", "Z")}
                {sig && (
                  <>
                    {" "}
                    · <Source href={pushLink}>{t("evidence.push")}</Source>
                  </>
                )}
              </p>
            );
          })}
          <p className="text-sm">
            {counts ? (
              <Source href={witnessLink}>
                {t("evidence.gap", { count: counts[1] - counts[0] - 1 })}
              </Source>
            ) : (
              t(
                snapshot.isPending
                  ? "evidence.loading"
                  : snapshot.isError
                    ? "evidence.witnessUnavailable"
                    : "evidence.noWitness"
              )
            )}
          </p>
          <footer className="text-xs text-zinc-400">
            {t("evidence.proof")} · <Source href={rulingLink}>{t("evidence.resolve")}</Source>
          </footer>
        </>
      ) : (
        <p className="text-sm">
          {t(dbEvidence.isPending || resolve.isFetching ? "evidence.loading" : "evidence.unavailable")}
        </p>
      )}
      {incomplete && !resolve.isFetching && !pushes.isFetching && !snapshot.isFetching && (
        <button
          className="link-accent text-xs"
          onClick={() => {
            if (!ruling) void resolve.refetch();
            if (ruling && feed) void pushes.refetch();
            if (snapshot.isError) void snapshot.refetch();
          }}
        >
          {t("common.tryAgain")}
        </button>
      )}
    </Card>
  );
}
