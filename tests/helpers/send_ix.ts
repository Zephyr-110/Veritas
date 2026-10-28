import * as anchor from "@coral-xyz/anchor";
import { SystemProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { TestEnv } from "./env";
import { LiveMarket, Side, sideToChain } from "./market_type";
import { findMarketPdas } from "./pdas";
import { ataOf, toBn } from "./tokens";
import { extraSigners, User } from "./users";

const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;
const ASSOCIATED_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ID;

export async function sendCreateMarket(
  env: TestEnv,
  creator: User,
  args: {
    collateralMint: anchor.web3.PublicKey;
    marketId: number[];
    prediction: number[];
    expiry: anchor.BN;
    collateralAmount: bigint;
    creatorCollateralAta?: anchor.web3.PublicKey;
    oracle?: User;
    omitOracleSignature?: boolean;
  }
): Promise<string> {
  const oracle = args.oracle ?? creator;
  const pdas = findMarketPdas(env.program.programId, args.marketId);
  return env.program.methods
    .createMarket({
      expiry: args.expiry,
      marketId: args.marketId,
      prediction: args.prediction,
      collateralAmount: toBn(args.collateralAmount),
    })
    .accountsPartial({
      creator: creator.pubkey,
      oracle: oracle.pubkey,
      market: pdas.market,
      collateralMint: args.collateralMint,
      lpMint: pdas.lpMint,
      yesMint: pdas.yesMint,
      noMint: pdas.noMint,
      lpCreatorAta: ataOf(pdas.lpMint, creator.pubkey),
      collateralVault: pdas.collateralVault,
      creatorCollateralAta:
        args.creatorCollateralAta ??
        ataOf(args.collateralMint, creator.pubkey),
      yesPool: pdas.yesPool,
      noPool: pdas.noPool,
      clock: SYSVAR_CLOCK_PUBKEY,
      associatedTokenProgram: ASSOCIATED_PROGRAM,
      tokenProgram: TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .signers(
      extraSigners(
        env,
        creator,
        args.omitOracleSignature ? undefined : oracle
      )
    )
    .rpc({ commitment: "confirmed" });
}

export async function sendAddLiquidity(
  env: TestEnv,
  lp: User,
  market: LiveMarket,
  collateralAmount: bigint
): Promise<string> {
  return env.program.methods
    .addLiquidity(toBn(collateralAmount))
    .accountsPartial({
      signer: lp.pubkey,
      market: market.market,
      collateralMint: market.collateralMint,
      lpMint: market.lpMint,
      yesMint: market.yesMint,
      noMint: market.noMint,
      businessmanYesAta: ataOf(market.yesMint, lp.pubkey),
      businessmanNoAta: ataOf(market.noMint, lp.pubkey),
      lpCreatorAta: ataOf(market.lpMint, lp.pubkey),
      collateralVault: market.collateralVault,
      businessmanCollateralAta: ataOf(market.collateralMint, lp.pubkey),
      yesPool: market.yesPool,
      noPool: market.noPool,
      associatedTokenProgram: ASSOCIATED_PROGRAM,
      clock: SYSVAR_CLOCK_PUBKEY,
      tokenProgram: TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .signers(extraSigners(env, lp))
    .rpc({ commitment: "confirmed" });
}

export async function sendUserBetOn(
  env: TestEnv,
  user: User,
  market: LiveMarket,
  args: {
    collateralAmount: bigint;
    tokenType: Side;
    minOut?: bigint;
    collateralVault?: anchor.web3.PublicKey;
  }
): Promise<string> {
  return env.program.methods
    .userBetOn({
      minOut: toBn(args.minOut ?? 1n),
      collateralAmount: toBn(args.collateralAmount),
      tokenType: sideToChain(args.tokenType),
    })
    .accountsPartial({
      signer: user.pubkey,
      market: market.market,
      collateralAta: ataOf(market.collateralMint, user.pubkey),
      collateralMint: market.collateralMint,
      collateralVault: args.collateralVault ?? market.collateralVault,
      yesMint: market.yesMint,
      noMint: market.noMint,
      yesTokenAta: ataOf(market.yesMint, user.pubkey),
      noTokenAta: ataOf(market.noMint, user.pubkey),
      yesPool: market.yesPool,
      noPool: market.noPool,
      clock: SYSVAR_CLOCK_PUBKEY,
      associatedTokenProgram: ASSOCIATED_PROGRAM,
      tokenProgram: TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .signers(extraSigners(env, user))
    .rpc({ commitment: "confirmed" });
}

export async function sendSwap(
  env: TestEnv,
  user: User,
  market: LiveMarket,
  args: { amountIn: bigint; tokenType: Side; minOut?: bigint }
): Promise<string> {
  return env.program.methods
    .swap({
      minOut: toBn(args.minOut ?? 1n),
      amountIn: toBn(args.amountIn),
      tokenType: sideToChain(args.tokenType),
    })
    .accountsPartial({
      signer: user.pubkey,
      market: market.market,
      yesMint: market.yesMint,
      noMint: market.noMint,
      yesTokenAta: ataOf(market.yesMint, user.pubkey),
      noTokenAta: ataOf(market.noMint, user.pubkey),
      yesPool: market.yesPool,
      noPool: market.noPool,
      clock: SYSVAR_CLOCK_PUBKEY,
      tokenProgram: TOKEN_PROGRAM,
    })
    .signers(extraSigners(env, user))
    .rpc({ commitment: "confirmed" });
}

export async function sendMergeToken(
  env: TestEnv,
  user: User,
  market: LiveMarket,
  mergeAmount: bigint
): Promise<string> {
  return env.program.methods
    .mergeToken(toBn(mergeAmount))
    .accountsPartial({
      signer: user.pubkey,
      market: market.market,
      collateralAta: ataOf(market.collateralMint, user.pubkey),
      collateralMint: market.collateralMint,
      collateralVault: market.collateralVault,
      yesMint: market.yesMint,
      noMint: market.noMint,
      yesTokenAta: ataOf(market.yesMint, user.pubkey),
      noTokenAta: ataOf(market.noMint, user.pubkey),
      tokenProgram: TOKEN_PROGRAM,
    })
    .signers(extraSigners(env, user))
    .rpc({ commitment: "confirmed" });
}

export async function sendGetLiquidity(
  env: TestEnv,
  lp: User,
  market: LiveMarket,
  lpAmount: bigint
): Promise<string> {
  return env.program.methods
    .getLiquidity(toBn(lpAmount))
    .accountsPartial({
      signer: lp.pubkey,
      market: market.market,
      lpMint: market.lpMint,
      yesMint: market.yesMint,
      noMint: market.noMint,
      businessmanYesAta: ataOf(market.yesMint, lp.pubkey),
      businessmanNoAta: ataOf(market.noMint, lp.pubkey),
      businessmanLpAta: ataOf(market.lpMint, lp.pubkey),
      yesPool: market.yesPool,
      noPool: market.noPool,
      associatedTokenProgram: ASSOCIATED_PROGRAM,
      tokenProgram: TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .signers(extraSigners(env, lp))
    .rpc({ commitment: "confirmed" });
}

export async function sendResolveMarket(
  env: TestEnv,
  oracle: User,
  market: LiveMarket,
  winner: Side
): Promise<string> {
  return env.program.methods
    .resolveMarket(sideToChain(winner))
    .accountsPartial({
      signer: oracle.pubkey,
      market: market.market,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .signers(extraSigners(env, oracle))
    .rpc({ commitment: "confirmed" });
}

export async function sendVoidMarket(
  env: TestEnv,
  signer: User,
  market: LiveMarket
): Promise<string> {
  return env.program.methods
    .voidMarket()
    .accountsPartial({
      signer: signer.pubkey,
      market: market.market,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .signers(extraSigners(env, signer))
    .rpc({ commitment: "confirmed" });
}

export async function sendGetCollateral(
  env: TestEnv,
  user: User,
  market: LiveMarket,
  tokenMint: anchor.web3.PublicKey,
  amount: bigint,
  overrides: {
    tokenAta?: anchor.web3.PublicKey;
    collateralVault?: anchor.web3.PublicKey;
  } = {}
): Promise<string> {
  return env.program.methods
    .getCollateral(toBn(amount))
    .accountsPartial({
      signer: user.pubkey,
      market: market.market,
      tokenMint,
      tokenAta: overrides.tokenAta ?? ataOf(tokenMint, user.pubkey),
      collateralMint: market.collateralMint,
      collateralVault: overrides.collateralVault ?? market.collateralVault,
      userCollateralAta: ataOf(market.collateralMint, user.pubkey),
      tokenProgram: TOKEN_PROGRAM,
    })
    .signers(extraSigners(env, user))
    .rpc({ commitment: "confirmed" });
}
