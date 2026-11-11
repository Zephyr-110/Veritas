"use client";

import { useMemo } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { makeProgram, parsePubkey } from "@/lib/program";
import { useSettings } from "@/components/providers";

export function useProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { settings } = useSettings();
  return useMemo(() => {
    if (!parsePubkey(settings.programId)) return null;
    try {
      return makeProgram(connection, wallet ?? null, settings.programId);
    } catch {
      return null;
    }
  }, [connection, wallet, settings.programId]);
}
