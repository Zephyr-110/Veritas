import {
  DYNAMIC_FEE_ANCHOR_SEC,
  DYNAMIC_FEE_BASE_BPS,
  DYNAMIC_FEE_RAMP_BPS,
  FEE_DENOMINATOR,
  SERVICE_FEE_BPS,
} from "./constants";
import { i80f48ToAmount, i80f48ToNumber } from "./codec";
import type { Side } from "./types";

/**
 * Duration-adaptive fee surface mirror of on-chain `pm_math::service_fee(remain_ts, total_ts)`:
 * - u = sqrt(clamp(remain_ts, 0, total_ts) / total_ts)
 * - k = sqrt(sqrt(total_ts / 900))
 * - fee_bps = floor(50 + 250 * (1 - u) / (1 + (k - 1) * u))
 */
export function computeDynamicFeeBps(remainTs: number, totalTs: number): number {
  if (!Number.isFinite(totalTs) || totalTs <= 0) {
    throw new Error("errors.math");
  }
  const clampedRemain = Math.min(Math.max(remainTs, 0), totalTs);
  if (clampedRemain === totalTs) return DYNAMIC_FEE_BASE_BPS;
  if (clampedRemain === 0) return DYNAMIC_FEE_BASE_BPS + DYNAMIC_FEE_RAMP_BPS;

  const u = Math.sqrt(clampedRemain / totalTs);
  const k = Math.sqrt(Math.sqrt(totalTs / DYNAMIC_FEE_ANCHOR_SEC));
  const denom = 1 + (k - 1) * u;
  const progress = Math.min(1, Math.max(0, (1 - u) / denom));
  return Math.floor(DYNAMIC_FEE_BASE_BPS + DYNAMIC_FEE_RAMP_BPS * progress);
}

/**
 * Returns the active per-leg fee in bps for a market at `nowSec`.
 * Uses the on-chain dynamic ramp when `startTs` is present (v2 415-byte layout),
 * and falls back to the persisted `feeBps` (or 30 bps default) for legacy 409-byte markets.
 */
export function currentMarketFeeBps(
  market: { startTs?: number; endTs: number; feeBps?: number },
  nowSec = Math.floor(Date.now() / 1000)
): number {
  if (market.startTs && market.startTs > 0 && market.endTs > market.startTs) {
    return computeDynamicFeeBps(market.endTs - nowSec, market.endTs - market.startTs);
  }
  return market.feeBps && market.feeBps > 0 ? market.feeBps : Number(SERVICE_FEE_BPS);
}

/** Effective combined two-leg fee percentage (e.g. 50 bps/leg -> 0.9975%). */
export function combinedFeePct(perLegBps: number): number {
  const r = perLegBps / 10_000;
  return (1 - (1 - r) * (1 - r)) * 100;
}

const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);
const SQRT_2 = Math.SQRT2;
const PRICE_LO = 1e-4;
const PRICE_HI = 1 - 1e-4;

export function normalPdf(z: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * z * z);
}

function erfApprox(x: number): number {
  const neg = x < 0;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const res = 1 - poly * Math.exp(-ax * ax);
  return neg ? -res : res;
}

export function normalCdf(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  return 0.5 * (1 + erfApprox(z / SQRT_2));
}

