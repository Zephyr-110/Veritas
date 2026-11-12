"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMarket } from "@/hooks/use-market";
import { useNow } from "@/hooks/use-now";
import { useFeeds } from "@/hooks/use-feeds";
import { formatWhen, hasBet, marketKind, money, questionTitle } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { feedByHex, formatPythPrice, thresholdToHuman } from "@/lib/feeds";
import { countdown, formatUnix, formatYesNo, marketIdHex, shorten, toUi } from "@/lib/format";
import { RESOLVE_WINDOW } from "@/lib/constants";
import { marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { TradeDesk } from "@/components/trade-desk";
import { LiquidityCard, PriceChartCard } from "@/components/market-visuals";
import { chartPair } from "@/lib/chart";
import { LpDesk } from "@/components/lp-desk";
import { SettleDesk } from "@/components/settle-desk";
import { CountUp, FlashNum, LiveCountdown } from "@/components/live";
import { Button, Card, CopyText, Kv, Reveal, StateBlock, StatusChip, StickyRail } from "@/components/ui";
import { MarketDetailSkeleton } from "@/components/skeletons";
import { useT } from "@/i18n/provider";

type Spot = { price: number } | null;

export default function MarketDetailPage() {
  const [v2, setV2] = useState<false | "v2" | "v3">(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setV2(q.has("v3") ? "v3" : q.has("v2") ? "v2" : false);
  }, []);
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

  const kind = marketKind(market, now);
  const live = kind === "live";
  const settled = market.status === "resolved" || market.status === "burn";
  const preset = feedByHex(market.feedHex);
  const feedKey = preset?.key;
  const quote = feedKey ? quotes[feedKey] : undefined;
  const spot: Spot = ready && quote?.available && quote?.price != null ? { price: quote.price } : null;
  const humanThreshold = thresholdToHuman(market.threshold, market.exponent);
  const pair = chartPair(feedKey);
  const rule = market.settleAbove
    ? t("market.settleAbove", { price: humanThreshold })
    : t("market.settleBelow", { price: humanThreshold });

  return (
    <div className={`stack-6 fade-in${v2 === "v2" ? " dsample" : v2 === "v3" ? " dsample3" : ""}`}>
      <div className="enter-up" style={{ animationDelay: "100ms" }}>
        <Link href="/markets" className="link-accent text-[15px]">
          {t("market.back")}
        </Link>
        <div className="mt-3 cluster-2">
          <StatusChip market={market} now={now} />
          <span className="text-xs text-zinc-500">{market.feedSymbol}</span>
        </div>
        <h1 className="page-title mt-3">
          {market.title ? questionTitle(market) : t("common.untitled")}
        </h1>
      </div>

      <StatusBand market={market} now={now} spot={spot} humanThreshold={humanThreshold} />

      {pair || live ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {pair ? (
            <div className={live ? "lg:col-span-2" : "lg:col-span-3"}>
              <PriceChartCard
                pair={pair}
                symbol={market.feedSymbol}
                expiry={market.expiry}
                thresholdValue={Number(market.threshold) * 10 ** market.exponent}
                thresholdLabel={humanThreshold}
              />
            </div>
          ) : null}
          {live ? (
            <div className={pair ? "" : "lg:col-span-3"}>
              <LiquidityCard market={market} />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="split split-detail">
        <div className="stack-4 stack-tight">
          <Reveal>
            <PositionCard market={market} position={position} connected={!!publicKey} />
          </Reveal>
          <Reveal>
            <Card className="stack-3">
              <div className="section-title">{t("market.history")}</div>
              <Kv k={t("market.yesReserve")} v={money(market.reserveYes, market.decimals)} />
              <Kv k={t("market.noReserve")} v={money(market.reserveNo, market.decimals)} />
              <Kv k={t("market.depth")} v={money(market.vault, market.decimals)} />
              <Kv k={t("market.deadline")} v={formatWhen(market.expiry)} />
              <Kv k={t("market.threshold")} v={humanThreshold} />
              <Kv k={t("market.settleRule")} v={rule} />
            </Card>
          </Reveal>
          {live ? (
            <Reveal>
              <LpDesk market={market} position={position} />
            </Reveal>
          ) : null}
        </div>
        <StickyRail className="desk-rail stack-4">
          {live ? <TradeDesk market={market} position={position} /> : null}
          <SettleDesk market={market} position={position} />
        </StickyRail>
      </div>

      <AddressesPanel market={market} />
    </div>
  );
}

function AddressesPanel({ market }: { market: MarketView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="surface p-4 text-sm text-zinc-500">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between font-medium text-zinc-300 transition-colors hover:text-white"
      >
        {t("market.addresses")}
        <span className={`text-xs transition-transform duration-300 ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      <div
        className={`grid transition-all duration-300 ease-out ${
          open ? "mt-4 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <div className="stack-2 font-mono text-xs">
            <Row k={t("market.addrMarket")} v={market.address.toBase58()} />
            <Row k={t("market.addrQuestionId")} v={marketIdHex(market.id)} />
            <Row k={t("market.addrCreator")} v={market.creator.toBase58()} />
            <Row k={t("market.addrToken")} v={market.collateralMint.toBase58()} />
            <Row k={t("market.addrFeed")} v={market.feedHex} />
          </div>
        </div>
      </div>
    </div>
  );
}

function BandCell({ label, children, sub, valueClassName }: { label: string; children: ReactNode; sub?: ReactNode; valueClassName?: string }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <div className="section-title">{label}</div>
      <div className={`num mt-1.5 truncate text-[19px] font-semibold ${valueClassName ?? "text-zinc-50"}`}>{children}</div>
      <div className="mt-0.5 min-h-[1.25rem] truncate text-xs text-zinc-500">{sub ?? ""}</div>
    </div>
  );
}

function StatusBand({ market, now, spot, humanThreshold }: { market: MarketView; now: number; spot: Spot; humanThreshold: string }) {
  const t = useT();
  const kind = marketKind(market, now);
  const phase = marketPhase(market, now);
  const thresholdNum = Number(market.threshold) * 10 ** market.exponent;

  const relation = (() => {
    if (!spot || !Number.isFinite(thresholdNum) || thresholdNum <= 0) return null;
    const delta = spot.price - thresholdNum;
    const pct = Math.abs((delta / thresholdNum) * 100);
    const absDelta = Math.abs(delta);
    const deltaText =
      absDelta >= 0.01
        ? absDelta.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : formatPythPrice(absDelta);
    const yesFavored = market.settleAbove ? delta >= 0 : delta <= 0;
    const side = yesFavored ? t("common.yes") : t("common.no");
    const dir =
      Math.abs(delta) < thresholdNum * 0.00005
        ? t("band.atThreshold")
        : delta >= 0
          ? t("band.aboveBy", { delta: deltaText, pct: pct.toFixed(2) })
          : t("band.belowBy", { delta: deltaText, pct: pct.toFixed(2) });
    return { dir, side, pct, yesFavored };
  })();

  const alertCls =
    relation && relation.pct < 0.5 ? (relation.yesFavored ? "alert-pulse alert-yes" : "alert-pulse alert-no") : undefined;

  const spotCell = (
    <BandCell label={t("market.livePrice")}>
      {spot ? (
        <FlashNum value={spot.price}>
          <CountUp value={spot.price} format={(v) => formatPythPrice(v)} />
        </FlashNum>
      ) : (
        <span className="text-zinc-500">{t("band.spotUnavailable")}</span>
      )}
    </BandCell>
  );

  let cells: ReactNode;
  let note: string | null = null;

  if (market.status === "resolved" || market.status === "burn") {
    const hasSnapshot = !!market.settledPublishTime;
    cells = (
      <>
        <BandCell label={t("market.winner")}>
          {market.status === "burn" ? (
            <span className="text-zinc-300">{t("kind.voided")}</span>
          ) : market.winner === "yes" ? (
            <span className="text-yes">{t("common.yes")}</span>
          ) : (
            <span className="text-no">{t("common.no")}</span>
          )}
        </BandCell>
        <BandCell label={t("market.settledPrice")}>
          {hasSnapshot ? thresholdToHuman(market.settledPrice, market.exponent) : "—"}
        </BandCell>
        <BandCell label={t("market.settledPublishTime")}>
          {hasSnapshot ? formatUnix(market.settledPublishTime) : "—"}
        </BandCell>
        <BandCell label={t("market.threshold")}>{humanThreshold}</BandCell>
      </>
    );
  } else if (kind === "live" || kind === "upcoming") {
    cells = (
      <>
        <BandCell label={t("band.timeLeft")}>
          <LiveCountdown expiry={market.expiry} now={now} className="text-[19px] font-semibold text-zinc-50" />
        </BandCell>
        <BandCell label={t("markets.colYes")}>
          <CountUp value={market.yesPrice} format={(v) => formatYesNo(v)} />
        </BandCell>
        {spotCell}
        <BandCell
          label={t("band.vsThreshold")}
          sub={relation ? t("band.favored", { side: relation.side }) : undefined}
          valueClassName={alertCls}
        >
          {relation ? relation.dir : <span className="text-zinc-500">{t("band.spotUnavailable")}</span>}
        </BandCell>
      </>
    );
  } else {
    note = t("band.firstPrintNote");
    cells = (
      <>
        <BandCell label={t("band.expiredFor")}>{countdown(now, market.expiry)}</BandCell>
        {spotCell}
        <BandCell
          label={t("band.indication")}
          sub={relation ? t("band.favored", { side: relation.side }) : undefined}
          valueClassName={alertCls}
        >
          {relation ? relation.dir : <span className="text-zinc-500">{t("band.spotUnavailable")}</span>}
        </BandCell>
        <BandCell label={t("band.voidWindow")}>
          {phase.afterWindow ? (
            <span className="num-accent">{t("band.voidOpenNow")}</span>
          ) : (
            countdown(market.expiry + RESOLVE_WINDOW, now)
          )}
        </BandCell>
      </>
    );
  }

  return (
    <div className="surface overflow-hidden">
      <div className="band-grid grid grid-cols-2 md:grid-cols-4">{cells}</div>
      {note ? <p className="border-t border-zinc-800/80 px-5 py-2.5 text-xs text-zinc-500">{note}</p> : null}
    </div>
  );
}

function PositionCard({ market, position, connected }: { market: MarketView; position: UserPosition; connected: boolean }) {
  const t = useT();
  const empty = !hasBet(position) && position.lpShares === 0n && position.pendingYes === 0n && position.pendingNo === 0n;
  return (
    <Card className="stack-3">
      <div className="section-title">{t("me.positions")}</div>
      {!connected ? (
        <p className="text-sm text-zinc-500">{t("market.connectToSee")}</p>
      ) : empty ? (
        <p className="text-sm text-zinc-500">{t("market.noPosition")}</p>
      ) : (
        <>
          {position.yes > 0n ? <Kv k={t("common.yes")} v={toUi(position.yes, market.decimals, 2)} /> : null}
          {position.no > 0n ? <Kv k={t("common.no")} v={toUi(position.no, market.decimals, 2)} /> : null}
          {position.lpShares > 0n ? <Kv k={t("lp.yourShares")} v={toUi(position.lpShares, market.decimals, 2)} /> : null}
          {position.pendingYes > 0n ? <Kv k={t("lp.pendingYes")} v={toUi(position.pendingYes, market.decimals, 4)} /> : null}
          {position.pendingNo > 0n ? <Kv k={t("lp.pendingNo")} v={toUi(position.pendingNo, market.decimals, 4)} /> : null}
        </>
      )}
    </Card>
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
