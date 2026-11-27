"use client";

import { useCallback, useContext } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { useGuestSession } from "@/components/guest-session";
import { useSettings } from "@/components/providers";
import { parsePubkey } from "@/lib/program";
import { ataOf, fetchMintMeta, unpackAmount } from "@/lib/tokens";

export type WalletBalanceData = {
  usdtAtoms: bigint;
  usdtDecimals: number;
  solLamports: number;
};

let fallbackQueryClient: QueryClient | null = null;
function getFallbackQueryClient(): QueryClient {
  if (!fallbackQueryClient) {
    fallbackQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  }
  return fallbackQueryClient;
}

export function walletBalanceQueryKey(rpc: string, collateralMint: string, wallet: string) {
  return ["wallet-balance", rpc, collateralMint, wallet] as const;
}

export function useWalletBalance() {
  const connCtx = useConnection();
  const connection = connCtx?.connection;
  const { settings } = useSettings();
  const ctxClient = useContext(QueryClientContext);
  const queryClient = ctxClient ?? getFallbackQueryClient();
  const {
    effectivePublicKey,
    isSandbox,
    balance: sandboxBalance,
    balanceLoading: sandboxLoading,
    balanceStale: sandboxStale,
    balanceUpdatedAt: sandboxUpdatedAt,
  } = useGuestSession();

  const wallet = effectivePublicKey?.toBase58() ?? "";
  const rpcEndpoint = connection?.rpcEndpoint ?? "";
  const mintStr = settings.collateralMint.trim();
  const mintValid = Boolean(parsePubkey(mintStr));
  const hasRpc = Boolean(
    ctxClient &&
      connection &&
      typeof connection.getBalance === "function" &&
      typeof connection.getAccountInfo === "function"
  );

  const realEnabled = Boolean(!isSandbox && effectivePublicKey && mintValid && hasRpc);

  const realQuery = useQuery<WalletBalanceData>(
    {
      queryKey: walletBalanceQueryKey(rpcEndpoint, mintStr, wallet),
      queryFn: async () => {
        const ownerPk = new PublicKey(wallet);
        const mintPk = new PublicKey(mintStr);
        const [solLamports, meta] = await Promise.all([
          connection.getBalance(ownerPk, "confirmed"),
          fetchMintMeta(connection, mintPk),
        ]);
        const ata = ataOf(mintPk, ownerPk, meta.tokenProgram);
        const ataInfo = await connection.getAccountInfo(ata, "confirmed");
        const usdtAtoms = unpackAmount(ata, ataInfo, meta.tokenProgram);
        return {
          usdtAtoms,
          usdtDecimals: meta.decimals,
          solLamports,
        };
      },
      enabled: realEnabled,
      staleTime: 0,
    },
    queryClient
  );

  const refetch = useCallback(async () => {
    if (isSandbox) {
      await queryClient.invalidateQueries({ queryKey: ["sandbox-balance"], refetchType: "all" });
    } else if (realEnabled) {
      await realQuery.refetch();
    }
  }, [isSandbox, queryClient, realEnabled, realQuery]);

  if (isSandbox) {
    return {
      data: sandboxBalance,
      loading: sandboxLoading,
      refreshing: false,
      stale: sandboxStale,
      updatedAt: sandboxUpdatedAt,
      error: null as unknown,
      isSandbox: true,
      refetch,
    };
  }

  return {
    data: realQuery.data ?? null,
    loading: realEnabled ? realQuery.isPending : false,
    refreshing: realEnabled ? realQuery.isFetching && !realQuery.isPending : false,
    stale: Boolean(realQuery.isError && realQuery.data),
    updatedAt: realQuery.dataUpdatedAt || null,
    error: realQuery.error ?? null,
    isSandbox: false,
    refetch,
  };
}
