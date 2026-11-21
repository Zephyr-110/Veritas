import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  feedByKey,
  feedByState,
  humanToThreshold,
  thresholdToHuman,
  formatFeedPrice,
  FEEDS,
} from "@/lib/feeds";

describe("feeds", () => {
  describe("feedByKey", () => {
    it("returns a preset for every declared key", () => {
      for (const key of ["btc", "eth", "sol", "link", "usdc", "usdt"] as const) {
        const p = feedByKey(key);
        expect(p.key).toBe(key);
        expect(p.decimals).toBe(8);
      }
    });
    it("throws on unknown key", () => {
      expect(() => feedByKey("xxx" as never)).toThrow();
    });
  });

  describe("feedByState", () => {
    it("finds by PublicKey", () => {
      const preset = FEEDS[0];
      const pk = new PublicKey(preset.state);
      expect(feedByState(pk)?.key).toBe(preset.key);
    });
    it("finds by base58 string", () => {
      const preset = FEEDS[1];
      expect(feedByState(preset.state)?.key).toBe(preset.key);
    });
    it("returns null for unknown state", () => {
      expect(feedByState(PublicKey.default)).toBeNull();
      expect(feedByState("aaaaa")).toBeNull();
    });
  });

  describe("humanToThreshold", () => {
    it("scales human to on-chain bigint", () => {
      expect(humanToThreshold("60000", 8)).toBe(60000n * 10n ** 8n);
      expect(humanToThreshold("1.5", 8)).toBe(150000000n);
    });
    it("defaults decimals to 8", () => {
      expect(humanToThreshold("100")).toBe(100n * 10n ** 8n);
    });
    it("rejects negative or garbage", () => {
      expect(() => humanToThreshold("-1")).toThrow();
      expect(() => humanToThreshold("abc")).toThrow();
      expect(() => humanToThreshold("1.2.3")).toThrow();
    });
  });

  describe("thresholdToHuman", () => {
    it("human → threshold → human 显示为等价的带千分位数值", () => {
      expect(thresholdToHuman(humanToThreshold("60000"))).toBe("60,000");
      expect(thresholdToHuman(humanToThreshold("1.5"))).toBe("1.5");
      expect(thresholdToHuman(humanToThreshold("0.5"))).toBe("0.5");
      expect(thresholdToHuman(humanToThreshold("100.25"))).toBe("100.25");
    });
    it("uses locale thousands separator", () => {
      expect(thresholdToHuman(60000n * 10n ** 8n)).toContain("60,000");
    });
  });

  describe("formatFeedPrice", () => {
    it("returns — for null / non-finite", () => {
      expect(formatFeedPrice(null)).toBe("—");
      expect(formatFeedPrice(NaN)).toBe("—");
      expect(formatFeedPrice(Infinity)).toBe("—");
    });
    it("formats prices with sensible digits", () => {
      expect(formatFeedPrice(1234.56)).toMatch(/1,234/);
      expect(formatFeedPrice(0.99)).toMatch(/0\.99/);
      expect(formatFeedPrice(0.001234)).toMatch(/0\.001234/);
    });
    it("respects explicit digits", () => {
      expect(formatFeedPrice(1.23456, 2)).toBe("1.23");
      expect(formatFeedPrice(1.2, 6)).toBe("1.200000");
    });
  });
});
