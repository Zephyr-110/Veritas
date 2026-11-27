"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RESOLVE_WINDOW } from "@/lib/constants";
import type { DurationFilter } from "@/lib/display";
import { getMultiple, unpackAmount } from "@/lib/tokens";
import {
  deserializeMarket,
  deserializePositionItem,
  type ListSectionFilter,
  type MarketsPageResponse,
  type WalletPositionsPageResponse,
  type WalletPositionsSummaryDto,
} from "@/lib/market-dto";
import { fetchMarkets, type MarketView, type UserPosition } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { useSettings } from "@/components/providers";
import { useProgram } from "./use-program";

const EMPTY_MARKETS: MarketView[] = [];
const EMPTY_POSITIONS: Array<{ market: MarketView; position: UserPosition }> = [];
let txRefreshEpoch = 0;

export function markTxRefresh() {
  txRefreshEpoch += 1;
}
const EMPTY_SUMMARY: WalletPositionsSummaryDto = {
  totalMarkets: 0,
  sumYes: 0,
  sumNo: 0,
  sumPending: 0,
  claimCount: 0,
  claimTotal: 0,
  lpUnclaimed: false,
};

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

type DeserializedMarketsPage = {
  markets: MarketView[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  indexedAt: number | null;
};

async function fetchMarketsPageFromApi(opts: {
  programId: string;
  section: ListSectionFilter;
  duration: DurationFilter;
  page: number;
  pageSize: number;
}): Promise<DeserializedMarketsPage> {
  const params = new URLSearchParams({
    programId: opts.programId,
    section: opts.section,
    duration: opts.duration,
    page: String(opts.page),
    pageSize: String(opts.pageSize),
  });
  const res = await fetch(`/api/markets?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as MarketsPageResponse;
  return {
    markets: json.items.map(deserializeMarket),
    total: json.total,
    page: json.page,
    pageSize: json.pageSize,
    hasMore: json.hasMore,
    indexedAt: json.indexedAt,
  };
}

export function useMarketsPage({
  section,
  duration = "all",
  page = 1,
  pageSize = 30,
  enabled = true,
}: {
  section: ListSectionFilter;
  duration?: DurationFilter;
  page?: number;
  pageSize?: number;
  enabled?: boolean;
}) {
  const program = useProgram();
  const { settings } = useSettings();
  const programId = program?.programId.toBase58() ?? settings.programId;

  const query = useQuery({
    queryKey: ["markets", "page", programId, section, duration, page, pageSize] as const,
    queryFn: () => fetchMarketsPageFromApi({ programId, section, duration, page, pageSize }),
    enabled: Boolean(programId && enabled),
    staleTime: 20_000,
    refetchInterval: section === "live" ? 30_000 : false,
  });

  const data = query.data;
  const isEnabled = Boolean(programId && enabled);
  return {
    markets: data?.markets ?? EMPTY_MARKETS,
    total: data?.total ?? 0,
    hasMore: data?.hasMore ?? false,
    indexedAt: data?.indexedAt ?? null,
    loading: isEnabled ? query.isPending : false,
    refreshing: isEnabled ? query.isFetching && !query.isPending : false,
    updatedAt: data?.indexedAt ? data.indexedAt * 1000 : query.dataUpdatedAt || null,
    isStaleError: Boolean(query.error && query.data),
    error: query.error ? parseTxError(query.error) : null,
    reload: async () => {
      await query.refetch();
    },
  };
}

export function useMarketsInfinite({
  section,
  duration = "all",
  pageSize = 30,
  enabled = true,
}: {
  section: ListSectionFilter;
  duration?: DurationFilter;
  pageSize?: number;
  enabled?: boolean;
}) {
  const program = useProgram();
  const { settings } = useSettings();
  const programId = program?.programId.toBase58() ?? settings.programId;

  const query = useInfiniteQuery({
    queryKey: ["markets", "infinite", programId, section, duration, pageSize] as const,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      fetchMarketsPageFromApi({ programId, section, duration, page: pageParam, pageSize }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.page + 1 : undefined),
    enabled: Boolean(programId && enabled),
    staleTime: 20_000,
  });

  const pages = query.data?.pages;
  const markets = useMemo(
    () => (pages ? pages.flatMap((p) => p.markets) : EMPTY_MARKETS),
    [pages]
  );
  const firstPage = pages?.[0];
  const isEnabled = Boolean(programId && enabled);

  return {
    markets,
    total: firstPage?.total ?? 0,
    hasMore: Boolean(query.hasNextPage),
    indexedAt: firstPage?.indexedAt ?? null,
    loading: isEnabled ? query.isPending : false,
    loadingMore: query.isFetchingNextPage,
    refreshing:
      isEnabled &&
      query.isFetching &&
      !query.isPending &&
      !query.isFetchingNextPage,
    updatedAt: firstPage?.indexedAt ? firstPage.indexedAt * 1000 : query.dataUpdatedAt || null,
    isStaleError: Boolean(query.error && query.data),
    error: query.error ? parseTxError(query.error) : null,
    loadMore: async () => {
      if (query.hasNextPage && !query.isFetchingNextPage) {
        await query.fetchNextPage();
      }
    },
    reload: async () => {
      await query.refetch();
    },
  };
}

type DeserializedPositionsPage = {
  rows: Array<{ market: MarketView; position: UserPosition }>;
  summary: WalletPositionsSummaryDto;
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  syncedAt: number | null;
};

export function useWalletPositionsPage({
  wallet,
  programId,
  pageSize = 30,
  enabled = true,
}: {
  wallet: string;
  programId: string;
  rpcUrl?: string;
  pageSize?: number;
  enabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const forceRefreshRef = useRef(false);
  const lastSeenEpochRef = useRef(txRefreshEpoch);
  const key = useMemo(
    () => ["positions", "page", programId, wallet, pageSize] as const,
    [programId, wallet, pageSize]
  );

  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: 1,
    queryFn: async ({ pageParam }): Promise<DeserializedPositionsPage> => {
      const hasTxRefresh = lastSeenEpochRef.current < txRefreshEpoch;
      const refresh = pageParam === 1 && (forceRefreshRef.current || hasTxRefresh);
      if (refresh) {
        forceRefreshRef.current = false;
        lastSeenEpochRef.current = txRefreshEpoch;
      }
      const params = new URLSearchParams({
        wallet,
        programId,
        page: String(pageParam),
        pageSize: String(pageSize),
      });
      if (refresh) params.set("refresh", "1");
      const res = await fetch(`/api/positions?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as WalletPositionsPageResponse;
      return {
        rows: json.items.map(deserializePositionItem),
        summary: json.summary,
        total: json.total,
        page: json.page,
        pageSize: json.pageSize,
        hasMore: json.hasMore,
        syncedAt: json.syncedAt,
      };
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.page + 1 : undefined),
    enabled: Boolean(wallet && programId && enabled),
    staleTime: 15_000,
  });

  const pages = query.data?.pages;
  const rows = useMemo(() => (pages ? pages.flatMap((p) => p.rows) : EMPTY_POSITIONS), [pages]);
  const firstPage = pages?.[0];

  const reload = useCallback(
    async (forceRefresh = false) => {
      forceRefreshRef.current = forceRefresh;
      if (forceRefresh) {
        await queryClient.invalidateQueries({ queryKey: key });
      } else {
        await query.refetch();
      }
    },
    [key, query, queryClient]
  );

  const isEnabled = Boolean(wallet && programId && enabled);

  return {
    rows,
    summary: firstPage?.summary ?? EMPTY_SUMMARY,
    total: firstPage?.total ?? 0,
    hasMore: Boolean(query.hasNextPage),
    syncedAt: firstPage?.syncedAt ?? null,
    loading: isEnabled ? query.isPending : false,
    loadingMore: query.isFetchingNextPage,
    refreshing:
      isEnabled &&
      query.isFetching &&
      !query.isPending &&
      !query.isFetchingNextPage,
    updatedAt: firstPage?.syncedAt ? firstPage.syncedAt * 1000 : query.dataUpdatedAt || null,
    isStaleError: Boolean(query.error && query.data),
    error: query.error ? parseTxError(query.error) : null,
    loadMore: async () => {
      if (query.hasNextPage && !query.isFetchingNextPage) {
        await query.fetchNextPage();
      }
    },
    reload,
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
