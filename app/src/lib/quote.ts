import { FEE_DENOMINATOR, SERVICE_FEE_BPS } from "./constants";
import type { Side } from "./types";

export function quoteSwapOut(
  outputPool: bigint,
  inputPool: bigint,
  amountIn: bigint
): bigint {
  if (outputPool === 0n || inputPool === 0n || amountIn === 0n) return 0n;
  const amountInAfterFee =
    (amountIn * (FEE_DENOMINATOR - SERVICE_FEE_BPS)) / FEE_DENOMINATOR;
  const denominator = inputPool + amountInAfterFee;
  if (denominator === 0n) return 0n;
  const keep = (outputPool * inputPool) / denominator;
  return outputPool > keep ? outputPool - keep : 0n;
}

export function quoteBet(
  yesPool: bigint,
  noPool: bigint,
  collateralAmount: bigint,
  side: Side
): { swapOut: bigint; totalOut: bigint } {
  const outputPool = side === "yes" ? yesPool : noPool;
  const inputPool = side === "yes" ? noPool : yesPool;
  const swapOut = quoteSwapOut(outputPool, inputPool, collateralAmount);
  return { swapOut, totalOut: collateralAmount + swapOut };
}

export function quoteAddLiquidity(
  yesPool: bigint,
  noPool: bigint,
  lpSupply: bigint,
  collateralAmount: bigint
): { yesIn: bigint; noIn: bigint; lpOut: bigint; leftoverYes: bigint; leftoverNo: bigint } {
  if (yesPool === 0n || noPool === 0n || lpSupply === 0n || collateralAmount === 0n) {
    return { yesIn: 0n, noIn: 0n, lpOut: 0n, leftoverYes: 0n, leftoverNo: 0n };
  }
  const yesIn =
    yesPool > noPool
      ? collateralAmount
      : (collateralAmount * yesPool) / noPool;
  const noIn = (yesIn * noPool) / yesPool;
  const lpOut = (yesIn * lpSupply) / yesPool;
  return {
    yesIn,
    noIn,
    lpOut,
    leftoverYes: collateralAmount > yesIn ? collateralAmount - yesIn : 0n,
    leftoverNo: collateralAmount > noIn ? collateralAmount - noIn : 0n,
  };
}

export function quoteWithdrawLiquidity(
  yesPool: bigint,
  noPool: bigint,
  lpSupply: bigint,
  lpAmount: bigint
): { yesOut: bigint; noOut: bigint } {
  if (lpSupply === 0n || lpAmount === 0n) return { yesOut: 0n, noOut: 0n };
  return {
    yesOut: (yesPool * lpAmount) / lpSupply,
    noOut: (noPool * lpAmount) / lpSupply,
  };
}

export function impliedYesPrice(yesPool: bigint, noPool: bigint): number {
  const sum = yesPool + noPool;
  if (sum === 0n) return 0.5;
  return Number(noPool) / Number(sum);
}

export function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (amount === 0n) return 0n;
  const bps = BigInt(Math.max(0, Math.min(slippageBps, 5000)));
  return (amount * (FEE_DENOMINATOR - bps)) / FEE_DENOMINATOR;
}
