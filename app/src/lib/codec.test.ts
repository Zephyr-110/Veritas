import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import {
  decodeMarket,
  decodeLpPosition,
  decodeMarketSnapshot,
  i80f48ToNumber,
  i80f48ToAmount,
  computePending,
  snapshotMatches,
} from "@/lib/codec";
import {
  MARKET_ACCOUNT_SIZE,
  MARKET_DISCRIMINATOR,
  LP_POSITION_DISCRIMINATOR,
  MARKET_SNAPSHOT_DISCRIMINATOR,
} from "@/lib/constants";

describe("codec helpers", () => {
  describe("i80f48 conversions", () => {
    const SCALE = 2n ** 48n;

    it("i80f48ToNumber divides by 2^48", () => {
      expect(i80f48ToNumber(SCALE)).toBeCloseTo(1, 10);
      expect(i80f48ToNumber(SCALE * 2n)).toBeCloseTo(2, 10);
      expect(i80f48ToNumber(0n)).toBe(0);
      expect(i80f48ToNumber(-SCALE)).toBeCloseTo(-1, 10);
    });

    it("i80f48ToAmount truncates toward zero", () => {
      expect(i80f48ToAmount(SCALE)).toBe(1n);
      expect(i80f48ToAmount(SCALE - 1n)).toBe(0n);
      expect(i80f48ToAmount(-SCALE)).toBe(-1n);
      expect(i80f48ToAmount(-SCALE + 1n)).toBe(0n); // -epsilon -> 0
    });
  });

  describe("computePending", () => {
    it("returns zero when shares <= 0", () => {
      expect(computePending(0n, 0n, 0n, 100n, 100n)).toEqual({ yes: 0n, no: 0n });
      expect(computePending(-1n, 0n, 0n, 100n, 100n)).toEqual({ yes: 0n, no: 0n });
    });
    it("computes pending increases correctly", () => {
      // sharesBits = 1 * SCALE (one share)
      const SCALE = 2n ** 48n;
      const shares = SCALE;
      const checkpointYes = 0n;
      const checkpointNo = 0n;
      const cumYes = SCALE * 3n; // +3 per share
      const cumNo = SCALE * 5n;  // +5 per share
      const out = computePending(shares, checkpointYes, checkpointNo, cumYes, cumNo);
      expect(out.yes).toBe(3n);
      expect(out.no).toBe(5n);
    });
    it("ignores decreases in cumulative (clamped to 0)", () => {
      const SCALE = 2n ** 48n;
      const shares = SCALE;
      const out = computePending(shares, SCALE * 3n, SCALE * 5n, SCALE * 2n, SCALE * 4n);
      expect(out.yes).toBe(0n);
      expect(out.no).toBe(0n);
    });
  });

  describe("snapshotMatches", () => {
    it("returns true when consecutive entries match pre/post with counter+1", () => {
      const snap = {
        entries: [
          { epoch: 1, round: 2, counter: 10, price: 0n, ts: 0n },
          { epoch: 1, round: 3, counter: 11, price: 0n, ts: 0n },
        ],
        bump: 0,
      };
      expect(snapshotMatches(snap, { epoch: 1, round: 2 }, { epoch: 1, round: 3 })).toBe(true);
    });
    it("returns false when counter doesn't increment", () => {
      const snap = {
        entries: [
          { epoch: 1, round: 2, counter: 10, price: 0n, ts: 0n },
          { epoch: 1, round: 3, counter: 99, price: 0n, ts: 0n },
        ],
        bump: 0,
      };
      expect(snapshotMatches(snap, { epoch: 1, round: 2 }, { epoch: 1, round: 3 })).toBe(false);
    });
    it("returns false when pre not found", () => {
      const snap = {
        entries: [{ epoch: 1, round: 3, counter: 11, price: 0n, ts: 0n }],
        bump: 0,
      };
      expect(snapshotMatches(snap, { epoch: 1, round: 2 }, { epoch: 1, round: 3 })).toBe(false);
    });
    it("returns false when post is beyond last entry", () => {
      const snap = {
        entries: [
          { epoch: 1, round: 2, counter: 10, price: 0n, ts: 0n },
        ],
        bump: 0,
      };
      expect(snapshotMatches(snap, { epoch: 1, round: 2 }, { epoch: 1, round: 3 })).toBe(false);
    });
  });
});

