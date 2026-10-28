"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchMarkets, type MarketView } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { useProgram } from "./use-program";
import { useRefresh } from "@/components/providers";

export function useMarkets() {
  const { connection } = useConnection();
  const program = useProgram();
  const { nonce } = useRefresh();
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchMarkets(connection, program);
      setMarkets(rows);
      setError(null);
    } catch (err) {
      setError(parseTxError(err));
    } finally {
      setLoading(false);
    }
  }, [connection, program]);

  useEffect(() => {
    void reload();
  }, [reload, nonce]);

  return { markets, loading, error, reload };
}
