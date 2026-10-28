import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import type { MarketPdas } from "./types";

function pda(programId: PublicKey, seeds: Buffer[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

export function findMarketPdas(
  programId: PublicKey,
  marketId: number[] | Uint8Array
): MarketPdas {
  const [market, marketBump] = pda(programId, [
    Buffer.from("market"),
    Buffer.from(marketId),
  ]);
  const [lpMint] = pda(programId, [Buffer.from("lp_mint"), market.toBuffer()]);
  const [yesMint] = pda(programId, [Buffer.from("yes_mint"), market.toBuffer()]);
  const [noMint] = pda(programId, [Buffer.from("no_mint"), market.toBuffer()]);
  const [collateralVault] = pda(programId, [
    Buffer.from("collateral_vault"),
    market.toBuffer(),
  ]);
  const [yesPool] = pda(programId, [Buffer.from("yes_pool"), market.toBuffer()]);
  const [noPool] = pda(programId, [Buffer.from("no_pool"), market.toBuffer()]);
  return {
    market,
    marketBump,
    lpMint,
    yesMint,
    noMint,
    collateralVault,
    yesPool,
    noPool,
  };
}