describe("float 精度回归（确定性伪随机取样）", () => {
  const SCALE = 2n ** 48n;

  /** mulberry32：固定种子，保证用例可复现，不依赖 Math.random */
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("i80f48ToAmount（bigint 路径）在 2^53 以上依然精确", () => {
    // Number 只能在 2^53 内精确表示整数，bigint 路径不受此限制
    for (const amount of [2n ** 53n, 2n ** 53n + 1n, 2n ** 60n, 10n ** 18n]) {
      expect(i80f48ToAmount(amount * SCALE)).toBe(amount);
    }
  });

  it("i80f48ToNumber 与精确值一致（金额上限 1e15，约 10 亿 USDT@6dp）", () => {
    // 说明：bits = amount * 2^48 远超 2^53，Number 转换理论上会丢精度；
    // 但在实际资金量级内，相对误差落在浮点 ULP 以下，结果仍与精确值相等。
    // 这条用例锁住这个前提——一旦有人改动换算方式导致漂移，会立刻失败。
    const next = rng(0x5eed);
    for (let i = 0; i < 5000; i += 1) {
      const amount = BigInt(Math.floor(next() * 1e15));
      const bits = amount * SCALE;
      expect(i80f48ToAmount(bits)).toBe(amount);
      expect(i80f48ToNumber(bits)).toBe(Number(amount));
    }
  });

  it("computePending 与精确有理数运算逐位一致", () => {
    const next = rng(0xc0de);
    for (let i = 0; i < 5000; i += 1) {
      const sharesBits = BigInt(Math.floor(next() * 1e18)) + SCALE; // >= 1 share
      const checkpointYes = BigInt(Math.floor(next() * 1e16));
      const cumYes = checkpointYes + BigInt(Math.floor(next() * 1e16));
      const checkpointNo = BigInt(Math.floor(next() * 1e16));
      const cumNo = checkpointNo + BigInt(Math.floor(next() * 1e16));

      // 精确值：delta * shares / 2^96，向下取整
      const exactYes = ((cumYes - checkpointYes) * sharesBits) / (SCALE * SCALE);
      const exactNo = ((cumNo - checkpointNo) * sharesBits) / (SCALE * SCALE);

      const got = computePending(sharesBits, checkpointYes, checkpointNo, cumYes, cumNo);
      expect(got.yes).toBe(exactYes);
      expect(got.no).toBe(exactNo);
    }
  });
});

describe("buffer decoders", () => {
  it("decodeLpPosition decodes correctly", () => {
    const buf = Buffer.alloc(8 + 32 + 16 + 16 + 16 + 1);
    // discriminator
    buf.set(LP_POSITION_DISCRIMINATOR as unknown as number[], 0);
    // owner = default PubKey
    new PublicKey(Buffer.alloc(32)).toBuffer().copy(buf, 8);
    // shares i128 = 1
    buf.writeBigUInt64LE(1n, 40);
    buf.writeBigInt64LE(0n, 48);
    // checkpoints both 0
    buf.writeBigUInt64LE(0n, 56);
    buf.writeBigInt64LE(0n, 64);
    buf.writeBigUInt64LE(0n, 72);
    buf.writeBigInt64LE(0n, 80);
    // bump = 255
    buf.writeUInt8(255, 88);

    const decoded = decodeLpPosition(buf);
    expect(decoded.owner).toEqual(PublicKey.default);
    expect(decoded.shares).toBe(1n);
    expect(decoded.bump).toBe(255);
  });

  it("decodeLpPosition throws on bad discriminator", () => {
    const bad = Buffer.alloc(8 + 32 + 16 + 16 + 16 + 1);
    expect(() => decodeLpPosition(bad)).toThrow();
  });

  it("decodeMarketSnapshot parses variable entries", () => {
    const entrySize = 4 + 1 + 4 + 16 + 8; // epoch + round + counter + i128 + i64
    const headerSize = 8 + 4; // disc + len
    const total = headerSize + 2 * entrySize + 1; // +bump
    const buf = Buffer.alloc(total);
    buf.set(MARKET_SNAPSHOT_DISCRIMINATOR as unknown as number[], 0);
    buf.writeUInt32LE(2, 8);
    for (let i = 0; i < 2; i += 1) {
      const off = headerSize + i * entrySize;
      buf.writeUInt32LE(100 + i, off);       // epoch
      buf.writeUInt8(i + 1, off + 4);        // round
      buf.writeUInt32LE(10 + i, off + 5);    // counter
      // i128 price = i
      buf.writeBigUInt64LE(BigInt(i), off + 9);
      buf.writeBigInt64LE(0n, off + 17);
      // i64 ts = i
      buf.writeBigUInt64LE(BigInt(i), off + 25);
    }
    buf.writeUInt8(1, total - 1); // bump
    const snap = decodeMarketSnapshot(buf);
    expect(snap.entries.length).toBe(2);
    expect(snap.entries[0].epoch).toBe(100);
    expect(snap.entries[0].round).toBe(1);
    expect(snap.bump).toBe(1);
  });

  it("decodeMarketSnapshot throws when len > 16", () => {
    const entrySize = 4 + 1 + 4 + 16 + 8;
    const buf = Buffer.alloc(8 + 4 + 16 * entrySize + 1);
    buf.set(MARKET_SNAPSHOT_DISCRIMINATOR as unknown as number[], 0);
    buf.writeUInt32LE(17, 8);
    expect(() => decodeMarketSnapshot(buf)).toThrow();
  });

  it("decodeMarket rejects wrong size / wrong disc", () => {
    // wrong size
    const short = Buffer.alloc(100);
    short.set(MARKET_DISCRIMINATOR as unknown as number[], 0);
    expect(() => decodeMarket(short)).toThrow();

    // correct size but zero disc
    const bad = Buffer.alloc(MARKET_ACCOUNT_SIZE);
    expect(() => decodeMarket(bad)).toThrow();
  });
});

