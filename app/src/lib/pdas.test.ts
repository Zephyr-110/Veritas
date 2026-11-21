// @vitest-environment node
// PDA 推导依赖 web3.js 的 sha256 + 椭圆曲线判断，在 jsdom 环境下
// Buffer polyfill 会导致 findProgramAddressSync 找不到可用 bump，
// 因此这个文件单独用 node 环境跑。
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { findMarketPdas, findLpPosition, findMarketSnapshot } from "@/lib/pdas";
import { PROGRAM_ID_DEFAULT, MARKET_ID_BYTES } from "@/lib/constants";

describe("pdas", () => {
  const pid = new PublicKey(PROGRAM_ID_DEFAULT);
  const marketId = new Uint8Array(MARKET_ID_BYTES).fill(0xab);

  it("produces a well-formed market PDA set", () => {
    const pdas = findMarketPdas(pid, marketId);
    for (const key of [
      pdas.market,
      pdas.snapshot,
      pdas.yesMint,
      pdas.noMint,
      pdas.collateralVault,
      pdas.yesPool,
      pdas.noPool,
    ]) {
      expect(key).toBeInstanceOf(PublicKey);
      expect(key.equals(PublicKey.default)).toBe(false);
    }
    expect(pdas.marketBump).toBeGreaterThanOrEqual(0);
    expect(pdas.marketBump).toBeLessThanOrEqual(255);
  });

  it("is deterministic for the same inputs", () => {
    const a = findMarketPdas(pid, marketId);
    const b = findMarketPdas(pid, marketId);
    expect(a.market.equals(b.market)).toBe(true);
    expect(a.marketBump).toBe(b.marketBump);
    expect(a.snapshot.equals(b.snapshot)).toBe(true);
  });

  it("varies with market id", () => {
    const a = findMarketPdas(pid, new Uint8Array(MARKET_ID_BYTES).fill(1));
    const b = findMarketPdas(pid, new Uint8Array(MARKET_ID_BYTES).fill(2));
    expect(a.market.equals(b.market)).toBe(false);
  });

  it("each derived account is distinct", () => {
    const p = findMarketPdas(pid, marketId);
    const all = [p.market, p.snapshot, p.yesMint, p.noMint, p.collateralVault, p.yesPool, p.noPool];
    const unique = new Set(all.map((k) => k.toBase58()));
    expect(unique.size).toBe(all.length);
  });

  it("findLpPosition is deterministic and owner-sensitive", () => {
    const market = findMarketPdas(pid, marketId).market;
    const ownerA = new PublicKey(Buffer.alloc(32, 0x11));
    const ownerB = new PublicKey(Buffer.alloc(32, 0x22));
    const [a1, bump1] = findLpPosition(pid, market, ownerA);
    const [a2] = findLpPosition(pid, market, ownerA);
    const [b] = findLpPosition(pid, market, ownerB);
    expect(a1.equals(a2)).toBe(true);
    expect(bump1).toBeGreaterThanOrEqual(0);
    expect(a1.equals(b)).toBe(false);
  });

  it("findMarketSnapshot agrees with findMarketPdas.snapshot", () => {
    const pdas = findMarketPdas(pid, marketId);
    const [snap, bump] = findMarketSnapshot(pid, pdas.market);
    expect(snap.equals(pdas.snapshot)).toBe(true);
    expect(bump).toBeGreaterThanOrEqual(0);
  });
});
