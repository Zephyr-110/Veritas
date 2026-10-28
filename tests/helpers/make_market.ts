import * as anchor from "@coral-xyz/anchor";
import { Buffer } from "buffer";
import { Keypair } from "@solana/web3.js";
import { TestEnv } from "./env";
import { LiveMarket } from "./market_type";
import { findMarketPdas } from "./pdas";
import { sendCreateMarket } from "./send_ix";
import {
  COLLATERAL_DECIMALS,
  createCollateralMint,
  mintToUser,
  tokens,
} from "./tokens";
import { getHouse, User } from "./users";
import { chainUnixTime, waitUntilChainTime } from "./wait";

// 与合约 constants.rs 的 RESOLVE_WINDOW 保持一致
export const RESOLVE_WINDOW = 100_000;

export function toPredictionBytes(title: string): number[] {
  const buf = Buffer.alloc(64);
  Buffer.from(title, "utf8").copy(buf, 0, 0, 64);
  return Array.from(buf);
}

export function randomMarketId(): number[] {
  return Array.from(Keypair.generate().publicKey.toBytes().slice(0, 16));
}

export async function fetchMarket(
  env: TestEnv,
  market: LiveMarket | { market: anchor.web3.PublicKey }
) {
  return env.program.account.market.fetch(market.market);
}

export async function makeOpenMarket(
  env: TestEnv,
  opts: {
    creator?: User;
    oracle?: User;
    collateralMint?: anchor.web3.PublicKey;
    collateralAmount?: bigint;
    expireInSeconds?: number;
    alreadyExpired?: boolean;
    windowClosed?: boolean;
    title?: string;
    marketId?: number[];
    decimals?: number;
  } = {}
): Promise<LiveMarket> {
  const creator = opts.creator ?? getHouse(env);
  const oracle = opts.oracle ?? creator;
  const collateralMint =
    opts.collateralMint ?? (await createCollateralMint(env));
  const collateralAmount = opts.collateralAmount ?? tokens(100);
  const title = opts.title ?? "Will Bitcoin hit 1 million?";
  const prediction = toPredictionBytes(title);
  const marketId = opts.marketId ?? randomMarketId();
  if (opts.windowClosed) {
    throw new Error(
      "建盘已禁止过去的 expiry，RESOLVE_WINDOW=100000 秒，测试里等不到窗关闭"
    );
  }

  await mintToUser(
    env,
    collateralMint,
    creator.pubkey,
    collateralAmount * 5n
  );

  const now = await chainUnixTime(env.connection);
  // 建盘要求 expiry > now。alreadyExpired 先建马上到期的盘，再等到过期。
  const expiryUnix = opts.alreadyExpired
    ? now + 6
    : now + (opts.expireInSeconds ?? 3600);
  const expiry = new anchor.BN(expiryUnix);

  await sendCreateMarket(env, creator, {
    collateralMint,
    marketId,
    prediction,
    expiry,
    collateralAmount,
    oracle,
  });

  const pdas = findMarketPdas(env.program.programId, marketId);
  if (opts.alreadyExpired) {
    await waitUntilChainTime(env.connection, expiryUnix + 2);
  }
  return {
    id: marketId,
    title,
    prediction,
    expiry,
    startCollateral: collateralAmount,
    collateralMint,
    decimals: opts.decimals ?? COLLATERAL_DECIMALS,
    creator: creator.pubkey,
    oracle: oracle.pubkey,
    market: pdas.market,
    lpMint: pdas.lpMint,
    yesMint: pdas.yesMint,
    noMint: pdas.noMint,
    collateralVault: pdas.collateralVault,
    yesPool: pdas.yesPool,
    noPool: pdas.noPool,
  };
}

export async function waitUntilExpired(
  env: TestEnv,
  market: LiveMarket
): Promise<void> {
  await waitUntilChainTime(env.connection, market.expiry.toNumber() + 2);
}
