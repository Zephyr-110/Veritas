"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useMarket } from "@/hooks/use-market";
import { useNow } from "@/hooks/use-now";
import { useFeeds } from "@/hooks/use-feeds";
import { formatWhen, hasBet, isMarketVoided, marketKind, money, questionTitle } from "@/lib/display";
import { localizeError } from "@/lib/errors";
import { feedByState, formatFeedPrice, thresholdToHuman } from "@/lib/feeds";
import { countdown, explorerAccount, formatCents, formatUnix, formatYesNo, marketIdHex, shorten, toUi } from "@/lib/format";
import { COLLATERAL_SYMBOL, RESOLVE_WINDOW } from "@/lib/constants";
import { isFinalizedStatus, marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { pmAmmAccrue } from "@/lib/quote";
import { TradeDesk } from "@/components/trade-desk";
import { LiquidityCard, PriceChartCard } from "@/components/market-visuals";
import { chartPair } from "@/lib/chart";
import { LpDesk } from "@/components/lp-desk";
import { SettleDesk } from "@/components/settle-desk";
import { CountUp, FlashNum, LiveCountdown } from "@/components/live";
import { PriceAge } from "@/components/price-age";
import { RulingEvidence } from "@/components/ruling-evidence";
import { Button, Card, CopyText, DataFreshness, Kv, Reveal, SegTabs, StableText, StateBlock, StatusChip, onSpot } from "@/components/ui";
import { useGuestSession } from "@/components/guest-session";
import { useSettings } from "@/components/providers";
import { MarketDetailSkeleton } from "@/components/skeletons";
import { useLocale, useT } from "@/i18n/provider";

type Spot = { price: number; publishTime: number | null } | null;

export default function MarketDetailPage() {
  const params = useParams<{ address: string }>();
  const address = params.address;
  const { market, position, loading, refreshing, updatedAt, isStaleError, error, reload } = useMarket(address);
  const { effectivePublicKey, isSandbox } = useGuestSession();
  const now = useNow(1000);
  const { quotes, ready } = useFeeds();
  const t = useT();
  useLocale();

  const marketKey = market?.address.toBase58();
  useEffect(() => {
    if (!marketKey || typeof window === "undefined" || !window.location.hash) return;
    const targetId = window.location.hash.slice(1);
    const raf = window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [marketKey]);

  if (loading && !market) {
    return <MarketDetailSkeleton />;
  }
  if (error && !market) {
    return (
      <StateBlock
        kind="error"
        title={localizeError(error)}
        action={
          <div className="cluster-3">
            <Button type="button" tone="secondary" onClick={() => void reload()}>
              <StableText k="common.tryAgain" align="center" />
            </Button>
            <Link href="/markets" className="link-accent text-[15px]">
              <StableText k="market.backToMarkets" />
            </Link>
          </div>
        }
      />
    );
  }
  if (!market) {
    return (
      <StateBlock
        kind="error"
        title={<StableText k="market.notFound" />}
        action={
          <Link href="/markets" className="link-accent text-[15px]">
            <StableText k="market.backToMarkets" />
          </Link>
        }
      />
    );
  }

  const kind = marketKind(market, now);
  const live = kind === "live";
  const preset = feedByState(market.ocr2State);
  const feedKey = preset?.key;
  const quote = feedKey ? quotes[feedKey] : undefined;
  const spot: Spot =
    ready && quote?.available && quote?.price != null
      ? { price: quote.price, publishTime: quote.publishTime }
      : null;
  const humanThreshold = thresholdToHuman(market.threshold, market.priceDecimals);
  const pair = chartPair(feedKey);

  return (
    <div className="stack-6 fade-in">
      <div className="enter-up">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/markets" className="link-accent text-[15px]">
            <StableText k="market.back" />
          </Link>
          <DataFreshness
            updatedAt={updatedAt}
            refreshing={refreshing}
            staleError={isStaleError}
            onRefresh={() => void reload()}
          />
        </div>
        <div className="mt-3 cluster-2">
          <StatusChip market={market} now={now} />
          <span className="text-xs font-medium text-zinc-400">{market.feedSymbol}</span>
        </div>
        <h1 className="page-title mt-3">
          {market.title ? questionTitle(market) : t("common.untitled")}
        </h1>
      </div>

      <StatusBand market={market} now={now} spot={spot} humanThreshold={humanThreshold} />

      {market.status === "resolved" && <RulingEvidence market={market} />}
      <div className="split split-detail">
        {pair && <PriceChartCard
          pair={pair}
          symbol={market.feedSymbol}
          expiry={market.expiry}
          thresholdValue={Number(market.threshold) * 10 ** -market.priceDecimals}
          thresholdLabel={humanThreshold}
        />}
        <div className="order-last stack-4 stack-tight lg:col-start-1">
          {live && <LiquidityCard market={market} />}
          <Reveal>
            <PositionCard
              market={market}
              position={position}
              connected={!!effectivePublicKey}
              spot={spot}
              now={now}
            />
          </Reveal>
          <Reveal className="flex-1">
            <PoolFactsCard market={market} humanThreshold={humanThreshold} />
          </Reveal>
        </div>
        <aside className="desk-rail stack-4 lg:col-start-2 lg:row-start-1 lg:row-span-2">
          {live ? <DeskSwitcher market={market} position={position} /> : null}
          <SettleDesk market={market} position={position} />
          {!live &&
          isFinalizedStatus(market.status) &&
          !(isSandbox && position.lpShares === 0n && position.pendingYes === 0n && position.pendingNo === 0n) ? (
            <LpDesk market={market} position={position} withdrawOnly />
          ) : null}
        </aside>
      </div>

      <AddressesPanel market={market} />
    </div>
  );
}

function PoolFactsCard({ market, humanThreshold }: { market: MarketView; humanThreshold: string }) {
  return (
    <Card className="stack-3 h-full">
      <div className="section-title">
        <StableText k="market.history" />
      </div>
      <Kv k={<StableText k="market.yesReserve" />} v={`${toUi(market.reserveYes, market.decimals, 2)} YES`} />
      <Kv k={<StableText k="market.noReserve" />} v={`${toUi(market.reserveNo, market.decimals, 2)} NO`} />
      <Kv k={<StableText k="market.depth" />} v={money(market.vault, market.decimals)} />
      <p className="text-xs leading-relaxed text-zinc-500">
        <StableText k="market.vaultNote" block />
      </p>
      <Kv k={<StableText k="market.deadline" />} v={formatWhen(market.expiry)} />
      <Kv k={<StableText k="market.threshold" />} v={humanThreshold} />
      <Kv
        k={<StableText k="market.settleRule" />}
        v={
          <StableText
            k={market.settleAbove ? "market.settleAbove" : "market.settleBelow"}
            vars={{ price: humanThreshold }}
            align="end"
          />
        }
      />
    </Card>
  );
}

function DeskSwitcher({ market, position }: { market: MarketView; position: UserPosition }) {
  const [desk, setDesk] = useState<"trade" | "lp">("trade");
  return (
    <div className="stack-3">
      <SegTabs
        value={desk}
        onChange={setDesk}
        options={[
          { value: "trade", label: <StableText k="desk.trade" align="center" /> },
          { value: "lp", label: <StableText k="desk.liquidity" align="center" /> },
        ]}
      />
      {desk === "trade" ? (
        <TradeDesk market={market} position={position} />
      ) : (
        <LpDesk market={market} position={position} />
      )}
    </div>
  );
}

function AddressesPanel({ market }: { market: MarketView }) {
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  return (
    <div onMouseMove={onSpot} className="surface p-5 text-sm text-zinc-500">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between font-medium text-zinc-300 transition-colors hover:text-white"
      >
        <StableText k="market.addresses" />
        <span className={`text-xs transition-transform duration-200 ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      <div
        className={`grid transition-all duration-200 ease-out ${
          open ? "mt-4 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <div className="stack-2 font-mono text-xs">
            <Row
              kKey="market.addrMarket"
              v={market.address.toBase58()}
              explorer={explorerAccount(market.address.toBase58(), settings.cluster)}
            />
            <Row kKey="market.addrQuestionId" v={marketIdHex(market.id)} />
            <Row
              kKey="market.addrCreator"
              v={market.creator.toBase58()}
              explorer={explorerAccount(market.creator.toBase58(), settings.cluster)}
            />
            <Row
              kKey="market.addrToken"
              v={market.collateralMint.toBase58()}
              explorer={explorerAccount(market.collateralMint.toBase58(), settings.cluster)}
            />
            <Row
              kKey="market.addrFeed"
              v={market.ocr2State.toBase58()}
              explorer={explorerAccount(market.ocr2State.toBase58(), settings.cluster)}
            />
            <Row
              kKey="market.addrSnapshot"
              v={market.pdas.snapshot.toBase58()}
              explorer={explorerAccount(market.pdas.snapshot.toBase58(), settings.cluster)}
            />
            <div className="pt-0.5 text-right font-sans text-[11px] text-zinc-500">
              <StableText k="market.feedNote" align="end" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BandCell({
  labelKey,
  children,
  sub,
  valueClassName,
}: {
  labelKey: string;
  children: ReactNode;
  sub?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0 px-5 py-4">
      <div className="section-title">
        <StableText k={labelKey} />
      </div>
      <div className={`num mt-1.5 truncate text-[19px] font-semibold ${valueClassName ?? "text-zinc-50"}`}>
        {children}
      </div>
      <div className="mt-0.5 min-h-[1.25rem] truncate text-xs text-zinc-500">{sub ?? ""}</div>
    </div>
  );
}

function StatusBand({
  market,
  now,
  spot,
  humanThreshold,
}: {
  market: MarketView;
  now: number;
  spot: Spot;
  humanThreshold: string;
}) {
  const t = useT();
  const kind = marketKind(market, now);
  const phase = marketPhase(market, now);
  const thresholdNum = Number(market.threshold) * 10 ** -market.priceDecimals;

  const relation = (() => {
    if (!spot || !Number.isFinite(thresholdNum) || thresholdNum <= 0) return null;
    const delta = spot.price - thresholdNum;
    const pct = Math.abs((delta / thresholdNum) * 100);
    const absDelta = Math.abs(delta);
    const deltaText =
      absDelta >= 0.01
        ? absDelta.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : formatFeedPrice(absDelta);
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
    <BandCell labelKey="market.livePrice">
      {spot ? (
        <span className="flex items-baseline gap-2">
          <FlashNum value={spot.price}>
            <CountUp value={spot.price} format={(v) => formatFeedPrice(v)} />
          </FlashNum>
          <PriceAge publishTime={spot.publishTime} className="min-w-[4.25rem] text-left text-[11px]" />
        </span>
      ) : (
        <span className="text-zinc-500">
          <StableText k="band.spotUnavailable" />
        </span>
      )}
    </BandCell>
  );

  let cells: ReactNode;
  let noteKey: string | null = null;

  if (isFinalizedStatus(market.status)) {
    const hasSnapshot = !!market.settledPublishTime;
    const voided = isMarketVoided(market);
    cells = (
      <>
        <BandCell labelKey="market.winner">
          {voided ? (
            <span className="text-zinc-300">
              <StableText k={market.status === "staleBurn" ? "kind.staleVoid" : "kind.windowVoid"} />
            </span>
          ) : market.winner === "yes" ? (
            <span className="text-yes">{t("common.yes")}</span>
          ) : (
            <span className="text-no">{t("common.no")}</span>
          )}
        </BandCell>
        <BandCell labelKey="market.settledPrice">
          {hasSnapshot ? thresholdToHuman(market.settledPrice, market.priceDecimals) : "—"}
        </BandCell>
        <BandCell labelKey="market.settledPublishTime">
          {hasSnapshot ? formatUnix(market.settledPublishTime) : "—"}
        </BandCell>
        <BandCell labelKey="market.threshold">{humanThreshold}</BandCell>
      </>
    );
  } else if (kind === "live") {
    cells = (
      <>
        <BandCell labelKey="band.timeLeft">
          <LiveCountdown expiry={market.expiry} now={now} className="text-[19px] font-semibold text-zinc-50" />
        </BandCell>
        <BandCell labelKey="markets.colYes">
          <CountUp value={market.yesPrice} format={(v) => formatYesNo(v)} />
        </BandCell>
        {spotCell}
        <BandCell
          labelKey="band.vsThreshold"
          sub={relation ? <StableText k="band.favored" vars={{ side: relation.side }} /> : undefined}
          valueClassName={alertCls}
        >
          {relation ? relation.dir : <span className="text-zinc-500"><StableText k="band.spotUnavailable" /></span>}
        </BandCell>
      </>
    );
  } else {
    noteKey = "band.firstPrintNote";
    cells = (
      <>
        <BandCell labelKey="band.expiredFor">{countdown(now, market.expiry)}</BandCell>
        <BandCell labelKey="market.threshold">{humanThreshold}</BandCell>
        <BandCell labelKey="market.settleRule" valueClassName="text-[15px] font-medium text-zinc-200">
          <StableText
            k={market.settleAbove ? "market.settleAbove" : "market.settleBelow"}
            vars={{ price: humanThreshold }}
          />
        </BandCell>
        <BandCell labelKey="band.voidWindow">
          {phase.afterWindow ? (
            <span className="num-accent">
              <StableText k="band.voidOpenNow" />
            </span>
          ) : (
            countdown(market.expiry + RESOLVE_WINDOW, now)
          )}
        </BandCell>
      </>
    );
  }

  return (
    <div onMouseMove={onSpot} className="surface overflow-hidden">
      <div className="band-grid grid grid-cols-2 md:grid-cols-4">{cells}</div>
      {noteKey ? (
        <p className="border-t border-[var(--hair)] bg-[var(--seg-bg)] px-5 py-2.5 text-xs font-medium text-zinc-300">
          <StableText k={noteKey} block />
        </p>
      ) : null}
    </div>
  );
}

function PositionCard({
  market,
  position,
  connected,
  spot,
  now,
}: {
  market: MarketView;
  position: UserPosition;
  connected: boolean;
  spot: Spot;
  now: number;
}) {
  const empty =
    !hasBet(position) && position.lpShares === 0n && position.pendingYes === 0n && position.pendingNo === 0n;

  const hasPmAmm = Boolean(market.lZero && market.lZero > 0n);
  const accrued =
    market.status === "open" && hasPmAmm
      ? pmAmmAccrue(market, now > 0 ? now : market.lastAccrualTs)
      : null;
  const liveYesPrice = accrued ? accrued.yesPrice : market.yesPrice;
  const liveNoPrice = 1 - liveYesPrice;

  const thresholdNum = Number(market.threshold) * 10 ** -market.priceDecimals;
  const yesFavored =
    spot && Number.isFinite(thresholdNum) && thresholdNum > 0
      ? market.settleAbove
        ? spot.price >= thresholdNum
        : spot.price < thresholdNum
      : null;

  const estValueOf = (shares: bigint, price: number) => {
    const num = (Number(shares) / 10 ** market.decimals) * price;
    return Number.isFinite(num) ? `~${num.toFixed(2)} ${COLLATERAL_SYMBOL}` : "";
  };

  const finalizedClaimable =
    market.status === "resolved"
      ? market.winner === "yes"
        ? position.yes
        : position.no
      : isMarketVoided(market)
        ? position.yes / 2n + position.no / 2n
        : 0n;

  const isExpiredOpen = market.status === "open" && now > 0 && now >= market.expiry;

  return (
    <Card className="stack-3">
      <div className="section-title">
        <StableText k="me.positions" />
      </div>
      {!connected ? (
        <p className="text-sm text-zinc-500">
          <StableText k="market.connectToSee" block />
        </p>
      ) : empty ? (
        <p className="text-sm text-zinc-500">
          <StableText k="market.noPosition" block />
        </p>
      ) : (
        <>
          {position.yes > 0n ? (
            <Kv
              k={<StableText k="common.yes" />}
              v={
                <span className="inline-flex flex-wrap items-baseline justify-end gap-2">
                  <span>{toUi(position.yes, market.decimals, 2)}</span>
                  {market.status === "open" ? (
                    <span className="text-xs font-normal text-zinc-400">
                      {estValueOf(position.yes, liveYesPrice)} · {formatCents(liveYesPrice)}
                    </span>
                  ) : null}
                </span>
              }
            />
          ) : null}
          {position.no > 0n ? (
            <Kv
              k={<StableText k="common.no" />}
              v={
                <span className="inline-flex flex-wrap items-baseline justify-end gap-2">
                  <span>{toUi(position.no, market.decimals, 2)}</span>
                  {market.status === "open" ? (
                    <span className="text-xs font-normal text-zinc-400">
                      {estValueOf(position.no, liveNoPrice)} · {formatCents(liveNoPrice)}
                    </span>
                  ) : null}
                </span>
              }
            />
          ) : null}
          {market.status === "open" && spot && yesFavored !== null && hasBet(position) ? (
            <p className="border-t border-[var(--hair)] pt-2 text-xs text-zinc-400">
              <StableText
                k="market.positionSpotLead"
                vars={{
                  spot: formatFeedPrice(spot.price),
                  side: yesFavored ? "YES" : "NO",
                }}
                block
              />
            </p>
          ) : null}
          {isExpiredOpen ? (
            <p className="flex items-center gap-2 text-xs text-[var(--warn)]">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />
              <StableText k="market.awaitingPoll" />
            </p>
          ) : null}
          {isFinalizedStatus(market.status) && hasBet(position) ? (
            <Kv
              k={<StableText k="market.redeemableLabel" />}
              v={money(finalizedClaimable, market.decimals)}
            />
          ) : null}
          {position.lpShares > 0n ? (
            <Kv k={<StableText k="lp.yourShares" />} v={toUi(position.lpShares, market.decimals, 2)} />
          ) : null}
          {position.pendingYes > 0n ? (
            <Kv k={<StableText k="lp.pendingYes" />} v={toUi(position.pendingYes, market.decimals, 4)} />
          ) : null}
          {position.pendingNo > 0n ? (
            <Kv k={<StableText k="lp.pendingNo" />} v={toUi(position.pendingNo, market.decimals, 4)} />
          ) : null}
        </>
      )}
    </Card>
  );
}

function Row({ kKey, v, explorer }: { kKey: string; v: string; explorer?: string | null }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="min-w-0 truncate">
        <StableText k={kKey} />
      </span>
      <span className="flex items-center">
        <CopyText value={v} label={shorten(v, 8, 8)} />
        {explorer ? (
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer"
            aria-label="Explorer"
            className="px-1 py-0.5 text-zinc-500 transition-colors hover:text-white"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M7 17L17 7M8 7h9v9" />
            </svg>
          </a>
        ) : null}
      </span>
    </div>
  );
}
