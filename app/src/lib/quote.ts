import { FEE_DENOMINATOR, SERVICE_FEE_BPS } from "./constants";
import { i80f48ToAmount } from "./codec";
import type { Side } from "./types";

export function quoteSwapOut(
  outputPool: bigint,
  inputPool: bigint,
  amountIn: bigint
): bigint {
  if (outputPool <= 0n || inputPool <= 0n || amountIn <= 0n) return 0n;
  const amountInAfterFee =
    (amountIn * (FEE_DENOMINATOR - SERVICE_FEE_BPS)) / FEE_DENOMINATOR;
  const denominator = inputPool + amountInAfterFee;
  if (denominator <= 0n) return 0n;
  const keep = (outputPool * inputPool) / denominator;
  return outputPool > keep ? outputPool - keep : 0n;
}

export function quoteBet(
  yesReserve: bigint,
  noReserve: bigint,
  collateralAmount: bigint,
  side: Side
): { swapOut: bigint; totalOut: bigint } {
  const outputPool = side === "yes" ? yesReserve : noReserve;
  const inputPool = side === "yes" ? noReserve : yesReserve;
  const swapOut = quoteSwapOut(outputPool, inputPool, collateralAmount);
  return { swapOut, totalOut: collateralAmount + swapOut };
}

export function quoteAddLiquidity(
  yesReserve: bigint,
  noReserve: bigint,
  lpSupply: bigint,
  collateralAmount: bigint
): { yesIn: bigint; noIn: bigint; lpOut: bigint; leftoverYes: bigint; leftoverNo: bigint } {
  if (yesReserve <= 0n || noReserve <= 0n || lpSupply <= 0n || collateralAmount <= 0n) {
    return { yesIn: 0n, noIn: 0n, lpOut: 0n, leftoverYes: 0n, leftoverNo: 0n };
  }
  const yesIn = yesReserve > noReserve ? collateralAmount : (collateralAmount * yesReserve) / noReserve;
  const noIn = yesReserve < noReserve ? collateralAmount : (collateralAmount * noReserve) / yesReserve;
  const maxReserve = yesReserve > noReserve ? yesReserve : noReserve;
  const lpOut = (collateralAmount * lpSupply) / maxReserve;
  return {
    yesIn,
    noIn,
    lpOut,
    leftoverYes: collateralAmount > yesIn ? collateralAmount - yesIn : 0n,
    leftoverNo: collateralAmount > noIn ? collateralAmount - noIn : 0n,
  };
}

export function quoteWithdrawLiquidity(
  yesReserve: bigint,
  noReserve: bigint,
  lpSupply: bigint,
  lpAmount: bigint,
  pendingYes = 0n,
  pendingNo = 0n
): { yesOut: bigint; noOut: bigint } {
  if (lpSupply <= 0n || lpAmount <= 0n) return { yesOut: pendingYes, noOut: pendingNo };
  return {
    yesOut: (yesReserve * lpAmount) / lpSupply + pendingYes,
    noOut: (noReserve * lpAmount) / lpSupply + pendingNo,
  };
}

export function impliedYesPrice(yesReserve: bigint, noReserve: bigint): number {
  const y = Number(yesReserve);
  const n = Number(noReserve);
  const sum = y + n;
  if (!Number.isFinite(sum) || sum <= 0) return 0.5;
  return n / sum;
}

export function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (amount === 0n) return 0n;
  const bps = BigInt(Math.max(0, Math.min(slippageBps, 5000)));
  return (amount * (FEE_DENOMINATOR - bps)) / FEE_DENOMINATOR;
}

export function reserveAmount(bits: bigint): bigint {
  const amt = i80f48ToAmount(bits);
  return amt > 0n ? amt : 0n;
}
