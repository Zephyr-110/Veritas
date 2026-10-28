"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useMarket } from "@/hooks/use-market";
import { useNow } from "@/hooks/use-now";
import { countdown, formatPct, formatUnix, marketIdHex, shorten, toUi } from "@/lib/format";
import { marketPhase } from "@/lib/markets";
import { RESOLVE_WINDOW } from "@/lib/constants";
import { TradeDesk } from "@/components/trade-desk";
import { LpDesk } from "@/components/lp-desk";
import { SettleDesk } from "@/components/settle-desk";
import { Card, Chip, CopyText, OddsBar, StatusChip } from "@/components/ui";

export default function MarketPage() {
  const params = useParams<{ address: string }>();
  const address = params.address;
  const { market, position, loading, error } = useMarket(address);
  const now = useNow();

  if (loading && !market) {
    return <div className="h-80 animate-pulse rounded-xl border border-line bg-panel" />;
  }
  if (error || !market) {
    return (
      <div className="rounded-xl border border-no/40 bg-no/10 p-8 text-no">
        {error ?? "Market not found"}
        <div className="mt-4">
          <Link href="/" className="text-ink underline">
            Back to markets
          </Link>
        </div>
      </div>
    );
  }

  const phase = marketPhase(market, now);

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="space-y-6">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <StatusChip status={market.status} />
            {market.status === "resolved" ? (
              <Chip tone={market.winner === "yes" ? "yes" : "no"}>Winner {market.winner.toUpperCase()}</Chip>
            ) : null}
            <Chip tone="accent">{phase.live ? countdown(market.expiry, now) : formatUnix(market.expiry)}</Chip>
          </div>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-white">{market.title || "Untitled market"}</h1>
        </div>

        <Card>
          <div className="mb-4 flex items-end justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-[0.14em] text-yes">Yes</div>
              <div className="font-bold tracking-tight text-5xl text-yes">{formatPct(market.yesPrice)}</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-[0.14em] text-no">No</div>
              <div className="font-bold tracking-tight text-5xl text-no">{formatPct(market.noPrice)}</div>
            </div>
          </div>
          <OddsBar yes={market.yesPrice} />
          <div className="mt-6 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <Stat k="Vault" v={toUi(market.vault, market.decimals)} />
            <Stat k="Yes pool" v={toUi(market.yesPool, market.decimals)} />
            <Stat k="No pool" v={toUi(market.noPool, market.decimals)} />
            <Stat k="LP supply" v={toUi(market.lpSupply, market.decimals)} />
          </div>
        </Card>

        <Card>
          <div className="mb-3 font-bold tracking-tight text-2xl">Your position</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat k="Collateral" v={toUi(position.collateral, market.decimals)} />
            <Stat k="Yes" v={toUi(position.yes, market.decimals)} />
            <Stat k="No" v={toUi(position.no, market.decimals)} />
            <Stat k="LP" v={toUi(position.lp, market.decimals)} />
          </div>
        </Card>

        <SettleDesk market={market} position={position} />

        <details className="rounded-xl border border-line bg-panel/80 p-5 text-sm text-mute">
          <summary className="cursor-pointer font-bold tracking-tight text-lg text-ink">Accounts and rules</summary>
          <div className="mt-4 space-y-2 font-mono text-xs">
            <Row k="Market" v={market.address.toBase58()} />
            <Row k="ID" v={marketIdHex(market.id)} />
            <Row k="Creator" v={market.creator.toBase58()} />
            <Row k="Oracle" v={market.oracle.toBase58()} />
            <Row k="Collateral" v={market.collateralMint.toBase58()} />
            <Row k="Yes mint" v={market.pdas.yesMint.toBase58()} />
            <Row k="No mint" v={market.pdas.noMint.toBase58()} />
            <Row k="LP mint" v={market.pdas.lpMint.toBase58()} />
            <Row k="Resolve window" v={`${RESOLVE_WINDOW} seconds`} />
          </div>
        </details>
      </div>

      <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <TradeDesk market={market} position={position} />
        <LpDesk market={market} position={position} />
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md bg-bg px-3 py-3">
      <div className="text-xs text-mute">{k}</div>
      <div className="font-mono text-ink">{v}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span>{k}</span>
      <CopyText value={v} label={shorten(v, 8, 8)} />
    </div>
  );
}
