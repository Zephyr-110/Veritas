import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import type { PredictionMarket } from "@/idl/prediction_market";
import { sideToChain } from "./format";
import type { MarketView } from "./markets";
import { findMarketPdas } from "./pdas";
import { ataOf, ensureAtaIx, toBn } from "./tokens";
import type { Side } from "./types";

const ASSOCIATED_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ID;

function cuIx(units = 400_000): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units });
}

export async function ixCreateMarket(
  program: Program<PredictionMarket>,
  args: {
    creator: PublicKey;
    oracle: PublicKey;
    collateralMint: PublicKey;
    marketId: number[];
    prediction: number[];
    expiry: number;
    collateralAmount: bigint;
    tokenProgram: PublicKey;
  }
): Promise<TransactionInstruction[]> {
  const pdas = findMarketPdas(program.programId, args.marketId);
  const tokenProgram = args.tokenProgram;
  const ix = await program.methods
    .createMarket({
      expiry: toBn(args.expiry),
      marketId: args.marketId,
      prediction: args.prediction,
      collateralAmount: toBn(args.collateralAmount),
    })
    .accountsPartial({
      creator: args.creator,
      oracle: args.oracle,
      market: pdas.market,
      collateralMint: args.collateralMint,
      lpMint: pdas.lpMint,
      yesMint: pdas.yesMint,
      noMint: pdas.noMint,
      lpCreatorAta: ataOf(pdas.lpMint, args.creator, tokenProgram),
      collateralVault: pdas.collateralVault,
      creatorCollateralAta: ataOf(args.collateralMint, args.creator, tokenProgram),
      yesPool: pdas.yesPool,
      noPool: pdas.noPool,
      clock: SYSVAR_CLOCK_PUBKEY,
      associatedTokenProgram: ASSOCIATED_PROGRAM,
      tokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return [cuIx(500_000), ix];
}

export async function ixUserBetOn(
  program: Program<PredictionMarket>,
  market: MarketView,
  user: PublicKey,
  args: { collateralAmount: bigint; tokenType: Side; minOut: bigint }
): Promise<TransactionInstruction[]> {
  const tp = market.tokenProgram;
  const ix = await program.methods
    .userBetOn({
      minOut: toBn(args.minOut),
      collateralAmount: toBn(args.collateralAmount),
      tokenType: sideToChain(args.tokenType),
    })
    .accountsPartial({
      signer: user,
      market: market.address,
      collateralAta: ataOf(market.collateralMint, user, tp),
      collateralMint: market.collateralMint,
      collateralVault: market.pdas.collateralVault,
      yesMint: market.pdas.yesMint,
      noMint: market.pdas.noMint,
      yesTokenAta: ataOf(market.pdas.yesMint, user, tp),
      noTokenAta: ataOf(market.pdas.noMint, user, tp),
      yesPool: market.pdas.yesPool,
      noPool: market.pdas.noPool,
      clock: SYSVAR_CLOCK_PUBKEY,
      associatedTokenProgram: ASSOCIATED_PROGRAM,
      tokenProgram: tp,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return [cuIx(), ix];
}

export async function ixSwap(
  program: Program<PredictionMarket>,
  market: MarketView,
  user: PublicKey,
  args: { amountIn: bigint; tokenType: Side; minOut: bigint }
): Promise<TransactionInstruction[]> {
  const tp = market.tokenProgram;
  const ix = await program.methods
    .swap({
      minOut: toBn(args.minOut),
      amountIn: toBn(args.amountIn),
      tokenType: sideToChain(args.tokenType),
    })
    .accountsPartial({
      signer: user,
      market: market.address,
      yesMint: market.pdas.yesMint,
      noMint: market.pdas.noMint,
      yesTokenAta: ataOf(market.pdas.yesMint, user, tp),
      noTokenAta: ataOf(market.pdas.noMint, user, tp),
      yesPool: market.pdas.yesPool,
      noPool: market.pdas.noPool,
      clock: SYSVAR_CLOCK_PUBKEY,
      tokenProgram: tp,
    })
    .instruction();
  return [
    cuIx(),
    ensureAtaIx(user, market.pdas.yesMint, tp, user),
    ensureAtaIx(user, market.pdas.noMint, tp, user),
    ix,
  ];
}

export async function ixAddLiquidity(
  program: Program<PredictionMarket>,
  market: MarketView,
  user: PublicKey,
  collateralAmount: bigint
): Promise<TransactionInstruction[]> {
  const tp = market.tokenProgram;
  const ix = await program.methods
    .addLiquidity(toBn(collateralAmount))
    .accountsPartial({
      signer: user,
      market: market.address,
      collateralMint: market.collateralMint,
      lpMint: market.pdas.lpMint,
      yesMint: market.pdas.yesMint,
      noMint: market.pdas.noMint,
      businessmanYesAta: ataOf(market.pdas.yesMint, user, tp),
      businessmanNoAta: ataOf(market.pdas.noMint, user, tp),
      lpCreatorAta: ataOf(market.pdas.lpMint, user, tp),
      collateralVault: market.pdas.collateralVault,
      businessmanCollateralAta: ataOf(market.collateralMint, user, tp),
      yesPool: market.pdas.yesPool,
      noPool: market.pdas.noPool,
      associatedTokenProgram: ASSOCIATED_PROGRAM,
      clock: SYSVAR_CLOCK_PUBKEY,
      tokenProgram: tp,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return [cuIx(), ix];
}

export async function ixGetLiquidity(
  program: Program<PredictionMarket>,
  market: MarketView,
  user: PublicKey,
  lpAmount: bigint
): Promise<TransactionInstruction[]> {
  const tp = market.tokenProgram;
  const ix = await program.methods
    .getLiquidity(toBn(lpAmount))
    .accountsPartial({
      signer: user,
      market: market.address,
      lpMint: market.pdas.lpMint,
      yesMint: market.pdas.yesMint,
      noMint: market.pdas.noMint,
      businessmanYesAta: ataOf(market.pdas.yesMint, user, tp),
      businessmanNoAta: ataOf(market.pdas.noMint, user, tp),
      businessmanLpAta: ataOf(market.pdas.lpMint, user, tp),
      yesPool: market.pdas.yesPool,
      noPool: market.pdas.noPool,
      associatedTokenProgram: ASSOCIATED_PROGRAM,
      tokenProgram: tp,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return [
    cuIx(),
    ensureAtaIx(user, market.pdas.yesMint, tp, user),
    ensureAtaIx(user, market.pdas.noMint, tp, user),
    ensureAtaIx(user, market.pdas.lpMint, tp, user),
    ix,
  ];
}

export async function ixMergeToken(
  program: Program<PredictionMarket>,
  market: MarketView,
  user: PublicKey,
  mergeAmount: bigint
): Promise<TransactionInstruction[]> {
  const tp = market.tokenProgram;
  const ix = await program.methods
    .mergeToken(toBn(mergeAmount))
    .accountsPartial({
      signer: user,
      market: market.address,
      collateralAta: ataOf(market.collateralMint, user, tp),
      collateralMint: market.collateralMint,
      collateralVault: market.pdas.collateralVault,
      yesMint: market.pdas.yesMint,
      noMint: market.pdas.noMint,
      yesTokenAta: ataOf(market.pdas.yesMint, user, tp),
      noTokenAta: ataOf(market.pdas.noMint, user, tp),
      tokenProgram: tp,
    })
    .instruction();
  return [
    cuIx(),
    ensureAtaIx(user, market.collateralMint, tp, user),
    ensureAtaIx(user, market.pdas.yesMint, tp, user),
    ensureAtaIx(user, market.pdas.noMint, tp, user),
    ix,
  ];
}

export async function ixResolveMarket(
  program: Program<PredictionMarket>,
  market: MarketView,
  oracle: PublicKey,
  winner: Side
): Promise<TransactionInstruction[]> {
  const ix = await program.methods
    .resolveMarket(sideToChain(winner))
    .accountsPartial({
      signer: oracle,
      market: market.address,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .instruction();
  return [ix];
}

export async function ixVoidMarket(
  program: Program<PredictionMarket>,
  market: MarketView,
  signer: PublicKey
): Promise<TransactionInstruction[]> {
  const ix = await program.methods
    .voidMarket()
    .accountsPartial({
      signer,
      market: market.address,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .instruction();
  return [ix];
}

export async function ixGetCollateral(
  program: Program<PredictionMarket>,
  market: MarketView,
  user: PublicKey,
  tokenMint: PublicKey,
  amount: bigint
): Promise<TransactionInstruction[]> {
  const tp = market.tokenProgram;
  const ix = await program.methods
    .getCollateral(toBn(amount))
    .accountsPartial({
      signer: user,
      market: market.address,
      tokenMint,
      tokenAta: ataOf(tokenMint, user, tp),
      collateralMint: market.collateralMint,
      collateralVault: market.pdas.collateralVault,
      userCollateralAta: ataOf(market.collateralMint, user, tp),
      tokenProgram: tp,
    })
    .instruction();
  return [
    cuIx(),
    ensureAtaIx(user, market.collateralMint, tp, user),
    ensureAtaIx(user, tokenMint, tp, user),
    ix,
  ];
}

export { TOKEN_PROGRAM_ID };
