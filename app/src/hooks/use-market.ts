"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  fetchMarket,
  fetchPosition,
  type MarketView,
  type UserPosition,
} from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { useProgram } from "./use-program";
import { useRefresh } from "@/components/providers";

const EMPTY: UserPosition = { collateral: 0n, yes: 0n, no: 0n, lp: 0n };

export function useMarket(address: string | null) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const program = useProgram();
  const { nonce } = useRefresh();
  const [market, setMarket] = useState<MarketView | null>(null);
  const [position, setPosition] = useState<UserPosition>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const pk = new PublicKey(address);
      const next = await fetchMarket(connection, program, pk);
      setMarket(next);
      if (publicKey) {
        setPosition(await fetchPosition(connection, next, publicKey));
      } else {
        setPosition(EMPTY);
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
