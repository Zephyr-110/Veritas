"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { RESOLVE_WINDOW } from "@/lib/constants";
import { fromUi, toUi } from "@/lib/format";
import { ixGetCollateral, ixMergeToken, ixResolveMarket, ixVoidMarket } from "@/lib/instructions";
import { marketPhase, type MarketView, type UserPosition } from "@/lib/markets";
import { useProgram } from "@/hooks/use-program";
import { useNow } from "@/hooks/use-now";
import type { Side } from "@/lib/types";
import { Button, Card, Chip, Field, TextInput, useTx } from "./ui";

export function SettleDesk({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const { busy, run } = useTx();
  const now = useNow();
  const phase = marketPhase(market, now);
  const isOracle = !!publicKey && publicKey.equals(market.oracle);
  const mergeable = position.yes < position.no ? position.yes : position.no;

  const canResolve = market.status === "open" && phase.inWindow && isOracle;
  const canVoid =
    market.status === "open" &&
    ((phase.inWindow && isOracle) || phase.afterWindow);
  const canClaim =
    (market.status === "resolved" && (market.winner === "yes" ? position.yes : position.no) > 0n) ||
    (market.status === "burn" && (position.yes >= 2n || position.no >= 2n));

  return (
    <div className="grid gap-4">
      <Card>
        <div className="mb-1 font-bold tracking-tight text-2xl">Merge / redeem</div>
        <p className="mb-4 text-xs leading-relaxed text-mute">
          Matching Yes and No can be merged 1:1 back to collateral. After resolution, redeem the winning
          token. After a void, either side redeems at half price, minimum 2.
        </p>
        <div className="mb-4 grid grid-cols-3 gap-2 text-center text-xs">
          <Stat label="Yes" value={toUi(position.yes, market.decimals)} />
          <Stat label="No" value={toUi(position.no, market.decimals)} />
          <Stat label="Mergeable" value={toUi(mergeable, market.decimals)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            tone="ghost"
            disabled={busy || !publicKey || mergeable <= 0n}
            onClick={() =>
              publicKey && run("Merge", () => ixMergeToken(program, market, publicKey, mergeable))
            }
          >
            Merge full sets
          </Button>
          {market.status === "resolved" ? (
            <Button
              type="button"
              tone={market.winner === "yes" ? "yes" : "no"}
              disabled={busy || !canClaim || !publicKey}
              onClick={() => {
                if (!publicKey) return;
                const mint = market.winner === "yes" ? market.pdas.yesMint : market.pdas.noMint;
                const amount = market.winner === "yes" ? position.yes : position.no;
                return run("Redeem", () => ixGetCollateral(program, market, publicKey, mint, amount));
              }}
            >
              Redeem winner
            </Button>
          ) : null}
          {market.status === "burn" ? <VoidClaim market={market} position={position} /> : null}
        </div>
      </Card>

      {market.status === "open" && (phase.expired || isOracle) ? (
        <Card>
          <div className="mb-1 flex items-center gap-2">
            <span className="font-bold tracking-tight text-2xl">Resolve</span>
            {isOracle ? <Chip tone="accent">You are the oracle</Chip> : <Chip>Anyone can void after the window</Chip>}
          </div>
          <p className="mb-4 text-xs leading-relaxed text-mute">
            The oracle has {Math.floor(RESOLVE_WINDOW / 3600)} hours after expiry to publish the result.
            After that window, anyone can void the market.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              tone="yes"
              disabled={busy || !canResolve}
              onClick={() =>
                publicKey && run("Resolve Yes", () => ixResolveMarket(program, market, publicKey, "yes"))
              }
            >
              Yes wins
            </Button>
            <Button
              type="button"
              tone="no"
              disabled={busy || !canResolve}
              onClick={() =>
                publicKey && run("Resolve No", () => ixResolveMarket(program, market, publicKey, "no"))
              }
            >
              No wins
            </Button>
            <Button
              type="button"
              tone="ghost"
              disabled={busy || !canVoid || !publicKey}
              onClick={() => publicKey && run("Void market", () => ixVoidMarket(program, market, publicKey))}
            >
              Void
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-bg px-3 py-3">
      <div className="text-mute">{label}</div>
      <div className="font-mono text-ink">{value}</div>
    </div>
  );
}

function VoidClaim({ market, position }: { market: MarketView; position: UserPosition }) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const { busy, run } = useTx();
  const [side, setSide] = useState<Side>(position.yes >= position.no ? "yes" : "no");
  const max = side === "yes" ? position.yes : position.no;
  const even = max - (max % 2n);
  const [amount, setAmount] = useState(toUi(even, market.decimals, 6));
  const parsed = useMemo(() => {
    try {
      return fromUi(amount || "0", market.decimals);
    } catch {
      return 0n;
    }
  }, [amount, market.decimals]);

  return (
    <div className="w-full space-y-3 rounded-md border border-line p-3">
      <div className="flex gap-2">
        <Button type="button" tone={side === "yes" ? "yes" : "ghost"} onClick={() => setSide("yes")}>
          Redeem Yes
        </Button>
        <Button type="button" tone={side === "no" ? "no" : "ghost"} onClick={() => setSide("no")}>
          Redeem No
        </Button>
      </div>
      <Field label="Void redeem amount" hint="Half price, even amounts preferred">
        <TextInput value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Button
        type="button"
        disabled={busy || !publicKey || parsed < 2n || parsed > max}
        onClick={() => {
          if (!publicKey) return;
          const mint = side === "yes" ? market.pdas.yesMint : market.pdas.noMint;
          return run("Redeem half", () => ixGetCollateral(program, market, publicKey, mint, parsed));
        }}
      >
        Redeem {toUi(parsed / 2n, market.decimals)} collateral at half
      </Button>
    </div>
  );
}
