// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { Buffer } from "buffer";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { PredictionMarket } from "@/idl/prediction_market";
import {
  claimableOf,
  isVoidedStatus,
  isFinalizedStatus,
  pendingValueOf,
  marketPhase,
  fetchMarkets,
  fetchMarket,
  fetchMarketSnapshot,
  fetchPosition,
  fetchPositionsBatch,
} from "@/lib/markets";
import {
  CLAIM_WINDOW,
  LP_POSITION_DISCRIMINATOR,
  MARKET_ACCOUNT_SIZE,
  MARKET_DISCRIMINATOR,
  MARKET_SNAPSHOT_DISCRIMINATOR,
  PROGRAM_ID_DEFAULT,
  RESOLVE_WINDOW,
  SNAPSHOT_WINDOW,
} from "@/lib/constants";
import { FEEDS } from "@/lib/feeds";
import { findLpPosition, findMarketPdas } from "@/lib/pdas";
import {
  ataOf,
  fetchMintMeta,
  getMultiple,
  tokenProgramOf,
  unpackAmount,
  unpackDecimals,
} from "@/lib/tokens";

describe("markets", () => {
  describe("isVoidedStatus / isFinalizedStatus", () => {
    it("recognizes voids", () => {
      expect(isVoidedStatus("windowBurn")).toBe(true);
      expect(isVoidedStatus("staleBurn")).toBe(true);
      expect(isVoidedStatus("open")).toBe(false);
      expect(isVoidedStatus("resolved")).toBe(false);
    });
    it("resolved + voids are finalized", () => {
      expect(isFinalizedStatus("open")).toBe(false);
      expect(isFinalizedStatus("resolved")).toBe(true);
      expect(isFinalizedStatus("windowBurn")).toBe(true);
      expect(isFinalizedStatus("staleBurn")).toBe(true);
    });
  });

  describe("marketPhase", () => {
    it("live when open and not expired", () => {
      const now = 1000;
      const p = marketPhase({ status: "open", expiry: 2000 }, now);
      expect(p.live).toBe(true);
      expect(p.expired).toBe(false);
      expect(p.inWindow).toBe(false);
      expect(p.afterWindow).toBe(false);
    });

    it("expired and in resolve window", () => {
      const now = 1000;
      const p = marketPhase({ status: "open", expiry: 500 }, now);
      expect(p.live).toBe(false);
      expect(p.expired).toBe(true);
      expect(p.inWindow).toBe(true);
      expect(p.afterWindow).toBe(false);
    });

    it("after resolve window", () => {
      const now = 1000;
      const p = marketPhase({ status: "open", expiry: 1000 - RESOLVE_WINDOW - 1 }, now);
      expect(p.afterWindow).toBe(true);
      expect(p.inWindow).toBe(false);
    });

    it("snapshot window near endTs (falls back to expiry)", () => {
      const now = 1000;
      // endTs defaults to expiry
      const p = marketPhase({ status: "open", expiry: now + 3 }, now);
      expect(p.inSnapshotWindow).toBe(true);
    });

    it("canBurn after claim window from finishTs", () => {
      // use timestamps large enough that finishTs stays positive
      const now = 10_000_000;
      const finishTs = now - CLAIM_WINDOW - 100;
      const p = marketPhase(
        { status: "resolved", expiry: 100, finishTs },
        now
      );
      expect(p.canBurn).toBe(true);
    });

    it("cannotBurn when not finalized", () => {
      const now = 1_000_000;
      const finishTs = now - CLAIM_WINDOW - 1;
      const p = marketPhase({ status: "open", expiry: 100, finishTs }, now);
      expect(p.canBurn).toBe(false);
    });

    it("cannotBurn before finishTs > 0", () => {
      const now = 1_000_000;
      const p = marketPhase({ status: "resolved", expiry: 100, finishTs: 0 }, now);
      expect(p.canBurn).toBe(false);
    });

    // ---- 边界：合约与前端都按闭区间/开区间的严格语义，差一秒必须翻转 ----
    it("expiry 当秒即过期，resolve 窗口最后一秒仍算窗口内", () => {
      const now = 10_000;
      expect(marketPhase({ status: "open", expiry: now }, now).expired).toBe(true);
      expect(marketPhase({ status: "open", expiry: now }, now).live).toBe(false);

      const lastSecond = marketPhase({ status: "open", expiry: now - RESOLVE_WINDOW }, now);
      expect(lastSecond.inWindow).toBe(true);
      expect(lastSecond.afterWindow).toBe(false);

      const firstOut = marketPhase({ status: "open", expiry: now - RESOLVE_WINDOW - 1 }, now);
      expect(firstOut.inWindow).toBe(false);
      expect(firstOut.afterWindow).toBe(true);
    });

    it("快照窗口是开区间，并以 endTs 为准而不是 expiry", () => {
      const now = 5_000;
      const endTs = 5_000;
      const at = (t: number) =>
        marketPhase({ status: "open", expiry: 9_999, endTs }, t).inSnapshotWindow;

      expect(at(endTs - SNAPSHOT_WINDOW - 1)).toBe(false);
      expect(at(endTs - SNAPSHOT_WINDOW)).toBe(false); // 严格大于
      expect(at(endTs - SNAPSHOT_WINDOW + 1)).toBe(true);
      expect(at(endTs + SNAPSHOT_WINDOW - 1)).toBe(true);
      expect(at(endTs + SNAPSHOT_WINDOW)).toBe(false); // 严格小于
      expect(at(endTs + SNAPSHOT_WINDOW + 1)).toBe(false);
      // expiry 仍在 9_999，若误用 expiry 判断，上面 endTs 附近的断言都会失败
      expect(marketPhase({ status: "open", expiry: 9_999, endTs }, now).inSnapshotWindow).toBe(true);
    });

    it("canBurn 必须严格晚于 finishTs + CLAIM_WINDOW", () => {
      const finishTs = 100;
      const base = { status: "resolved" as const, expiry: 1, finishTs };
      expect(marketPhase(base, finishTs + CLAIM_WINDOW).canBurn).toBe(false);
      expect(marketPhase(base, finishTs + CLAIM_WINDOW + 1).canBurn).toBe(true);
    });

    it("作废状态同样在领取窗口后 canBurn", () => {
      const now = 10_000_000;
      for (const status of ["windowBurn", "staleBurn"] as const) {
        const p = marketPhase(
          { status, expiry: 100, finishTs: now - CLAIM_WINDOW - 1 },
          now
        );
        expect(p.canBurn).toBe(true);
      }
    });
  });
});