export function normalInvCdf(rawP: number): number {
  const p = Math.min(Math.max(rawP, PRICE_LO), PRICE_HI);
  const a = [
    -39.69683028665376,
    220.9460984245205,
    -275.9285104469687,
    138.357751867269,
    -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406,
    161.5858368580409,
    -155.6989798598866,
    66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293,
    -0.3223964580411365,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    0.007784695709041462,
    0.3224671290700398,
    2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let u: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    u =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    u =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    u =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  for (let i = 0; i < 2; i += 1) {
    const pdf = normalPdf(u);
    if (pdf < 1e-6) break;
    u -= (normalCdf(u) - p) / pdf;
  }
  return u;
}

const Z_SEARCH_MIN = -6;
const Z_SEARCH_MAX = 6;

function gY(u: number): number {
  return u * normalCdf(u) + normalPdf(u);
}

/**
 * Mirror of on-chain `pm_math::find_x_from_y` / `find_y_from_x` domain check (d7c6b08):
 * targets outside `[0, gY(Z_SEARCH_MAX)]` are unreachable on the bounded `[-6, 6]`
 * solver domain and must reject with `errors.invalidPrice` rather than silently clamping.
 */
function solveUForG(target: number, lo = Z_SEARCH_MIN, hi = Z_SEARCH_MAX): number {
  const ghi = gY(hi);
  if (!Number.isFinite(target) || target < 0 || target > ghi) {
    throw new Error("errors.invalidPrice");
  }
  const glo = gY(lo);
  if (target <= glo) return lo;
  for (let i = 0; i < 64; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (gY(mid) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export function pmAmmReservesFromPrice(price: number, lEff: number): { yes: number; no: number } {
  const u = normalInvCdf(price);
  const phiU = normalPdf(u);
  const base = u * price + phiU;
  return {
    yes: Math.max(0, lEff * (base - u)),
    no: Math.max(0, lEff * base),
  };
}

export function pmAmmPrice(yesReserve: number, noReserve: number, lEff: number): number {
  if (!Number.isFinite(lEff) || lEff <= 0) return 0.5;
  return normalCdf((noReserve - yesReserve) / lEff);
}

export function inferLeffFromReserves(yesReserve: number, noReserve: number): number {
  if (yesReserve <= 0 || noReserve <= 0) return 0;
  const d = noReserve - yesReserve;
  if (Math.abs(d) < 1e-9) return noReserve / INV_SQRT_2PI;
  let lo = 1e-9;
  let hi = (yesReserve + noReserve) * 20;
  for (let i = 0; i < 64; i += 1) {
    const mid = 0.5 * (lo + hi);
    const val = d * normalCdf(d / mid) + mid * normalPdf(d / mid) - noReserve;
    if (val < 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export function pmAmmLeff(lZeroBits: bigint, remainingSecs: number): number {
  if (lZeroBits <= 0n || remainingSecs <= 0) return 0;
  return i80f48ToNumber(lZeroBits) * Math.sqrt(remainingSecs);
}

export function pmAmmAccrue(
  market: {
    reserveYes: bigint;
    reserveNo: bigint;
    lZero?: bigint;
    endTs: number;
    lastAccrualTs: number;
  },
  nowSec = Math.floor(Date.now() / 1000)
): { reserveYes: number; reserveNo: number; lEff: number; yesPrice: number } {
  let x = Number(market.reserveYes);
  let y = Number(market.reserveNo);
  const l0 = market.lZero && market.lZero > 0n ? i80f48ToNumber(market.lZero) : 0;

  if (l0 > 0 && market.endTs > 0 && market.lastAccrualTs > 0 && market.endTs > market.lastAccrualTs) {
    const tRemOld = market.endTs - market.lastAccrualTs;
    const clampedNow = Math.min(Math.max(nowSec, market.lastAccrualTs), market.endTs - 1);
    const tRemNew = Math.max(1, market.endTs - clampedNow);
    const lOld = l0 * Math.sqrt(tRemOld);
    const lNew = l0 * Math.sqrt(tRemNew);

    if (tRemNew < tRemOld && lOld > 0) {
      const p = Math.min(Math.max(normalCdf((y - x) / lOld), PRICE_LO), PRICE_HI);
      const scaled = pmAmmReservesFromPrice(p, lNew);
      x = Math.min(x, scaled.yes);
      y = Math.min(y, scaled.no);
    }
    return {
      reserveYes: x,
      reserveNo: y,
      lEff: lNew,
      yesPrice: pmAmmPrice(x, y, lNew),
    };
  }

  const lEff = inferLeffFromReserves(x, y);
  return {
    reserveYes: x,
    reserveNo: y,
    lEff,
    yesPrice: pmAmmPrice(x, y, lEff),
  };
}

function pmAmmSwapStep(
  outputPool: number,
  inputPool: number,
  amountIn: number,
  lEff: number,
  feeBps = Number(SERVICE_FEE_BPS)
): { outAfterFee: number; newOutput: number; newInput: number } {
  if (outputPool <= 0 || inputPool <= 0 || amountIn <= 0 || lEff <= 0) {
    return { outAfterFee: 0, newOutput: outputPool, newInput: inputPool };
  }
  const netIn = (amountIn * (10000 - feeBps)) / 10000;
  const newInput = inputPool + netIn;
  const u = solveUForG(newInput / lEff);
  const newOutput = Math.max(0, newInput - u * lEff);
  const rawOut = Math.max(0, outputPool - newOutput);
  const outAfterFee = (rawOut * (10000 - feeBps)) / 10000;
  return { outAfterFee, newOutput, newInput };
}

export function pmAmmQuoteBet(
  yesReserve: number,
  noReserve: number,
  lEff: number,
  collateralAtoms: number,
  side: Side,
  feeBps = Number(SERVICE_FEE_BPS)
): { swapOut: bigint; totalOut: bigint; postYes: number; postNo: number; postYesPrice: number } {
  const outputPool = side === "yes" ? yesReserve : noReserve;
  const inputPool = side === "yes" ? noReserve : yesReserve;
  const step = pmAmmSwapStep(outputPool, inputPool, collateralAtoms, lEff, feeBps);
  const postYes = side === "yes" ? step.newOutput : step.newInput;
  const postNo = side === "yes" ? step.newInput : step.newOutput;
  const swapOut = BigInt(Math.max(0, Math.floor(step.outAfterFee)));
  const totalOut = BigInt(Math.max(0, Math.floor(collateralAtoms))) + swapOut;
  return {
    swapOut,
    totalOut,
    postYes,
    postNo,
    postYesPrice: pmAmmPrice(postYes, postNo, lEff),
  };
}

export function quoteSwapOut(
  outputPool: bigint,
  inputPool: bigint,
  amountIn: bigint,
  lEff?: number,
  feeBps = Number(SERVICE_FEE_BPS)
): bigint {
  if (outputPool <= 0n || inputPool <= 0n || amountIn <= 0n) return 0n;
  if (lEff != null && Number.isFinite(lEff) && lEff > 0) {
    const step = pmAmmSwapStep(Number(outputPool), Number(inputPool), Number(amountIn), lEff, feeBps);
    return BigInt(Math.max(0, Math.floor(step.outAfterFee)));
  }
  const feeBpsBig = BigInt(Math.max(0, Math.floor(feeBps)));
  const amountInAfterFee =
    (amountIn * (FEE_DENOMINATOR - feeBpsBig)) / FEE_DENOMINATOR;
  const denominator = inputPool + amountInAfterFee;
  if (denominator <= 0n) return 0n;
  const keep = (outputPool * inputPool) / denominator;
  return outputPool > keep ? outputPool - keep : 0n;
}

export function quoteBet(
  yesReserve: bigint,
  noReserve: bigint,
  collateralAmount: bigint,
  side: Side,
  lEff?: number,
  feeBps = Number(SERVICE_FEE_BPS)
): { swapOut: bigint; totalOut: bigint } {
  const outputPool = side === "yes" ? yesReserve : noReserve;
  const inputPool = side === "yes" ? noReserve : yesReserve;
  const swapOut = quoteSwapOut(outputPool, inputPool, collateralAmount, lEff, feeBps);
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
  // Mirror on-chain `add_liquidity.rs` (bd24f67): minor side rounds quotient up via ceil.
  const yesIn =
    yesReserve > noReserve
      ? collateralAmount
      : (collateralAmount * yesReserve + noReserve - 1n) / noReserve;
  const noIn =
    yesReserve < noReserve
      ? collateralAmount
      : (collateralAmount * noReserve + yesReserve - 1n) / yesReserve;
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
  pendingNo = 0n,
  userLpShares = lpAmount
): { yesOut: bigint; noOut: bigint } {
  if (lpSupply <= 0n || lpAmount <= 0n || userLpShares <= 0n) {
    return { yesOut: 0n, noOut: 0n };
  }
  const effectiveShares = lpAmount > userLpShares ? userLpShares : lpAmount;
  const pendingYesOut = (pendingYes * effectiveShares) / userLpShares;
  const pendingNoOut = (pendingNo * effectiveShares) / userLpShares;
  return {
    yesOut: (yesReserve * effectiveShares) / lpSupply + pendingYesOut,
    noOut: (noReserve * effectiveShares) / lpSupply + pendingNoOut,
  };
}

export function impliedYesPrice(yesReserve: bigint, noReserve: bigint, lEff?: number): number {
  const y = Number(yesReserve);
  const n = Number(noReserve);
  if (lEff != null && Number.isFinite(lEff) && lEff > 0) {
    return pmAmmPrice(y, n, lEff);
  }
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
