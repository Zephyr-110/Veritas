"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  EMPTY_POSITION,
  fetchMarket,
  fetchPosition,
  type MarketView,
  type UserPosition,
} from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { useProgram } from "./use-program";
import { useRefresh } from "@/components/providers";

export function useMarket(address: string | null) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const program = useProgram();
  const { nonce } = useRefresh();
  const [market, setMarket] = useState<MarketView | null>(null);
  const [position, setPosition] = useState<UserPosition>(EMPTY_POSITION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!address) return;
    if (!program) {
      setError("errors.badAddress");
      setMarket(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const pk = new PublicKey(address);
      const next = await fetchMarket(connection, program, pk);
      setMarket(next);
      if (publicKey) {
        setPosition(await fetchPosition(connection, program.programId, next, publicKey));
      } else {
        setPosition(EMPTY_POSITION);
      }
      setError(null);
    } catch (err) {
      setError(parseTxError(err));
      setMarket(null);
    } finally {
      setLoading(false);
    }
  }, [address, connection, program, publicKey]);

  useEffect(() => {
    void reload();
  }, [reload, nonce]);

  return { market, position, loading, error, reload };
}