function makeTokenAccountInfo(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
  tokenProgram = TOKEN_PROGRAM_ID
): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data
  );
  return {
    data,
    executable: false,
    lamports: 1_000_000,
    owner: tokenProgram,
    rentEpoch: 0,
  };
}

function makeMintInfo(
  decimals: number,
  tokenProgram = TOKEN_PROGRAM_ID
): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data
  );
  return {
    data,
    executable: false,
    lamports: 1_000_000,
    owner: tokenProgram,
    rentEpoch: 0,
  };
}

function encodeMarketAccount(opts: {
  id: number[];
  expiry: bigint;
  collateralMint: PublicKey;
  ocr2State: PublicKey;
  reserveYes?: bigint;
  reserveNo?: bigint;
  totalLpShares?: bigint;
  cumYesPerShare?: bigint;
  cumNoPerShare?: bigint;
  title?: string;
}): Buffer {
  const SCALE = 2n ** 48n;
  const buf = Buffer.alloc(MARKET_ACCOUNT_SIZE);
  buf.set(MARKET_DISCRIMINATOR as unknown as number[], 0);
  buf.writeBigUInt64LE(opts.expiry, 8);
  buf.set(opts.id, 48);
  opts.collateralMint.toBuffer().copy(buf, 130);
  const titleBytes = Buffer.from(opts.title ?? "BTC/USD >= 60,000 @ 2030");
  titleBytes.copy(buf, 164, 0, Math.min(64, titleBytes.length));

  const writeI128 = (val: bigint, off: number) => {
    buf.writeBigUInt64LE(BigInt.asUintN(64, val), off);
    buf.writeBigInt64LE(val >> 64n, off + 8);
  };
  writeI128((opts.cumYesPerShare ?? 0n), 260);
  writeI128((opts.cumNoPerShare ?? 0n), 276);
  buf.writeUInt16LE(30, 292);
  writeI128((opts.reserveYes ?? 50n) * SCALE, 294);
  writeI128((opts.reserveNo ?? 50n) * SCALE, 310);
  writeI128((opts.totalLpShares ?? 100n) * SCALE, 326);
  buf.writeBigInt64LE(opts.expiry, 342);
  opts.ocr2State.toBuffer().copy(buf, 350);
  buf.writeBigInt64LE(60_000n * 10n ** 8n, 382);
  buf.writeUInt8(8, 390);
  buf.writeUInt8(1, 391);
  return buf;
}

