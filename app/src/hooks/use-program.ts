"use client";

import { useMemo } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { makeProgram } from "@/lib/program";
import { useSettings } from "@/components/providers";

export function useProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { settings } = useSettings();
  return useMemo(
    () => makeProgram(connection, wallet ?? null, settings.programId),
    [connection, wallet, settings.programId]
  );
}
