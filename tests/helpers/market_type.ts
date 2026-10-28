import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export type Side = "yes" | "no";

export type LiveMarket = {
  id: number[];
  title: string;
  prediction: number[];
  expiry: anchor.BN;
  startCollateral: bigint;
  collateralMint: PublicKey;
  decimals: number;
  creator: PublicKey;
  oracle: PublicKey;
  market: PublicKey;
  lpMint: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  collateralVault: PublicKey;
  yesPool: PublicKey;
  noPool: PublicKey;
};

export function sideToChain(side: Side): { yes: {} } | { no: {} } {
  return side === "yes" ? { yes: {} } : { no: {} };
}
