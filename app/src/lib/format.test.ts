import { describe, it, expect } from "vitest";
import {
  encodePrediction,
  decodePrediction,
  utf8Len,
  randomMarketId,
  marketIdHex,
  parseEnumKey,
  parseStatus,
  parseSide,
  sideToChain,
  shorten,
  toUi,
  fromUi,
  formatCents,
  formatStamp,
  countdown,
  explorerTx,
  explorerAccount,
  bytesFromHex,
} from "@/lib/format";

describe("format", () => {
  describe("encodePrediction / decodePrediction", () => {
    it("round-trips ascii", () => {
      const bytes = encodePrediction("hello");
      expect(bytes.length).toBe(64);
      expect(decodePrediction(bytes)).toBe("hello");
    });
    it("round-trips utf8", () => {
      const bytes = encodePrediction("BTC/USD >= 60000 @ 2026-01-01");
      expect(decodePrediction(bytes)).toBe("BTC/USD >= 60000 @ 2026-01-01");
    });
    it("truncates to 64 bytes", () => {
      const long = "x".repeat(100);
      const bytes = encodePrediction(long);
      expect(decodePrediction(bytes).length).toBeLessThanOrEqual(64);
    });
    it("handles zero-padded tail gracefully", () => {
      const buf = new Uint8Array(64);
      Buffer.from("abc").copy(buf, 0);
      expect(decodePrediction(buf)).toBe("abc");
    });
    it("handles full 64-byte string without null terminator", () => {
      const full = "x".repeat(64);
      const bytes = encodePrediction(full);
      expect(decodePrediction(bytes)).toBe(full);
    });
  });

  describe("utf8Len", () => {
    it("counts bytes not chars", () => {
      expect(utf8Len("abc")).toBe(3);
      expect(utf8Len("中")).toBe(3);
      expect(utf8Len("🀄")).toBe(4);
    });
  });

  describe("randomMarketId / marketIdHex", () => {
    it("produces 16 random bytes each call", () => {
      const a = randomMarketId();
      const b = randomMarketId();
      expect(a.length).toBe(16);
      expect(b.length).toBe(16);
      expect(a).not.toEqual(b);
    });
    it("round-trips via hex", () => {
      const id = randomMarketId();
      const hex = marketIdHex(id);
      expect(hex).toMatch(/^[0-9a-f]{32}$/);
      expect(bytesFromHex(hex)).toEqual(id);
    });
  });

  describe("parseEnumKey", () => {
    it("passes string through", () => {
      expect(parseEnumKey<"open">("open")).toBe("open");
    });
    it("extracts variant key from object", () => {
      expect(parseEnumKey<"resolved">({ resolved: {} })).toBe("resolved");
    });
    it("throws on null/undefined", () => {
      expect(() => parseEnumKey(null)).toThrow();
      expect(() => parseEnumKey(undefined)).toThrow();
      expect(() => parseEnumKey(123)).toThrow();
    });
  });

  describe("parseStatus / parseSide", () => {
    it("parseStatus extracts keys correctly", () => {
      expect(parseStatus("open")).toBe("open");
      expect(parseStatus({ resolved: {} })).toBe("resolved");
    });
    it("parseSide extracts keys correctly", () => {
      expect(parseSide("yes")).toBe("yes");
      expect(parseSide({ no: {} })).toBe("no");
    });
  });

  describe("sideToChain", () => {
    it("converts yes/no to Anchor-style variants", () => {
      expect(sideToChain("yes")).toEqual({ yes: {} });
      expect(sideToChain("no")).toEqual({ no: {} });
    });
  });

  describe("shorten", () => {
    it("shortens mid-length strings", () => {
      expect(shorten("abcdefghij", 3, 3)).toBe("abc…hij");
    });
    it("returns original when too short", () => {
      expect(shorten("hello", 5, 5)).toBe("hello");
    });
    it("uses 4/4 default", () => {
      expect(shorten("0123456789abcdef")).toBe("0123…cdef");
    });
  });

  describe("toUi / fromUi", () => {
    it("converts between UI and chain units", () => {
      expect(toUi(1_000_000n, 6)).toBe("1");
      expect(toUi(1_234_567n, 6)).toBe("1.2345");
    });
    it("handles zero", () => {
      expect(toUi(0n, 6)).toBe("0");
    });
    it("handles negatives", () => {
      expect(toUi(-1_500_000n, 6)).toBe("-1.5");
    });
    it("默认 4 位小数会截断（这是展示精度契约，不是无损往返）", () => {
      expect(toUi(1_234_567n, 6)).toBe("1.2345");
      expect(toUi(123_456_789n, 9)).toBe("0.1234");
      expect(toUi(1_234_567n, 6, 2)).toBe("1.23");
    });
    it("往返无损的前提是显式给出足够位数", () => {
      for (const [raw, dec] of [
        ["0", 6],
        ["1000000", 6],
        ["999999", 6],
        ["999", 6],
        ["5000000000", 9],
      ] as const) {
        const ui = toUi(BigInt(raw), dec, dec); // 输出足够小数位
        expect(fromUi(ui, dec)).toBe(BigInt(raw));
      }
    });
    it("fromUi rejects malformed strings", () => {
      expect(() => fromUi("abc", 6)).toThrow();
      expect(() => fromUi("-1", 6)).toThrow();
      expect(() => fromUi("1.2.3", 6)).toThrow();
    });
    it("fromUi handles empty/whitespace as zero", () => {
      expect(fromUi("", 6)).toBe(0n);
      expect(fromUi("   ", 6)).toBe(0n);
    });
    it("clips fractional digits", () => {
      expect(toUi(1_234_567n, 6, 2)).toBe("1.23");
    });
  });

  describe("formatCents", () => {
    it("formats cents", () => {
      expect(formatCents(0.25)).toBe("25.0¢");
      expect(formatCents(0.5)).toBe("50.0¢");
    });
    it("replaces non-finite values", () => {
      expect(formatCents(NaN)).toBe("—");
      expect(formatCents(Infinity)).toBe("—");
    });
  });

  describe("formatStamp / formatUnix", () => {
    it("formats a unix timestamp (seconds)", () => {
      // 2026-01-01 00:00:00 UTC-ish (epoch seconds, local TZ)
      const s = 1767225600;
      const out = formatStamp(s);
      expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });
    it("uses Date directly", () => {
      const d = new Date(2026, 0, 15, 10, 5);
      const out = formatStamp(d);
      expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });
    it("returns — for zero/NaN", () => {
      expect(formatStamp(0)).toBe("—");
      expect(formatStamp(NaN)).toBe("—");
    });
  });

  describe("countdown", () => {
    it("shows days + clock when > 24h remaining", () => {
      const now = 1_000_000;
      const out = countdown(now + 3 * 86400 + 3661, now);
      expect(out).toContain("3");
      expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
    it("shows clock only when < 24h", () => {
      const now = 1_000_000;
      const out = countdown(now + 3661, now);
      expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });
    it("returns ended when in the past", () => {
      const now = 1_000_000;
      expect(countdown(now - 1, now)).toBe("Ended");
      expect(countdown(now, now)).toBe("Ended"); // 恰好到期也算结束
    });
    it("clamps negative delta to zero (past 与恰好到期输出一致)", () => {
      const now = 1_000_000;
      expect(countdown(now - 9999, now)).toBe(countdown(now, now));
    });
    it("24 小时边界：多 1 秒显示天数，少 1 秒只显示时钟", () => {
      const now = 1_000_000;
      expect(countdown(now + 86400, now)).toBe("1d 00:00:00");
      expect(countdown(now + 86399, now)).toBe("23:59:59");
      expect(countdown(now + 1, now)).toBe("00:00:01");
    });
  });

  describe("explorers", () => {
    it("returns null on localnet", () => {
      expect(explorerTx("sig", "localnet")).toBeNull();
      expect(explorerAccount("addr", "localnet")).toBeNull();
    });
    it("mainnet-beta has no cluster param", () => {
      expect(explorerTx("abc", "mainnet-beta")).toBe("https://solscan.io/tx/abc");
      expect(explorerAccount("xyz", "mainnet-beta")).toBe("https://solscan.io/account/xyz");
    });
    it("devnet/testnet include cluster param", () => {
      expect(explorerTx("abc", "devnet")).toBe("https://solscan.io/tx/abc?cluster=devnet");
      expect(explorerAccount("xyz", "testnet")).toBe("https://solscan.io/account/xyz?cluster=testnet");
    });
  });

  describe("bytesFromHex", () => {
    it("decodes even-length hex", () => {
      expect(bytesFromHex("deadbeef")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });
    it("accepts 0x prefix", () => {
      expect(bytesFromHex("0xDEAD")).toEqual([0xde, 0xad]);
    });
    it("rejects odd-length", () => {
      expect(() => bytesFromHex("abc")).toThrow();
    });
    it("rejects non-hex chars", () => {
      expect(() => bytesFromHex("zzzz")).toThrow();
    });
    it("rejects empty string", () => {
      expect(() => bytesFromHex("")).toThrow();
    });
  });
});
