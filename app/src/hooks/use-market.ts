"use client";

import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EMPTY_POSITION, fetchMarket, fetchPosition, type MarketView } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { useProgram } from "./use-program";
import { marketsQueryKey } from "./use-markets";

export function useMarket(address: string | null) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const program = useProgram();
  const queryClient = useQueryClient();
  const programId = program?.programId.toBase58() ?? "";
  const wallet = publicKey?.toBase58() ?? "";
  const key = ["market", connection.rpcEndpoint, programId, address ?? "", wallet] as const;

  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const pk = new PublicKey(address!);
      const next = await fetchMarket(connection, program!, pk);
      queryClient.setQueryData<MarketView[]>(
        marketsQueryKey(connection.rpcEndpoint, programId),
        (prev) => {
          if (!prev) return prev;
          const target = next.address.toBase58();
          let updated = false;
          const list = prev.map((m) => {
            if (m.address.toBase58() !== target) return m;
            updated = true;
            return next;
          });
          return updated ? list : [next, ...list].sort((a, b) => b.expiry - a.expiry);
        }
      );
      const position = publicKey
        ? await fetchPosition(connection, program!.programId, next, publicKey)
        : EMPTY_POSITION;
      return { market: next, position };
    },
    enabled: Boolean(program && address),
  });

  const errorCode = !program
    ? "errors.badAddress"
    : query.error
      ? parseTxError(query.error)
      : null;

  return {
    market: query.data?.market ?? null,
    position: query.data?.position ?? EMPTY_POSITION,
    loading: program && address ? query.isPending : false,
    refreshing: program && address ? query.isFetching && !query.isPending : false,
    updatedAt: query.dataUpdatedAt || null,
    isStaleError: Boolean(query.error && query.data),
    error: errorCode,
    reload: async () => {
      await query.refetch();
    },
  };
}
