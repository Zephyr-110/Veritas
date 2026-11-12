"use client";

import { useEffect } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EMPTY_POSITION, fetchMarket, fetchPosition } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { useProgram } from "./use-program";
import { useRefresh } from "@/components/providers";

export function useMarket(address: string | null) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const program = useProgram();
  const { nonce } = useRefresh();
  const queryClient = useQueryClient();
  const programId = program?.programId.toBase58() ?? "";
  const wallet = publicKey?.toBase58() ?? "";
  const key = ["market", connection.rpcEndpoint, programId, address ?? "", wallet] as const;

  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const pk = new PublicKey(address!);
      const next = await fetchMarket(connection, program!, pk);
      const position = publicKey
        ? await fetchPosition(connection, program!.programId, next, publicKey)
        : EMPTY_POSITION;
      return { market: next, position };
    },
    enabled: Boolean(program && address),
  });

  useEffect(() => {
    if (nonce > 0) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, queryClient, connection.rpcEndpoint, programId, address, wallet]);

  return {
    market: query.data?.market ?? null,
    position: query.data?.position ?? EMPTY_POSITION,
    loading: program && address ? query.isPending : false,
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