describe("decodeMarket 字段与枚举边界", () => {
  // 与 codec.ts 的 Cursor 读取顺序一一对应
  const STATUS_OFFSET = 129;
  const WINNER_TAG_OFFSET = 162;
  const WINNER_SIDE_OFFSET = 163;
  const DECIMALS_OFFSET = 390;

  function marketBuffer(mutate?: (buf: Buffer) => void): Buffer {
    const buf = Buffer.alloc(MARKET_ACCOUNT_SIZE);
    buf.set(MARKET_DISCRIMINATOR as unknown as number[], 0);
    buf.writeUInt8(8, DECIMALS_OFFSET); // 默认合法的 priceDecimals
    mutate?.(buf);
    return buf;
  }

  it("全零字段是合法的 open 市场（winner None）", () => {
    const m = decodeMarket(marketBuffer());
    expect(m.status).toBe("open");
    expect(m.winner).toBeNull();
    expect(m.priceDecimals).toBe(8);
    expect(m.expiry).toBe(0n);
  });

  it("priceDecimals != 8 必须拒绝（不支持的非 8 位小数）", () => {
    expect(() => decodeMarket(marketBuffer((b) => b.writeUInt8(6, DECIMALS_OFFSET)))).toThrow(
      "errors.unsupportedDecimals"
    );
    expect(() => decodeMarket(marketBuffer((b) => b.writeUInt8(0, DECIMALS_OFFSET)))).toThrow(
      "errors.unsupportedDecimals"
    );
  });

  it("status 0/1/2/3 映射正确，未知值拒绝", () => {
    expect(decodeMarket(marketBuffer((b) => b.writeUInt8(1, STATUS_OFFSET))).status).toBe("resolved");
    expect(decodeMarket(marketBuffer((b) => b.writeUInt8(2, STATUS_OFFSET))).status).toBe("windowBurn");
    expect(decodeMarket(marketBuffer((b) => b.writeUInt8(3, STATUS_OFFSET))).status).toBe("staleBurn");
    expect(() => decodeMarket(marketBuffer((b) => b.writeUInt8(4, STATUS_OFFSET)))).toThrow(
      "errors.decode"
    );
  });

  it("winner Some(yes/no) 正确，未知 tag / side 拒绝", () => {
    const withWinner = (tag: number, side: number) =>
      decodeMarket(
        marketBuffer((b) => {
          b.writeUInt8(tag, WINNER_TAG_OFFSET);
          if (tag === 1) {
            b.writeUInt8(side, WINNER_SIDE_OFFSET);
            // Borsh 的 Option<MarketOutcome> 变长：Some 比 None 多 1 字节，
            // 其后的所有字段整体后移。
            b.writeUInt8(8, DECIMALS_OFFSET + 1);
          }
        })
      );

    expect(withWinner(1, 0).winner).toBe("yes");
    expect(withWinner(1, 1).winner).toBe("no");
    expect(() => withWinner(1, 9)).toThrow("errors.decode");
    expect(() => withWinner(2, 0)).toThrow("errors.decode");
  });

  it("winner 为 Some 时后续字段整体后移 1 字节（防止按固定偏移改写）", () => {
    const buf = marketBuffer((b) => {
      b.writeUInt8(1, WINNER_TAG_OFFSET);
      b.writeUInt8(0, WINNER_SIDE_OFFSET);
      b.writeUInt8(8, DECIMALS_OFFSET + 1); // 真实位置
      b.writeUInt8(6, DECIMALS_OFFSET); // 固定偏移处的诱饵，读错就会抛错
    });

    const m = decodeMarket(buf);
    expect(m.winner).toBe("yes");
    expect(m.priceDecimals).toBe(8);
  });
});
