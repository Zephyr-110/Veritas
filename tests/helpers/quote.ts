export const SERVICE_FEE = 30n;

export function quoteSwapOut(
  outputPool: bigint,
  inputPool: bigint,
  amountIn: bigint
): bigint {
  const amountInAfterFee = (amountIn * (10000n - SERVICE_FEE)) / 10000n;
  const denominator = inputPool + amountInAfterFee;
  const keep = (outputPool * inputPool) / denominator;
  return outputPool - keep;
}

export function quoteAddLiquidity(
  yesPool: bigint,
  noPool: bigint,
  lpSupply: bigint,
  collateralAmount: bigint
): { yesIn: bigint; noIn: bigint; lpOut: bigint } {
  const yesIn =
    yesPool > noPool
      ? collateralAmount
      : (collateralAmount * yesPool) / noPool;
  const noIn = (yesIn * noPool) / yesPool;
  const lpOut = (yesIn * lpSupply) / yesPool;
  return { yesIn, noIn, lpOut };
}

export function quoteWithdrawLiquidity(
  yesPool: bigint,
  noPool: bigint,
  lpSupply: bigint,
  lpAmount: bigint
): { yesOut: bigint; noOut: bigint } {
  return {
    yesOut: (yesPool * lpAmount) / lpSupply,
    noOut: (noPool * lpAmount) / lpSupply,
  };
}
