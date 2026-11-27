import { describe, it, expect } from "vitest";
import { SERVICE_FEE_BPS, FEE_DENOMINATOR } from "@/lib/constants";
import {
  quoteSwapOut,
  quoteBet,
  quoteAddLiquidity,
  quoteWithdrawLiquidity,
  impliedYesPrice,
  applySlippage,
  reserveAmount,
  pmAmmPrice,
  pmAmmReservesFromPrice,
  pmAmmQuoteBet,
  pmAmmAccrue,
  pmAmmLeff,
  computeDynamicFeeBps,
  currentMarketFeeBps,
  combinedFeePct,
} from "@/lib/quote";
import { i80f48ToAmount } from "@/lib/codec";

const ONE_USDT = 1_000_000n; // 6 decimals

describe("quote", () => {
  describe("quoteSwapOut", () => {
    it("computes constant-product swap with fee", () => {
      // 100 / 100 pool, swap 10 USDT "in" side
      const out = quoteSwapOut(100n * ONE_USDT, 100n * ONE_USDT, 10n * ONE_USDT);
      expect(out).toBeGreaterThan(0n);
      // post fee input is slightly less than 10
      const fee = (10n * ONE_USDT * SERVICE_FEE_BPS) / FEE_DENOMINATOR;
      expect(fee).toBeGreaterThan(0n);
      expect(out).toBeLessThan(10n * ONE_USDT); // slippage + fee
    });
    it("returns zero when inputs <= 0", () => {
      expect(quoteSwapOut(0n, 100n, 10n)).toBe(0n);
      expect(quoteSwapOut(100n, 0n, 10n)).toBe(0n);
      expect(quoteSwapOut(100n, 100n, 0n)).toBe(0n);
      expect(quoteSwapOut(100n, 100n, -1n)).toBe(0n);
    });
  });

  describe("quoteBet", () => {
    it("yes and no are symmetric with reserve swap", () => {
      const r = 50n * ONE_USDT;
      const bet = 5n * ONE_USDT;
      const yes = quoteBet(r, r, bet, "yes");
      const no = quoteBet(r, r, bet, "no");
      expect(yes.swapOut).toBe(no.swapOut);
      expect(yes.totalOut).toBe(bet + yes.swapOut);
    });
  });

  describe("quoteAddLiquidity", () => {
    it("returns zero struct on zero inputs", () => {
      const z = { yesIn: 0n, noIn: 0n, lpOut: 0n, leftoverYes: 0n, leftoverNo: 0n };
      expect(quoteAddLiquidity(0n, 100n, 100n, 10n)).toEqual(z);
      expect(quoteAddLiquidity(100n, 0n, 100n, 10n)).toEqual(z);
      expect(quoteAddLiquidity(100n, 100n, 0n, 10n)).toEqual(z);
      expect(quoteAddLiquidity(100n, 100n, 100n, 0n)).toEqual(z);
    });
    it("与合约 add_liquidity 语义一致：reserve 大的一侧吃满，另一侧按比例", () => {
      // 对照 programs/prediction_market/src/instructions/add_liquidity.rs:
      //   yes_input_amount = reserve_yes > reserve_no ? collateral_amount : collateral*reserve_yes/reserve_no
      //   no_input_amount  = reserve_yes < reserve_no ? collateral_amount : collateral*reserve_no/reserve_yes
      //   add_shares       = total_lp_shares * collateral_amount / max(reserve_yes, reserve_no)
      const collateral = 10n * ONE_USDT; // 10 USDT
      const q = quoteAddLiquidity(300n, 100n, 100n, collateral);

      expect(q.yesIn).toBe(collateral); // reserve_yes 更大 → 吃满
      expect(q.noIn).toBe((collateral * 100n) / 300n); // 整数除法向下取整
      expect(q.lpOut).toBe((collateral * 100n) / 300n); // 同一公式
      expect(q.leftoverYes).toBe(0n);
      expect(q.leftoverNo).toBe(collateral - q.noIn);
    });

    it("两侧相等时按 1:1 入池，无残留", () => {
      const collateral = 10n * ONE_USDT;
      const q = quoteAddLiquidity(100n, 100n, 100n, collateral);
      expect(q.yesIn).toBe(collateral);
      expect(q.noIn).toBe(collateral);
      expect(q.leftoverYes).toBe(0n);
      expect(q.leftoverNo).toBe(0n);
    });
  });

  describe("quoteWithdrawLiquidity", () => {
    it("returns zero when lpSupply, lpAmount, or userLpShares <= 0", () => {
      expect(quoteWithdrawLiquidity(100n, 100n, 0n, 10n, 2n, 3n, 10n)).toEqual({
        yesOut: 0n,
        noOut: 0n,
      });
      expect(quoteWithdrawLiquidity(100n, 100n, 50n, 0n, 2n, 3n, 10n)).toEqual({
        yesOut: 0n,
        noOut: 0n,
      });
      expect(quoteWithdrawLiquidity(100n, 100n, 50n, 10n, 2n, 3n, 0n)).toEqual({
        yesOut: 0n,
        noOut: 0n,
      });
    });
    it("scales pending pro-rata for partial withdraw and caps over-withdraw at userLpShares", () => {
      // Partial withdraw: 10 / 40 of user's LP shares -> 25% of pendingYes (20 -> 5) and pendingNo (40 -> 10)
      const partial = quoteWithdrawLiquidity(200n, 300n, 50n, 10n, 20n, 40n, 40n);
      expect(partial.yesOut).toBe(45n); // 200*10/50 + 20*10/40 = 40 + 5
      expect(partial.noOut).toBe(70n); // 300*10/50 + 40*10/40 = 60 + 10

      // Full withdraw: 40 / 40 -> 100% pending
      const full = quoteWithdrawLiquidity(200n, 300n, 50n, 40n, 20n, 40n, 40n);
      expect(full.yesOut).toBe(180n); // 160 + 20
      expect(full.noOut).toBe(280n); // 240 + 40

      // Over-withdraw clamped to userLpShares (40)
      const clamped = quoteWithdrawLiquidity(200n, 300n, 50n, 60n, 20n, 40n, 40n);
      expect(clamped).toEqual(full);
    });
  });

  describe("impliedYesPrice", () => {
    it("prices yes correctly from reserves", () => {
      expect(impliedYesPrice(70n, 30n)).toBeCloseTo(0.3, 5); // yes is cheaper
      expect(impliedYesPrice(30n, 70n)).toBeCloseTo(0.7, 5);
      expect(impliedYesPrice(50n, 50n)).toBeCloseTo(0.5, 5);
    });
    it("falls back to 0.5 on zero sum", () => {
      expect(impliedYesPrice(0n, 0n)).toBe(0.5);
    });
  });

  describe("applySlippage", () => {
    it("slips by bps", () => {
      expect(applySlippage(1_000_000n, 300)).toBe(970_000n); // 3%
    });
    it("caps at 5000 bps (50%)", () => {
      expect(applySlippage(1_000_000n, 99999)).toBe(500_000n);
    });
    it("clamps to 0 bps on negative input", () => {
      expect(applySlippage(1_000_000n, -10)).toBe(1_000_000n);
    });
    it("returns 0 for 0 amount", () => {
      expect(applySlippage(0n, 300)).toBe(0n);
    });
  });

  describe("reserveAmount", () => {
    it("converts i80f48 bits, clamps to non-negative", () => {
      expect(i80f48ToAmount(0n)).toBe(0n);
      expect(reserveAmount(0n)).toBe(0n);
      const one = 1n << 48n;
      expect(reserveAmount(one)).toBe(1n);
      expect(reserveAmount(-one)).toBe(0n); // clamped
    });
  });

  describe("pm-AMM Gaussian math", () => {
    it("P=0.5 时储备满足 x = y = L_eff * phi(0) 且隐含价格为 0.5", () => {
      const lEff = 1_000_000;
      const { yes, no } = pmAmmReservesFromPrice(0.5, lEff);
      const expected = lEff / Math.sqrt(2 * Math.PI);
      expect(yes).toBeCloseTo(expected, 1);
      expect(no).toBeCloseTo(expected, 1);
      expect(pmAmmPrice(yes, no, lEff)).toBeCloseTo(0.5, 6);
    });

    it("非对称价格 P=0.7 时可通过 Phi((y-x)/L_eff) 准确还原", () => {
      const lEff = 500_000;
      const { yes, no } = pmAmmReservesFromPrice(0.7, lEff);
      expect(no).toBeGreaterThan(yes);
      expect(pmAmmPrice(yes, no, lEff)).toBeCloseTo(0.7, 5);
    });

    it("pmAmmQuoteBet 买入 YES 后价格严格上升且满足 Phi((y'-x')/L_eff)", () => {
      const lEff = 250_000_000; // 250 U scale (6 decimals)
      const { yes, no } = pmAmmReservesFromPrice(0.5, lEff);
      const q = pmAmmQuoteBet(yes, no, lEff, 50_000_000, "yes");
      expect(q.swapOut).toBeGreaterThan(0n);
      expect(q.totalOut).toBe(50_000_000n + q.swapOut);
      expect(q.postYesPrice).toBeGreaterThan(0.5);
      expect(q.postYesPrice).toBeLessThan(1);
    });

    it("pmAmmAccrue 随剩余时间 sqrt(T - t) 衰减有效流动性并保持价格不变", () => {
      const endTs = 1_003_600;
      const lastAccrualTs = 1_000_000; // 剩 3600s
      const lZeroNum = 10_000; // 10_000 atoms / sqrt(s)
      const lZeroBits = BigInt(lZeroNum) << 48n;
      const lOld = pmAmmLeff(lZeroBits, 3600);
      expect(lOld).toBeCloseTo(600_000, 1);

      const { yes, no } = pmAmmReservesFromPrice(0.6, lOld);
      const accrued = pmAmmAccrue(
        {
          reserveYes: BigInt(Math.round(yes)),
          reserveNo: BigInt(Math.round(no)),
          lZero: lZeroBits,
          endTs,
          lastAccrualTs,
        },
        lastAccrualTs + 2700 // 剩 900s -> sqrt(900)/sqrt(3600) = 0.5
      );
      expect(accrued.lEff).toBeCloseTo(300_000, 1);
      expect(accrued.reserveYes).toBeCloseTo(yes * 0.5, -1);
      expect(accrued.reserveNo).toBeCloseTo(no * 0.5, -1);
      expect(accrued.yesPrice).toBeCloseTo(0.6, 4);
    });

    it("computeDynamicFeeBps 与链上 service_fee 曲线完全一致", () => {
      expect(computeDynamicFeeBps(1000, 1000)).toBe(50);
      expect(computeDynamicFeeBps(750, 1000)).toBe(83);
      expect(computeDynamicFeeBps(500, 1000)).toBe(123);
      expect(computeDynamicFeeBps(250, 1000)).toBe(175);
      expect(computeDynamicFeeBps(0, 1000)).toBe(300);
      expect(computeDynamicFeeBps(2000, 1000)).toBe(50);
      expect(computeDynamicFeeBps(-50, 1000)).toBe(300);
      expect(combinedFeePct(50)).toBeCloseTo(0.9975, 4);
      expect(combinedFeePct(300)).toBeCloseTo(5.91, 4);
    });

    it("currentMarketFeeBps 对新市场走动态费率、对旧市场回退 feeBps", () => {
      expect(currentMarketFeeBps({ startTs: 1000, endTs: 2000, feeBps: 0 }, 1000)).toBe(50);
      expect(currentMarketFeeBps({ startTs: 1000, endTs: 2000, feeBps: 0 }, 1750)).toBe(175);
      expect(currentMarketFeeBps({ endTs: 2000, feeBps: 30 }, 1750)).toBe(30);
    });
  });
});
