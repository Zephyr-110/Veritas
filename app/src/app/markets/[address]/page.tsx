"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMarket } from "@/hooks/use-market";
import { useNow } from "@/hooks/use-now";
import { useFeeds } from "@/hooks/use-feeds";
import { formatWhen, hasBet, marketKind, money } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { feedByHex, formatPythPrice, thresholdToHuman } from "@/lib/feeds";
import { formatUnix, formatYesNo, marketIdHex, shorten, toUi } from "@/lib/format";
import { TradeDesk } from "@/components/trade-desk";
import { LpDesk } from "@/components/lp-desk";
import { SettleDesk } from "@/components/settle-desk";
import { FlashNum, LiveCountdown } from "@/components/live";
import { Button, Card, CopyText, Kv, StateBlock, StatusChip } from "@/components/ui";
import { MarketDetailSkeleton } from "@/components/skeletons";
import { useT } from "@/i18n/provider";

export default function MarketDetailPage() {
  const params = useParams<{ address: string }>();
  const address = params.address;
  const { market, position, loading, error, reload } = useMarket(address);
  const { publicKey } = useWallet();
  const now = useNow(1000);
  const { quotes, ready } = useFeeds();
  const t = useT();

  if (loading && !market) {
    return <MarketDetailSkeleton />;
  }
  if (error || !market) {
    return (
      <StateBlock
        kind="error"
        title={error ? localizeError(error) : t("market.notFound")}
        action={
          <div className="cluster-3">
            <Button type="button" tone="secondary" onClick={() => void reload()}>
              {t("common.tryAgain")}
            </Button>
            <Link href="/markets" className="link-accent text-[15px]">
              {t("market.backToMarkets")}
            </Link>
          </div>
        }
      />
    );
  }

  const live = marketKind(market, now) === "live";
  const settled = market.status === "resolved" || market.status === "burn";
  const preset = feedByHex(market.feedHex);
  const feedKey = preset?.key;
  const spot = feedKey ? quotes[feedKey] : null;
  const humanThreshold = thresholdToHuman(market.threshold, market.exponent);
  const rule = market.settleAbove
    ? t("market.settleAbove", { price: humanThreshold })
    : t("market.settleBelow", { price: humanThreshold });

  return (
    <div className="stack-6 fade-in">
      <div>
        <Link href="/markets" className="link-accent text-[15px]">
          {t("market.back")}
        </Link>
        <div className="mt-3 cluster-2">
          <StatusChip market={market} now={now} />
          <span className="text-xs text-zinc-500">{market.feedSymbol}</span>
        </div>
        <h1 className="page-title mt-3">
          {market.title || t("common.untitled")}
        </h1>
        <p className="mt-2 num text-right text-sm text-zinc-400">{formatYesNo(market.yesPrice)}</p>
      </div>

      {settled ? (
        <div className="split split-detail">
          <Card className="stack-3">
            <div className="section-title">{t("settle.evidenceTitle")}</div>
            <Kv k={t("create.question")} v={market.title || t("common.untitled")} />
            <Kv k={t("market.threshold")} v={humanThreshold} />
            <Kv k={t("market.winner")} v={market.status === "burn" ? t("kind.voided") : market.winner === "yes" ? t("common.yes") : t("common.no")} />
            <Kv k={t("market.settledPrice")} v={market.settledPrice.toString()} />
            <Kv k={t("market.settledPublishTime")} v={market.settledPublishTime ? formatUnix(market.settledPublishTime) : "\u2014"} />
            <Kv k={t("market.settleRule")} v={rule} />
          </Card>
          <aside className="desk-rail">
            <SettleDesk market={market} position={position} />
          </aside>
        </div>
      ) : (
        <div className="split split-detail">
          <div className="stack-4">
            <Card>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="section-title">{t("market.livePrice")}</div>
                  <div className="num mt-2 text-right text-[22px] num-accent">
                    {!ready ? (
                      <div className="sk ml-auto h-6 w-24" />
                    ) : spot?.available && spot.price != null ? (
                      <FlashNum value={spot.price}>{formatPythPrice(spot.price)}</FlashNum>
                    ) : null}
                  </div>
                </div>
                <div>
                  <div className="section-title">{t("market.depth")}</div>
                  <div className="num mt-2 text-right text-[22px] num-accent">{money(market.vault, market.decimals)}</div>
                </div>
              </div>
            </Card>
            <Card className="stack-3">
              <div className="section-title">{t("market.history")}</div>
              <Kv k={t("markets.colYes")} v={formatYesNo(market.yesPrice)} />
              <Kv k={t("market.yesReserve")} v={money(market.reserveYes, market.decimals)} />
              <Kv k={t("market.noReserve")} v={money(market.reserveNo, market.decimals)} />
              <Kv k={t("market.deadline")} v={live ? <LiveCountdown expiry={market.expiry} now={now} /> : formatWhen(market.expiry)} />
              <Kv k={t("market.threshold")} v={humanThreshold} />
              <Kv k={t("market.settleRule")} v={rule} />
              <Kv k={t("me.positions")} v={
                !publicKey
                  ? t("state.connectWallet")
                  : !hasBet(position) && position.lpShares === 0n && position.pendingYes === 0n && position.pendingNo === 0n
                    ? t("market.noPosition")
                    : t("common.yes") + " " + toUi(position.yes, market.decimals, 2) + " · " + t("common.no") + " " + toUi(position.no, market.decimals, 2)
              } />
            </Card>
            <SettleDesk market={market} position={position} />
          </div>
          <aside className="desk-rail stack-4">
            {live ? <TradeDesk market={market} position={position} /> : null}
            {live ? <LpDesk market={market} position={position} /> : null}
          </aside>
        </div>
      )}

      <details className="surface p-4 text-sm text-zinc-500">
        <summary className="cursor-pointer font-medium text-zinc-300 hover:text-white">{t("market.addresses")}</summary>
        <div className="mt-4 stack-2 font-mono text-xs">
          <Row k={t("market.addrMarket")} v={market.address.toBase58()} />
          <Row k={t("market.addrQuestionId")} v={marketIdHex(market.id)} />
          <Row k={t("market.addrCreator")} v={market.creator.toBase58()} />
          <Row k={t("market.addrToken")} v={market.collateralMint.toBase58()} />
          <Row k={t("market.addrFeed")} v={market.feedHex} />
        </div>
      </details>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="min-w-0 truncate">{k}</span>
      <CopyText value={v} label={shorten(v, 8, 8)} />
    </div>
  );
}
