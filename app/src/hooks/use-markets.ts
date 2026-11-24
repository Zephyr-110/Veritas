"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { RESOLVE_WINDOW } from "@/lib/constants";
import { getMultiple, unpackAmount } from "@/lib/tokens";
import { fetchMarkets, type MarketView } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { useProgram } from "./use-program";

const EMPTY_MARKETS: MarketView[] = [];

export function marketsQueryKey(rpc: string, programId: string) {
  return ["markets", rpc, programId] as const;
}

export function useMarkets() {
  const { connection } = useConnection();
  const program = useProgram();
  const programId = program?.programId.toBase58() ?? "";
  const key = marketsQueryKey(connection.rpcEndpoint, programId);

  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchMarkets(connection, program!),
    enabled: Boolean(program),
    refetchInterval: ({ state }) => {
      const now = Date.now();
      let delay = Infinity;
      for (const market of state.data ?? []) {
        if (market.status !== "open") continue;
        const untilExpiry = market.expiry * 1000 - now;
        if (untilExpiry > 0) delay = Math.min(delay, untilExpiry);
        else if (untilExpiry > -120_000) delay = Math.min(delay, 4000);
      }
      return delay <= 2_147_483_647 ? Math.max(1, delay) : false;
    },
  });

  const errorCode = !program
    ? "errors.badAddress"
    : query.error
      ? parseTxError(query.error)
      : null;

  return {
    markets: query.data ?? EMPTY_MARKETS,
    loading: program ? query.isPending : false,
    refreshing: program ? query.isFetching && !query.isPending : false,
    updatedAt: query.dataUpdatedAt || null,
    isStaleError: Boolean(query.error && query.data),
    error: errorCode,
    reload: async () => {
      await query.refetch();
    },
  };
}

// List membership and status change only at expiry and at the end of the resolve window.
export function useMarketPhaseTime(markets: MarketView[]) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function update() {
      const time = Date.now();
      setNow(Math.floor(time / 1000));
      let next = Infinity;
      for (const market of markets) {
        if (market.status !== "open") continue;
        for (const at of [market.expiry, market.expiry + RESOLVE_WINDOW + 1]) {
          if (at * 1000 > time) next = Math.min(next, at * 1000);
        }
      }
      if (Number.isFinite(next)) timer = setTimeout(update, Math.min(next - time, 2_147_483_647));
    }
    update();
    return () => clearTimeout(timer);
  }, [markets]);
  return now;
}

// Closed-market balances can change as winners redeem. Fetch only the visible vaults.
export function useVisibleVaults(markets: MarketView[]) {
  const { connection } = useConnection();
  const closed = markets.filter((market) => market.status !== "open");
  const pages: MarketView[][] = [];
  for (let i = 0; i < closed.length; i += 30) pages.push(closed.slice(i, i + 30));
  const results = useQueries({
    queries: pages.map((page) => ({
      queryKey: ["visible-vaults", connection.rpcEndpoint, page.map((m) => m.pdas.collateralVault.toBase58())],
      queryFn: async () => {
        const infos = await getMultiple(connection, page.map((m) => m.pdas.collateralVault));
        return page.map((m, i) => [
          m.address.toBase58(), unpackAmount(m.pdas.collateralVault, infos[i], m.tokenProgram),
        ] as const);
      },
    })),
  });
  const balances = new Map(results.flatMap(({ data }) => data ?? []));
  return (market: MarketView) => market.status === "open" ? market.vault : balances.get(market.address.toBase58());
}
