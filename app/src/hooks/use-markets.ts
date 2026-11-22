"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { fetchMarkets } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { useProgram } from "./use-program";

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
  });

  const errorCode = !program
    ? "errors.badAddress"
    : query.error
      ? parseTxError(query.error)
      : null;

  return {
    markets: query.data ?? [],
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
