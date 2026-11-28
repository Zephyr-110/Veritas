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
    it("与合约 add_liquidity (bd24f67) 语义一致：reserve 大的一侧吃满，轻侧对商向上取整", () => {
      // 对照 programs/prediction_market/src/instructions/add_liquidity.rs:188-200:
      //   yes_input_amount = reserve_yes > reserve_no ? collateral_amount : ceil(collateral*reserve_yes/reserve_no)
      //   no_input_amount  = reserve_yes < reserve_no ? collateral_amount : ceil(collateral*reserve_no/reserve_yes)
      //   add_shares       = total_lp_shares * collateral_amount / max(reserve_yes, reserve_no)
      const collateral = 10n * ONE_USDT; // 10 USDT
      const q = quoteAddLiquidity(300n, 100n, 100n, collateral);

      expect(q.yesIn).toBe(collateral); // reserve_yes 更大 → 吃满
      expect(q.noIn).toBe((collateral * 100n + 299n) / 300n); // 3_333_334n（向上取整）
      expect(q.lpOut).toBe((collateral * 100n) / 300n);
      expect(q.leftoverYes).toBe(0n);
      expect(q.leftoverNo).toBe(collateral - q.noIn);

      // 对称方向：NO 更大，YES 为轻侧，向上取整
      const q2 = quoteAddLiquidity(100n, 300n, 100n, collateral);
      expect(q2.noIn).toBe(collateral);
      expect(q2.yesIn).toBe((collateral * 100n + 299n) / 300n);
      expect(q2.leftoverNo).toBe(0n);
      expect(q2.leftoverYes).toBe(collateral - q2.yesIn);

      // 极端小额 1 micro-unit 轻侧向上取整为 1（防止 0 入池）
      const dust = quoteAddLiquidity(100n, 300n, 100n, 1n);
      expect(dust.yesIn).toBe(1n);
      expect(dust.noIn).toBe(1n);
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

    it("超出求解域 [-6, 6] 的超大单在四个方向全部抛出 errors.invalidPrice（镜像 d7c6b08）", () => {
      const lEff = 1_000_000;
      const { yes, no } = pmAmmReservesFromPrice(0.5, lEff);
      const yesBig = BigInt(Math.round(yes));
      const noBig = BigInt(Math.round(no));
      // 超过 Z_SEARCH_MAX = 6 对应最大储备（~6 * lEff）的大单
      const huge = 7_000_000;
      const hugeBig = BigInt(huge);
      expect(() => pmAmmQuoteBet(yes, no, lEff, huge, "yes", 50)).toThrow("errors.invalidPrice");
      expect(() => pmAmmQuoteBet(yes, no, lEff, huge, "no", 50)).toThrow("errors.invalidPrice");
      expect(() => quoteBet(yesBig, noBig, hugeBig, "yes", lEff, 50)).toThrow("errors.invalidPrice");
      expect(() => quoteBet(yesBig, noBig, hugeBig, "no", lEff, 50)).toThrow("errors.invalidPrice");
      expect(() => quoteSwapOut(yesBig, noBig, hugeBig, lEff, 50)).toThrow("errors.invalidPrice");
      expect(() => quoteSwapOut(noBig, yesBig, hugeBig, lEff, 50)).toThrow("errors.invalidPrice");
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

    it("computeDynamicFeeBps 逐点命中 900s / 3600s / 86400s / 120s 全部验算锚点", () => {
      const anchors: Array<[number, Array<[number, number]>]> = [
        [
          900,
          [
            [900, 50],
            [600, 95],
            [450, 123],
            [300, 155],
            [120, 208],
            [60, 235],
            [0, 300],
          ],
        ],
        [
          3600,
          [
            [3600, 50],
            [1800, 106],
            [618, 174],
            [300, 208],
            [0, 300],
          ],
        ],
        [
          86400,
          [
            [86400, 50],
            [43200, 79],
            [21600, 110],
            [10800, 142],
            [5065, 174],
            [3600, 188],
            [1800, 213],
            [300, 259],
            [60, 280],
            [0, 300],
          ],
        ],
        [
          120,
          [
            [120, 50],
            [60, 151],
            [47, 174],
            [30, 205],
            [0, 300],
          ],
        ],
      ];

      for (const [totalTs, points] of anchors) {
        for (const [remainTs, expected] of points) {
          expect(computeDynamicFeeBps(remainTs, totalTs)).toBe(expected);
        }
      }

      // 边界钳制与非法总时长报错
      expect(computeDynamicFeeBps(2000, 900)).toBe(50);
      expect(computeDynamicFeeBps(-50, 900)).toBe(300);
      expect(() => computeDynamicFeeBps(10, 0)).toThrow("errors.math");
      expect(() => computeDynamicFeeBps(10, -1)).toThrow("errors.math");

      // 900 秒盘与旧纯比例公式逐点回归一致
      for (let remain = 0; remain <= 900; remain += 15) {
        const legacy = Math.floor(50 + 250 * (1 - Math.sqrt(remain / 900)));
        expect(computeDynamicFeeBps(remain, 900)).toBe(legacy);
      }

      expect(combinedFeePct(50)).toBeCloseTo(0.9975, 4);
      expect(combinedFeePct(300)).toBeCloseTo(5.91, 4);
    });

    it("currentMarketFeeBps 对新市场走动态费率、对旧市场回退 feeBps", () => {
      expect(currentMarketFeeBps({ startTs: 1000, endTs: 1900, feeBps: 0 }, 1000)).toBe(50);
      expect(currentMarketFeeBps({ startTs: 1000, endTs: 1900, feeBps: 0 }, 1450)).toBe(123);
      expect(currentMarketFeeBps({ startTs: 1000, endTs: 4600, feeBps: 0 }, 2800)).toBe(106);
      expect(currentMarketFeeBps({ endTs: 2000, feeBps: 30 }, 1750)).toBe(30);
    });

    it("quoteBet 与 quoteSwapDetail 暴露与报价同源的本腿手续费金额 feeIn", async () => {
      const { quoteSwapDetail } = await import("@/lib/quote");
      // 2 USDT at 175 bps -> 0.035 USDT = 35_000 atoms (both pm-AMM and fallback)
      const betPm = quoteBet(150_000_000n, 150_000_000n, 2_000_000n, "yes", 375_994_241, 175);
      expect(betPm.feeIn).toBe(35_000n);
      const swapPm = quoteSwapDetail(150_000_000n, 150_000_000n, 2_000_000n, 375_994_241, 175);
      expect(swapPm.feeIn).toBe(35_000n);
      expect(swapPm.amountOut).toBe(betPm.swapOut);

      // Constant-product fallback (no lEff): 1 USDT at 50 bps -> 0.005 USDT = 5_000 atoms, no output leg fee
      const betFallback = quoteBet(100_000_000n, 100_000_000n, 1_000_000n, "yes", undefined, 50);
      expect(betFallback.feeIn).toBe(5_000n);
      expect(betFallback.feeOut).toBe(0n);
      const swapFallback = quoteSwapDetail(100_000_000n, 100_000_000n, 1_000_000n, undefined, 50);
      expect(swapFallback.feeIn).toBe(5_000n);
      expect(swapFallback.feeOut).toBe(0n);
    });

    it("quoteSwapDetail / quoteBet / pmAmmQuoteBet 返回与 outAfterFee 互洽的出腿费 feeOut", async () => {
      const { quoteSwapDetail } = await import("@/lib/quote");
      const lEff = 375_994_241; // ~150 USDT pool at P=0.5

      // 1. Balanced P=0.5 pool, 5 USDT at 123 bps
      const bal = pmAmmReservesFromPrice(0.5, lEff);
      const balYes = BigInt(Math.round(bal.yes));
      const balNo = BigInt(Math.round(bal.no));
      const feeBps = 123;
      const swapBal = quoteSwapDetail(balYes, balNo, 5_000_000n, lEff, feeBps);
      const betBal = quoteBet(balYes, balNo, 5_000_000n, "yes", lEff, feeBps);
      const pmBal = pmAmmQuoteBet(Number(balYes), Number(balNo), lEff, 5_000_000, "yes", feeBps);

      // feeOut / (amountOut + feeOut) === feeBps / 10_000 (within ±1 atom integer rounding)
      expect(swapBal.feeOut).toBeGreaterThan(0n);
      expect(betBal.feeOut).toBe(swapBal.feeOut);
      expect(pmBal.feeOut).toBe(swapBal.feeOut);
      expect(pmBal.feeIn).toBe(swapBal.feeIn);
      const expectedFeeOutFromAfterFee = (Number(swapBal.amountOut) * feeBps) / (10_000 - feeBps);
      expect(Math.abs(Number(swapBal.feeOut) - expectedFeeOutFromAfterFee)).toBeLessThanOrEqual(2);

      // 2. Skewed P=0.80 pool: buying expensive YES yields fewer YES shares -> feeOut < feeIn;
      //    buying cheap NO yields more NO shares -> feeOut > feeIn
      const skewed = pmAmmReservesFromPrice(0.8, lEff);
      const skewYes = BigInt(Math.round(skewed.yes));
      const skewNo = BigInt(Math.round(skewed.no));
      const betExpensive = quoteBet(skewYes, skewNo, 5_000_000n, "yes", lEff, 100);
      const betCheap = quoteBet(skewYes, skewNo, 5_000_000n, "no", lEff, 100);

      expect(betExpensive.feeIn).toBe(50_000n);
      expect(betCheap.feeIn).toBe(50_000n);
      expect(betExpensive.feeOut).toBeGreaterThan(0n);
      expect(betExpensive.feeOut).toBeLessThan(betExpensive.feeIn);
      expect(betCheap.feeOut).toBeGreaterThan(betCheap.feeIn);

      // Mutual consistency with amountOut for both skewed directions
      const expCheck = (Number(betExpensive.swapOut) * 100) / (10_000 - 100);
      const cheapCheck = (Number(betCheap.swapOut) * 100) / (10_000 - 100);
      expect(Math.abs(Number(betExpensive.feeOut) - expCheck)).toBeLessThanOrEqual(2);
      expect(Math.abs(Number(betCheap.feeOut) - cheapCheck)).toBeLessThanOrEqual(2);

      // Zero inputs yield zero feeOut
      expect(quoteSwapDetail(0n, balNo, 5_000_000n, lEff, 100)).toEqual({
        amountOut: 0n,
        feeIn: 0n,
        feeOut: 0n,
      });
    });
  });
});
