"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGuestSession, type SandboxBalance } from "@/components/guest-session";
import { useSettings } from "@/components/providers";
import { subscribeAccountsWithFallback, type SyncMode } from "@/lib/account-sync";
import { RESOLVE_WINDOW } from "@/lib/constants";
import { EMPTY_POSITION, fetchMarket, fetchPosition, type MarketView, type UserPosition } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { findLpPosition } from "@/lib/pdas";
import { ataOf } from "@/lib/tokens";
import { useProgram } from "./use-program";
import { marketsQueryKey } from "./use-markets";

export function useMarket(address: string | null) {
  const { connection } = useConnection();
  const {
    effectivePublicKey: publicKey,
    isSandbox,
    balance,
    balanceStale,
    balanceUpdatedAt,
  } = useGuestSession();
  const { settings } = useSettings();
  const program = useProgram();
  const queryClient = useQueryClient();
  const programId = program?.programId.toBase58() ?? "";
  const wallet = publicKey?.toBase58() ?? "";
  const [syncMode, setSyncMode] = useState<SyncMode>("live");

  const marketKey = ["market", connection.rpcEndpoint, programId, address ?? ""] as const;
  const positionKey = ["position", connection.rpcEndpoint, programId, address ?? "", wallet] as const;

  const marketQuery = useQuery({
    queryKey: marketKey,
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
      return next;
    },
    enabled: Boolean(program && address),
    refetchInterval: (q) => {
      const m = q.state.data;
      if (!m || m.status !== "open") return false;
      const nowSec = Math.floor(Date.now() / 1000);
      return nowSec >= m.expiry && nowSec <= m.expiry + RESOLVE_WINDOW ? 4000 : false;
    },
  });

  const market = marketQuery.data ?? null;

  const positionQuery = useQuery<UserPosition>({
    queryKey: positionKey,
    queryFn: async () => {
      const next = await fetchPosition(connection, program!.programId, market!, publicKey!);
      if (isSandbox && wallet && market!.collateralMint.toBase58() === settings.collateralMint.trim()) {
        const balKey = ["sandbox-balance", connection.rpcEndpoint, settings.collateralMint, wallet];
        queryClient.setQueryData<SandboxBalance>(balKey, (prev) =>
          prev && prev.usdtAtoms !== next.collateral
            ? { ...prev, usdtAtoms: next.collateral }
            : prev
        );
      }
      return next;
    },
    enabled: Boolean(program && market && publicKey),
  });

  const marketRefetchRef = useRef(marketQuery.refetch);
  marketRefetchRef.current = marketQuery.refetch;
  const positionRefetchRef = useRef(positionQuery.refetch);
  positionRefetchRef.current = positionQuery.refetch;
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  useEffect(() => {
    if (!market || market.status !== "open") return;
    const nowSec = Math.floor(Date.now() / 1000);
    const deltaMs = (market.expiry - nowSec + 1) * 1000;
    if (deltaMs <= 0 || deltaMs > 3_600_000) return;
    const timer = window.setTimeout(() => {
      void marketRefetchRef.current();
    }, deltaMs);
    return () => window.clearTimeout(timer);
  }, [market]);

  const marketAddr = market?.address.toBase58() ?? "";
  const tokenProgramAddr = market?.tokenProgram.toBase58() ?? "";
  const collateralMintAddr = market?.collateralMint.toBase58() ?? "";
  const yesMintAddr = market?.pdas.yesMint.toBase58() ?? "";
  const noMintAddr = market?.pdas.noMint.toBase58() ?? "";
  const yesPoolAddr = market?.pdas.yesPool.toBase58() ?? "";
  const noPoolAddr = market?.pdas.noPool.toBase58() ?? "";

  useEffect(() => {
    if (!programId || !marketAddr || !tokenProgramAddr || !collateralMintAddr) {
      setSyncMode("live");
      return;
    }
    const marketPk = new PublicKey(marketAddr);
    const programPk = new PublicKey(programId);
    const ownerPk = wallet ? new PublicKey(wallet) : null;
    const accounts: PublicKey[] = [
      marketPk,
      new PublicKey(yesPoolAddr),
      new PublicKey(noPoolAddr),
    ];
    if (ownerPk) {
      const tp = new PublicKey(tokenProgramAddr);
      const mintPk = new PublicKey(collateralMintAddr);
      try {
        accounts.push(
          ataOf(mintPk, ownerPk, tp),
          ataOf(new PublicKey(yesMintAddr), ownerPk, tp),
          ataOf(new PublicKey(noMintAddr), ownerPk, tp),
          findLpPosition(programPk, marketPk, ownerPk)[0]
        );
      } catch {
        accounts.push(ownerPk);
      }
    }
    return subscribeAccountsWithFallback({
      connection,
      accounts,
      onRefresh: async () => {
        await marketRefetchRef.current({ throwOnError: true });
        if (walletRef.current) {
          await positionRefetchRef.current({ throwOnError: true });
        }
      },
      onModeChange: setSyncMode,
    });
  }, [
    collateralMintAddr,
    connection,
    marketAddr,
    noMintAddr,
    noPoolAddr,
    programId,
    tokenProgramAddr,
    wallet,
    yesMintAddr,
    yesPoolAddr,
  ]);

  const matchesSandboxMint = Boolean(
    isSandbox && market && market.collateralMint.toBase58() === settings.collateralMint.trim()
  );

  const position: UserPosition = useMemo(() => {
    if (!publicKey) return EMPTY_POSITION;
    const queried = positionQuery.data;
    if (matchesSandboxMint && balance) {
      if (!queried) {
        return { ...EMPTY_POSITION, collateral: balance.usdtAtoms };
      }
      if (balanceUpdatedAt && balanceUpdatedAt > positionQuery.dataUpdatedAt) {
        return { ...queried, collateral: balance.usdtAtoms };
      }
    }
    return queried ?? EMPTY_POSITION;
  }, [balance, balanceUpdatedAt, matchesSandboxMint, positionQuery.data, positionQuery.dataUpdatedAt, publicKey]);

  const positionStale = Boolean(
    publicKey &&
      ((positionQuery.isError && Boolean(positionQuery.data)) ||
        syncMode === "stale" ||
        (matchesSandboxMint && !positionQuery.data && balanceStale))
  );

  const errorCode = !program
    ? "errors.badAddress"
    : marketQuery.error
      ? parseTxError(marketQuery.error)
      : positionQuery.error && !positionQuery.data
        ? parseTxError(positionQuery.error)
        : null;

  const updatedAt =
    Math.max(
      marketQuery.dataUpdatedAt || 0,
      positionQuery.dataUpdatedAt || 0,
      matchesSandboxMint ? balanceUpdatedAt ?? 0 : 0
    ) || null;

  return {
    market,
    position,
    positionStale,
    syncMode,
    loading: program && address ? marketQuery.isPending : false,
    refreshing: Boolean(
      program &&
        address &&
        ((marketQuery.isFetching && !marketQuery.isPending) ||
          (publicKey && positionQuery.isFetching && !positionQuery.isPending))
    ),
    updatedAt,
    isStaleError: Boolean((marketQuery.error && marketQuery.data) || positionStale),
    error: errorCode,
    reload: async () => {
      await marketQuery.refetch();
      if (walletRef.current) {
        await positionQuery.refetch();
      }
    },
  };
}