describe("tokens", () => {
  const MINT = new PublicKey(Buffer.alloc(32, 3));
  const OWNER = new PublicKey(Buffer.alloc(32, 4));
  const ADDR = ataOf(MINT, OWNER, TOKEN_PROGRAM_ID);

  it("tokenProgramOf 区分 Token-2022 与 SPL Token", () => {
    expect(tokenProgramOf(TOKEN_2022_PROGRAM_ID).equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(tokenProgramOf(TOKEN_PROGRAM_ID).equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(tokenProgramOf(PublicKey.default).equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("unpackAmount 与 unpackDecimals 正确解包并在损坏/空账户时安全回退", () => {
    const tokenInfo = makeTokenAccountInfo(MINT, OWNER, 12_345n, TOKEN_2022_PROGRAM_ID);
    expect(unpackAmount(ADDR, tokenInfo, TOKEN_2022_PROGRAM_ID)).toBe(12_345n);
    // owner 不匹配时抛错并回退 0n
    expect(unpackAmount(ADDR, tokenInfo, TOKEN_PROGRAM_ID)).toBe(0n);
    expect(unpackAmount(ADDR, null, TOKEN_PROGRAM_ID)).toBe(0n);

    const mintInfo = makeMintInfo(9, TOKEN_2022_PROGRAM_ID);
    expect(unpackDecimals(MINT, mintInfo, TOKEN_2022_PROGRAM_ID)).toBe(9);
    expect(unpackDecimals(MINT, mintInfo, TOKEN_PROGRAM_ID)).toBe(6);
    expect(unpackDecimals(MINT, null, TOKEN_PROGRAM_ID)).toBe(6);
  });

  it("getMultiple 按每批 100 个分块请求并拼接结果", async () => {
    const keys = Array.from({ length: 105 }, (_, i) => new PublicKey(Buffer.alloc(32, (i % 200) + 1)));
    const getMultipleAccountsInfo = vi.fn(async (chunk: PublicKey[]) =>
      chunk.map(() => null)
    );
    const conn = { getMultipleAccountsInfo } as unknown as Connection;

    const out = await getMultiple(conn, keys);
    expect(out).toHaveLength(105);
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
    expect(getMultipleAccountsInfo.mock.calls[0][0]).toHaveLength(100);
    expect(getMultipleAccountsInfo.mock.calls[1][0]).toHaveLength(5);
  });

  it("fetchMintMeta 返回 tokenProgram 与 decimals，缺失时抛出 errors.mintNotFound", async () => {
    const missingConn = {
      getAccountInfo: vi.fn(async () => null),
    } as unknown as Connection;
    await expect(fetchMintMeta(missingConn, MINT)).rejects.toThrow("errors.mintNotFound");

    const okConn = {
      getAccountInfo: vi.fn(async () => makeMintInfo(8, TOKEN_2022_PROGRAM_ID)),
    } as unknown as Connection;
    const meta = await fetchMintMeta(okConn, MINT);
    expect(meta.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(meta.decimals).toBe(8);
  });
});

describe("markets RPC 聚合", () => {
  const PROGRAM_ID = new PublicKey(PROGRAM_ID_DEFAULT);
  const program = { programId: PROGRAM_ID } as unknown as Program<PredictionMarket>;
  const COLLATERAL_MINT = new PublicKey(Buffer.alloc(32, 20));
  const OCR2_BTC = new PublicKey(FEEDS[0].state);

  it("fetchMarkets 跳过损坏账户、合并池子余额与 decimals 并按 expiry 降序排列", async () => {
    const idOld = Array.from({ length: 16 }, () => 1);
    const idNew = Array.from({ length: 16 }, () => 2);
    const pdaOld = findMarketPdas(PROGRAM_ID, idOld);
    const pdaNew = findMarketPdas(PROGRAM_ID, idNew);

    const rawOld = encodeMarketAccount({
      id: idOld,
      expiry: 1_800_000_000n,
      collateralMint: COLLATERAL_MINT,
      ocr2State: OCR2_BTC,
      reserveYes: 30n,
      reserveNo: 70n,
    });
    rawOld.writeUInt8(1, 129); // Resolved market: its vault is loaded when the row is visible.
    const rawNew = encodeMarketAccount({
      id: idNew,
      expiry: 1_900_000_000n,
      collateralMint: COLLATERAL_MINT,
      ocr2State: OCR2_BTC,
      reserveYes: 80n,
      reserveNo: 20n,
    });

    const accountsByKey = new Map<string, AccountInfo<Buffer>>([
      [pdaOld.yesPool.toBase58(), makeTokenAccountInfo(pdaOld.yesMint, pdaOld.market, 111n, TOKEN_2022_PROGRAM_ID)],
      [pdaOld.noPool.toBase58(), makeTokenAccountInfo(pdaOld.noMint, pdaOld.market, 222n, TOKEN_2022_PROGRAM_ID)],
      [pdaOld.collateralVault.toBase58(), makeTokenAccountInfo(COLLATERAL_MINT, pdaOld.market, 333n, TOKEN_2022_PROGRAM_ID)],
      [pdaNew.yesPool.toBase58(), makeTokenAccountInfo(pdaNew.yesMint, pdaNew.market, 444n, TOKEN_2022_PROGRAM_ID)],
      [pdaNew.noPool.toBase58(), makeTokenAccountInfo(pdaNew.noMint, pdaNew.market, 555n, TOKEN_2022_PROGRAM_ID)],
      [pdaNew.collateralVault.toBase58(), makeTokenAccountInfo(COLLATERAL_MINT, pdaNew.market, 666n, TOKEN_2022_PROGRAM_ID)],
      [COLLATERAL_MINT.toBase58(), makeMintInfo(9, TOKEN_2022_PROGRAM_ID)],
    ]);

    const conn = {
      getProgramAccounts: vi.fn(async () => [
        { pubkey: pdaOld.market, account: { data: rawOld } },
        { pubkey: new PublicKey(Buffer.alloc(32, 99)), account: { data: Buffer.alloc(10) } },
        { pubkey: pdaNew.market, account: { data: rawNew } },
      ]),
      getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) =>
        keys.map((k) => accountsByKey.get(k.toBase58()) ?? null)
      ),
    } as unknown as Connection;

    const list = await fetchMarkets(conn, program);
    expect(conn.getMultipleAccountsInfo).toHaveBeenCalledWith(
      [pdaNew.yesPool, pdaNew.noPool, pdaNew.collateralVault, COLLATERAL_MINT], "confirmed"
    );
    expect(list).toHaveLength(2);
    expect(list[0].expiry).toBe(1_900_000_000);
    expect(list[1].expiry).toBe(1_800_000_000);
    expect(list[0].vault).toBe(666n);
    expect(list[0].decimals).toBe(9);
    expect(list[0].tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(list[0].feedKey).toBe("btc");
    expect(list[0].yesPrice).toBeCloseTo(0.2, 5);
  });

  it("fetchMarkets 空列表时提前返回而不查池子账户", async () => {
    const getMultipleAccountsInfo = vi.fn();
    const conn = {
      getProgramAccounts: vi.fn(async () => []),
      getMultipleAccountsInfo,
    } as unknown as Connection;
    expect(await fetchMarkets(conn, program)).toEqual([]);
    expect(getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it("fetchMarket 缺失市场或缺失抵押品 Mint 时抛错，正常时返回完整 MarketView", async () => {
    const id = Array.from({ length: 16 }, () => 5);
    const pdas = findMarketPdas(PROGRAM_ID, id);
    const raw = encodeMarketAccount({
      id,
      expiry: 1_850_000_000n,
      collateralMint: COLLATERAL_MINT,
      ocr2State: OCR2_BTC,
    });

    const missingMarketConn = {
      getAccountInfo: vi.fn(async () => null),
    } as unknown as Connection;
    await expect(fetchMarket(missingMarketConn, program, pdas.market)).rejects.toThrow(
      "errors.accountMissing"
    );

    const missingMintConn = {
      getAccountInfo: vi.fn(async () => ({ data: raw })),
      getMultipleAccountsInfo: vi.fn(async () => [null, null, null, null]),
    } as unknown as Connection;
    await expect(fetchMarket(missingMintConn, program, pdas.market)).rejects.toThrow(
      "errors.mintNotFound"
    );

    const okConn = {
      getAccountInfo: vi.fn(async () => ({ data: raw })),
      getMultipleAccountsInfo: vi.fn(async () => [
        makeTokenAccountInfo(pdas.yesMint, pdas.market, 10n),
        makeTokenAccountInfo(pdas.noMint, pdas.market, 20n),
        makeTokenAccountInfo(COLLATERAL_MINT, pdas.market, 30n),
        makeMintInfo(6),
      ]),
    } as unknown as Connection;
    const view = await fetchMarket(okConn, program, pdas.market);
    expect(view.yesPool).toBe(10n);
    expect(view.noPool).toBe(20n);
    expect(view.vault).toBe(30n);
    expect(view.decimals).toBe(6);
  });

  it("fetchMarketSnapshot 处理存在、空账户与损坏账户", async () => {
    const snapKey = new PublicKey(Buffer.alloc(32, 33));
    const entrySize = 4 + 1 + 4 + 16 + 8;
    const valid = Buffer.alloc(8 + 4 + entrySize + 1);
    valid.set(MARKET_SNAPSHOT_DISCRIMINATOR as unknown as number[], 0);
    valid.writeUInt32LE(1, 8);
    valid.writeUInt32LE(42, 12);
    valid.writeUInt8(3, 16);
    valid.writeUInt32LE(7, 17);
    valid.writeUInt8(254, valid.length - 1);

    const okConn = {
      getAccountInfo: vi.fn(async () => ({ data: valid })),
    } as unknown as Connection;
    const snap = await fetchMarketSnapshot(okConn, snapKey);
    expect(snap?.entries).toHaveLength(1);
    expect(snap?.entries[0]).toMatchObject({ epoch: 42, round: 3, counter: 7 });

    const nullConn = { getAccountInfo: vi.fn(async () => null) } as unknown as Connection;
    expect(await fetchMarketSnapshot(nullConn, snapKey)).toBeNull();

    const badConn = { getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(16) })) } as unknown as Connection;
    expect(await fetchMarketSnapshot(badConn, snapKey)).toBeNull();
  });

  it("fetchPosition 汇总代币余额、LP 份额与 pending 手续费/释放量", async () => {
    const SCALE = 2n ** 48n;
    const id = Array.from({ length: 16 }, () => 7);
    const pdas = findMarketPdas(PROGRAM_ID, id);
    const owner = new PublicKey(Buffer.alloc(32, 88));
    const [lpPda] = findLpPosition(PROGRAM_ID, pdas.market, owner);

    const market = {
      address: pdas.market,
      pdas,
      collateralMint: COLLATERAL_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      cumYesPerShare: 4n * SCALE,
      cumNoPerShare: 2n * SCALE,
    } as Parameters<typeof fetchPosition>[2];

    const lpBuf = Buffer.alloc(8 + 32 + 16 + 16 + 16 + 1);
    lpBuf.set(LP_POSITION_DISCRIMINATOR as unknown as number[], 0);
    owner.toBuffer().copy(lpBuf, 8);
    const writeI128 = (val: bigint, off: number) => {
      lpBuf.writeBigUInt64LE(BigInt.asUintN(64, val), off);
      lpBuf.writeBigInt64LE(val >> 64n, off + 8);
    };
    writeI128(3n * SCALE, 40); // shares = 3
    writeI128(1n * SCALE, 56); // checkpointYes = 1 -> delta 3 * 3 = 9
    writeI128(0n, 72);         // checkpointNo = 0 -> delta 2 * 3 = 6
    lpBuf.writeUInt8(255, 88);

    const byKey = new Map<string, AccountInfo<Buffer>>([
      [ataOf(COLLATERAL_MINT, owner, TOKEN_PROGRAM_ID).toBase58(), makeTokenAccountInfo(COLLATERAL_MINT, owner, 500n)],
      [ataOf(pdas.yesMint, owner, TOKEN_PROGRAM_ID).toBase58(), makeTokenAccountInfo(pdas.yesMint, owner, 200n)],
      [ataOf(pdas.noMint, owner, TOKEN_PROGRAM_ID).toBase58(), makeTokenAccountInfo(pdas.noMint, owner, 100n)],
      [lpPda.toBase58(), { data: lpBuf, executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0 }],
    ]);

    const conn = {
      getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) =>
        keys.map((k) => byKey.get(k.toBase58()) ?? null)
      ),
    } as unknown as Connection;

    const pos = await fetchPosition(conn, PROGRAM_ID, market, owner);
    expect(pos).toEqual({
      collateral: 500n,
      yes: 200n,
      no: 100n,
      lpShares: 3n,
      pendingYes: 9n,
      pendingNo: 6n,
    });

    const ownerMarket = { ...market, yesMint: pdas.yesMint, noMint: pdas.noMint };
    const getTokenAccountsByOwner = vi.fn().mockResolvedValue({ value: [] });
    const ownerConn = {
      getTokenAccountsByOwner,
      getProgramAccounts: vi.fn().mockResolvedValue([{ pubkey: lpPda, account: byKey.get(lpPda.toBase58()) }]),
    } as unknown as Connection;
    const lpOnly = await fetchPositionsBatch(ownerConn, PROGRAM_ID, [ownerMarket], owner);
    expect(lpOnly[0].position).toEqual({ ...pos, collateral: 0n, yes: 0n, no: 0n });
    expect(getTokenAccountsByOwner).toHaveBeenCalledWith(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed");
    getTokenAccountsByOwner.mockResolvedValue({ value: [1, 2].map((i) => ({
      pubkey: new PublicKey(Buffer.alloc(32, i)),
      account: makeTokenAccountInfo(pdas.yesMint, owner, BigInt(i)),
    })) });
    const withTokens = await fetchPositionsBatch(ownerConn, PROGRAM_ID, [ownerMarket], owner);
    expect(withTokens[0].position.yes).toBe(3n);

    // LP 账户损坏时安全回退为 0n
    const badLpConn = {
      getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) =>
        keys.map((k) =>
          k.equals(lpPda)
            ? { data: Buffer.alloc(10), executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0 }
            : byKey.get(k.toBase58()) ?? null
        )
      ),
    } as unknown as Connection;
    const fallbackPos = await fetchPosition(badLpConn, PROGRAM_ID, market, owner);
    expect(fallbackPos.lpShares).toBe(0n);
    expect(fallbackPos.pendingYes).toBe(0n);
  });
});

describe("pendingValueOf", () => {
  const pending = { pendingYes: 48_060_000n, pendingNo: 52_000_000n };

  it("未终局市场按两边待领合计展示", () => {
    expect(pendingValueOf({ status: "open", winner: null }, pending)).toBe(100_060_000n);
  });

  it("已裁决市场只计入赢家边待领金额", () => {
    expect(pendingValueOf({ status: "resolved", winner: "yes" }, pending)).toBe(48_060_000n);
    expect(pendingValueOf({ status: "resolved", winner: "no" }, pending)).toBe(52_000_000n);
    expect(pendingValueOf({ status: "resolved", winner: null }, pending)).toBe(0n);
  });

  it("作废市场按两边各值一半（0.5 退回）计价，双奇数余额逐边向下取整", () => {
    expect(pendingValueOf({ status: "windowBurn", winner: null }, pending)).toBe(50_030_000n);
    expect(pendingValueOf({ status: "staleBurn", winner: null }, pending)).toBe(50_030_000n);
    expect(pendingValueOf({ status: "staleBurn", winner: null }, { pendingYes: 3n, pendingNo: 3n })).toBe(2n);
  });
});

describe("claimableOf", () => {
  it("按链上 get_collateral 口径计算胜方与作废逐边减半可领额", () => {
    expect(claimableOf({ status: "open", winner: null }, { yes: 10n, no: 10n })).toBe(0n);
    expect(claimableOf({ status: "resolved", winner: "yes" }, { yes: 7n, no: 9n })).toBe(7n);
    expect(claimableOf({ status: "resolved", winner: "no" }, { yes: 7n, no: 9n })).toBe(9n);
    expect(claimableOf({ status: "resolved", winner: null }, { yes: 7n, no: 9n })).toBe(0n);
    // Double-odd void balances: floor(3/2) + floor(3/2) = 2, NOT floor((3+3)/2) = 3
    expect(claimableOf({ status: "staleBurn", winner: null }, { yes: 3n, no: 3n })).toBe(2n);
    expect(claimableOf({ status: "windowBurn", winner: null }, { yes: 1n, no: 1n })).toBe(0n);
    expect(claimableOf({ status: "windowBurn", winner: null }, { yes: 5n, no: 2n })).toBe(3n);
  });
});
