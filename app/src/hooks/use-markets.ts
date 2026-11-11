"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchMarkets, type MarketView } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { useProgram } from "./use-program";
import { useRefresh } from "@/components/providers";

type Snapshot = {
  key: string;
  markets: MarketView[];
  error: string | null;
};

let snapshot: Snapshot | null = null;

function cacheKey(rpc: string, programId: string): string {
  return rpc + ":" + programId;
}

export function useMarkets() {
  const { connection } = useConnection();
  const program = useProgram();
  const { nonce } = useRefresh();
  const key = program ? cacheKey(connection.rpcEndpoint, program.programId.toBase58()) : "";
  const hit = Boolean(snapshot && snapshot.key === key);

  const [markets, setMarkets] = useState<MarketView[]>(() => (hit && snapshot ? snapshot.markets : []));
  const [loading, setLoading] = useState(!hit);
  const [error, setError] = useState<string | null>(() => (hit && snapshot ? snapshot.error : null));

  const reload = useCallback(
    async (silent = false) => {
      if (!program) {
        snapshot = null;
        setError("errors.badAddress");
        setMarkets([]);
        setLoading(false);
        return;
      }
      const nextKey = cacheKey(connection.rpcEndpoint, program.programId.toBase58());
      if (!silent) setLoading(true);
      try {
        const rows = await fetchMarkets(connection, program);
        snapshot = { key: nextKey, markets: rows, error: null };
        setMarkets(rows);
        setError(null);
      } catch (err) {
        const message = parseTxError(err);
        if (!snapshot || snapshot.key !== nextKey) {
          setError(message);
          setMarkets([]);
        }
      } finally {
        setLoading(false);
      }
    },
    [connection, program]
  );

  useEffect(() => {
    if (snapshot && snapshot.key === key) {
      setMarkets(snapshot.markets);
      setError(snapshot.error);
      setLoading(false);
      void reload(true);
      return;
    }
    void reload(false);
  }, [reload, nonce, key]);

  return { markets, loading, error, reload };
}
