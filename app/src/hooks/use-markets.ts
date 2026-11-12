"use client";

import { useEffect } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMarkets } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { useProgram } from "./use-program";
import { useRefresh } from "@/components/providers";

export function marketsQueryKey(rpc: string, programId: string) {
  return ["markets", rpc, programId] as const;
}

export function useMarkets() {
  const { connection } = useConnection();
  const program = useProgram();
  const { nonce } = useRefresh();
  const queryClient = useQueryClient();
  const programId = program?.programId.toBase58() ?? "";
  const key = marketsQueryKey(connection.rpcEndpoint, programId);

  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchMarkets(connection, program!),
    enabled: Boolean(program),
  });

  useEffect(() => {
    if (nonce > 0) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, queryClient, connection.rpcEndpoint, programId]);

  return {
    markets: query.data ?? [],
    loading: program ? query.isPending : false,
    error: !program
      ? "errors.badAddress"
      : query.error
        ? parseTxError(query.error)
        : null,
    reload: async () => {
      await query.refetch();
    },
  };
}
