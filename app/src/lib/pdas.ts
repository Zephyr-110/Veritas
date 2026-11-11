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
    yesMint,
    noMint,
    collateralVault,
    yesPool,
    noPool,
  };
}

export function findLpPosition(
  programId: PublicKey,
  market: PublicKey,
  owner: PublicKey
): [PublicKey, number] {
  return pda(programId, [
    Buffer.from("lp_position"),
    market.toBuffer(),
    owner.toBuffer(),
  ]);
}

export function findPushPriceFeed(programId: PublicKey, shard: number, feedId: Uint8Array): PublicKey {
  const shardBuf = Buffer.alloc(2);
  shardBuf.writeUInt16LE(shard, 0);
  return pda(programId, [shardBuf, Buffer.from(feedId)])[0];
}
