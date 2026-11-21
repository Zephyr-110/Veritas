// @vitest-environment node
// ATA / PDA 推导依赖 web3.js 的 sha256，jsdom 下的 Buffer polyfill 会干扰
// findProgramAddressSync，因此与 pdas.test.ts 一样单独用 node 环境跑。
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { PredictionMarket } from "@/idl/prediction_market";
import {
  ixAddLiquidity,
  ixBurnAccount,
  ixCreateMarket,
  ixGetCollateral,
  ixGetLiquidity,
  ixMergeToken,
  ixResolveMarket,
  ixSwap,
  ixTakeSnapshot,
  ixUserBetOn,
  ixVoidMarket,
} from "@/lib/instructions";
import { findLpPosition, findMarketPdas } from "@/lib/pdas";
import { ataOf, toBn } from "@/lib/tokens";
import type { MarketView } from "@/lib/markets";

const PROGRAM_ID = new PublicKey("CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER");
const USER = new PublicKey(Buffer.alloc(32, 7));
const COLLATERAL_MINT = new PublicKey(Buffer.alloc(32, 4));
const MARKET_ID = Array.from({ length: 16 }, (_, i) => i + 1);

type Call = {
  method: string;
  args: unknown;
  accounts: Record<string, PublicKey | null>;
};

/**
 * 只替身 Anchor Program 的链式构造器，保留 instructions.ts 里全部
 * PDA / ATA / BN 计算。捕获 method 参数与 accountsPartial 的账户映射，
 * 这样断言的是"真正会被签名上链的内容"，而不是 mock 的调用次数。
 */
function makeProgram() {
  const calls: Call[] = [];
  const methods = new Proxy({} as Record<string, (args: unknown) => unknown>, {
    get: (_target, method) => (args: unknown) => ({
      accountsPartial(accounts: Record<string, PublicKey | null>) {
        calls.push({ method: String(method), args, accounts });
        return {
          instruction: async () =>
            new TransactionInstruction({
              programId: PROGRAM_ID,
              keys: [],
              data: Buffer.alloc(0),
            }),
        };
      },
    }),
  });
  return {
    calls,
    program: { programId: PROGRAM_ID, methods } as unknown as Program<PredictionMarket>,
  };
}

function makeMarket(overrides: Partial<MarketView> = {}): MarketView {
  const pdas = findMarketPdas(PROGRAM_ID, MARKET_ID);
  const key = PublicKey.default;
  return {
    address: new PublicKey(Buffer.alloc(32, 3)),
    pdas,
    title: "",
    id: MARKET_ID,
    creator: key,
    collateralMint: COLLATERAL_MINT,
    yesMint: pdas.yesMint,
    noMint: pdas.noMint,
    status: "open",
    winner: null,
    expiry: 2_000_000_000,
    endTs: 2_000_000_000,
    finishTs: 0,
    bump: 255,
    yesPool: 0n,
    noPool: 0n,
    vault: 0n,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    yesPrice: 0.5,
    noPrice: 0.5,
    reserveYes: 0n,
    reserveNo: 0n,
    totalLpShares: 0n,
    ocr2State: key,
    feedKey: null,
    feedSymbol: "",
    priceDecimals: 8,
    threshold: 0n,
    settleAbove: true,
    settledPrice: 0n,
    settledPublishTime: 0,
    feeBps: 30,
    lastAccrualTs: 0,
    cumYesPerShare: 0n,
    cumNoPerShare: 0n,
    ...overrides,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function asBnString(value: unknown): string {
  return (value as { toString(): string }).toString();
}

function assertKey(actual: PublicKey | null | undefined, expected: PublicKey) {
  expect(actual).not.toBeNull();
  expect(actual).not.toBeUndefined();
  expect((actual as PublicKey).equals(expected)).toBe(true);
}

function expectAccountNames(call: Call, expected: string[]) {
  expect(Object.keys(call.accounts).sort()).toEqual([...expected].sort());
}

function expectCuLimit(ix: TransactionInstruction, units: number) {
  expect(ix.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
  expect(ix.data.readUInt8(0)).toBe(2);
  expect(ix.data.readUInt32LE(1)).toBe(units);
}

function expectAtaCreate(
  ix: TransactionInstruction,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey
) {
  expect(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  const ata = ataOf(mint, owner, tokenProgram);
  expect(ix.keys.some((k) => k.pubkey.equals(ata))).toBe(true);
  expect(ix.keys.some((k) => k.pubkey.equals(mint))).toBe(true);
  expect(ix.keys.some((k) => k.pubkey.equals(owner))).toBe(true);
  // 最后一个是 token program，决定 ATA 归属哪个代币程序
  expect(ix.keys[ix.keys.length - 1].pubkey.equals(tokenProgram)).toBe(true);
}

describe("toBn", () => {
  it("超过 2^53 的 bigint 不丢精度", () => {
    const big = 9_007_199_254_740_993n;
    expect(asBnString(toBn(big))).toBe("9007199254740993");
  });

  it("接受 number 与 string", () => {
    expect(asBnString(toBn(1_000_000))).toBe("1000000");
    expect(asBnString(toBn("123456789012345678901"))).toBe("123456789012345678901");
  });
});

describe("ixCreateMarket", () => {
  it("组装全部 PDA/ATA，并把参数按 BN 传入 createMarket", async () => {
    const { program, calls } = makeProgram();
    const marketId = MARKET_ID;
    const prediction = Array.from({ length: 64 }, () => 65);
    const threshold = 73_479n * 10n ** 8n;

    const ixs = await ixCreateMarket(program, {
      creator: USER,
      collateralMint: COLLATERAL_MINT,
      ocr2State: PublicKey.default,
      marketId,
      prediction,
      expiry: 1_800_000_000,
      collateralAmount: 1_000_001n,
      threshold,
      settleAbove: false,
      tokenProgram: TOKEN_PROGRAM_ID,
    });

    expect(ixs).toHaveLength(2);
    expectCuLimit(ixs[0], 500_000);
    expect(ixs[1].programId.equals(PROGRAM_ID)).toBe(true);

    const call = calls[0];
    expect(call.method).toBe("createMarket");
    const args = asRecord(call.args);
    expect(asBnString(args.expiry)).toBe("1800000000");
    expect(asBnString(args.collateralAmount)).toBe("1000001");
    expect(asBnString(args.threshold)).toBe(threshold.toString());
    expect(args.settleAbove).toBe(false);
    expect(args.marketId).toEqual(marketId);
    expect(args.prediction).toEqual(prediction);

    const pdas = findMarketPdas(PROGRAM_ID, marketId);
    const [lpPosition] = findLpPosition(PROGRAM_ID, pdas.market, USER);
    assertKey(call.accounts.market, pdas.market);
    assertKey(call.accounts.snapshot, pdas.snapshot);
    assertKey(call.accounts.lpPosition, lpPosition);
    assertKey(call.accounts.yesMint, pdas.yesMint);
    assertKey(call.accounts.noMint, pdas.noMint);
    assertKey(call.accounts.collateralVault, pdas.collateralVault);
    assertKey(call.accounts.yesPool, pdas.yesPool);
    assertKey(call.accounts.noPool, pdas.noPool);
    assertKey(call.accounts.creatorCollateralAta, ataOf(COLLATERAL_MINT, USER, TOKEN_PROGRAM_ID));
    assertKey(call.accounts.clock, SYSVAR_CLOCK_PUBKEY);
    assertKey(call.accounts.associatedTokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
    assertKey(call.accounts.systemProgram, SystemProgram.programId);
    assertKey(call.accounts.tokenProgram, TOKEN_PROGRAM_ID);
    expectAccountNames(call, [
      "creator",
      "market",
      "ocr2State",
      "snapshot",
      "lpPosition",
      "collateralMint",
      "yesMint",
      "noMint",
      "collateralVault",
      "creatorCollateralAta",
      "yesPool",
      "noPool",
      "clock",
      "associatedTokenProgram",
      "tokenProgram",
      "systemProgram",
    ]);
  });
});

describe("ixUserBetOn", () => {
  it("买入 YES：方向、金额、minOut 与账户集合正确", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();

    const ixs = await ixUserBetOn(program, market, USER, {
      collateralAmount: 2_000_000n,
      tokenType: "yes",
      minOut: 1_900_000n,
    });

    // CU + YES ATA + NO ATA + 主指令
    expect(ixs).toHaveLength(4);
    expectCuLimit(ixs[0], 800_000);
    expectAtaCreate(ixs[1], USER, market.pdas.yesMint, TOKEN_PROGRAM_ID);
    expectAtaCreate(ixs[2], USER, market.pdas.noMint, TOKEN_PROGRAM_ID);
    expect(ixs[3].programId.equals(PROGRAM_ID)).toBe(true);

    const call = calls[0];
    expect(call.method).toBe("userBetOn");
    const args = asRecord(call.args);
    expect(asBnString(args.collateralAmount)).toBe("2000000");
    expect(asBnString(args.minOut)).toBe("1900000");
    expect(args.tokenType).toEqual({ yes: {} });

    assertKey(call.accounts.signer, USER);
    assertKey(call.accounts.market, market.address);
    assertKey(call.accounts.collateralAta, ataOf(COLLATERAL_MINT, USER, TOKEN_PROGRAM_ID));
    assertKey(call.accounts.yesTokenAta, ataOf(market.pdas.yesMint, USER, TOKEN_PROGRAM_ID));
    assertKey(call.accounts.noTokenAta, ataOf(market.pdas.noMint, USER, TOKEN_PROGRAM_ID));
    expectAccountNames(call, [
      "signer",
      "market",
      "collateralAta",
      "collateralMint",
      "collateralVault",
      "yesMint",
      "noMint",
      "yesTokenAta",
      "noTokenAta",
      "yesPool",
      "noPool",
      "clock",
      "associatedTokenProgram",
      "tokenProgram",
      "systemProgram",
    ]);
  });

  it("买入 NO：tokenType 映射为 { no: {} }", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();
    await ixUserBetOn(program, market, USER, {
      collateralAmount: 1n,
      tokenType: "no",
      minOut: 0n,
    });
    expect(asRecord(calls[0].args).tokenType).toEqual({ no: {} });
  });

  it("Token-2022 抵押品：ATA 与 tokenProgram 全部走 2022 程序", async () => {
    const market = makeMarket({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    const { program, calls } = makeProgram();

    const ixs = await ixUserBetOn(program, market, USER, {
      collateralAmount: 1_000_000n,
      tokenType: "no",
      minOut: 0n,
    });

    expectAtaCreate(ixs[1], USER, market.pdas.yesMint, TOKEN_2022_PROGRAM_ID);
    expectAtaCreate(ixs[2], USER, market.pdas.noMint, TOKEN_2022_PROGRAM_ID);
    const call = calls[0];
    assertKey(call.accounts.tokenProgram, TOKEN_2022_PROGRAM_ID);
    assertKey(call.accounts.collateralAta, ataOf(COLLATERAL_MINT, USER, TOKEN_2022_PROGRAM_ID));
    expect(ataOf(COLLATERAL_MINT, USER, TOKEN_2022_PROGRAM_ID).equals(ataOf(COLLATERAL_MINT, USER, TOKEN_PROGRAM_ID))).toBe(
      false
    );
  });
});

describe("ixSwap", () => {
  it("换仓不携带任何抵押品账户，只动 YES/NO 两侧", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();

    const ixs = await ixSwap(program, market, USER, {
      amountIn: 5_000_000n,
      tokenType: "yes",
      minOut: 4_500_000n,
    });

    expect(ixs).toHaveLength(4);
    expectCuLimit(ixs[0], 800_000);
    expectAtaCreate(ixs[1], USER, market.pdas.yesMint, TOKEN_PROGRAM_ID);
    expectAtaCreate(ixs[2], USER, market.pdas.noMint, TOKEN_PROGRAM_ID);

    const call = calls[0];
    expect(call.method).toBe("swap");
    const args = asRecord(call.args);
    expect(asBnString(args.amountIn)).toBe("5000000");
    expect(asBnString(args.minOut)).toBe("4500000");
    expect(args.tokenType).toEqual({ yes: {} });
    expectAccountNames(call, [
      "signer",
      "market",
      "yesMint",
      "noMint",
      "yesTokenAta",
      "noTokenAta",
      "yesPool",
      "noPool",
      "clock",
      "tokenProgram",
    ]);
  });
});

describe("LP 指令", () => {
  it("ixAddLiquidity：使用 LP PDA，三笔 ATA 与完整账户集合", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();
    const [lpPosition] = findLpPosition(PROGRAM_ID, market.address, USER);

    const ixs = await ixAddLiquidity(program, market, USER, 10_000_000n);
    expect(ixs).toHaveLength(4);
    expectCuLimit(ixs[0], 800_000);
    expectAtaCreate(ixs[1], USER, market.pdas.yesMint, TOKEN_PROGRAM_ID);
    expectAtaCreate(ixs[2], USER, market.pdas.noMint, TOKEN_PROGRAM_ID);

    const call = calls[0];
    expect(call.method).toBe("addLiquidity");
    expect(asBnString(call.args)).toBe("10000000");
    assertKey(call.accounts.lpPosition, lpPosition);
    assertKey(call.accounts.businessmanCollateralAta, ataOf(COLLATERAL_MINT, USER, TOKEN_PROGRAM_ID));
    assertKey(call.accounts.businessmanYesAta, ataOf(market.pdas.yesMint, USER, TOKEN_PROGRAM_ID));
    assertKey(call.accounts.businessmanNoAta, ataOf(market.pdas.noMint, USER, TOKEN_PROGRAM_ID));
    expectAccountNames(call, [
      "signer",
      "market",
      "lpPosition",
      "collateralMint",
      "yesMint",
      "noMint",
      "businessmanYesAta",
      "businessmanNoAta",
      "collateralVault",
      "businessmanCollateralAta",
      "yesPool",
      "noPool",
      "associatedTokenProgram",
      "clock",
      "tokenProgram",
      "systemProgram",
    ]);
  });

  it("ixGetLiquidity：LP 数量按 BN 传入，ATA 指向 maker", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();
    const [lpPosition] = findLpPosition(PROGRAM_ID, market.address, USER);

    const ixs = await ixGetLiquidity(program, market, USER, 3_000_000n);
    expect(ixs).toHaveLength(4);
    const call = calls[0];
    expect(call.method).toBe("getLiquidity");
    expect(asBnString(call.args)).toBe("3000000");
    assertKey(call.accounts.lpPosition, lpPosition);
    assertKey(call.accounts.makerYesAta, ataOf(market.pdas.yesMint, USER, TOKEN_PROGRAM_ID));
    assertKey(call.accounts.makerNoAta, ataOf(market.pdas.noMint, USER, TOKEN_PROGRAM_ID));
    expectAccountNames(call, [
      "signer",
      "market",
      "lpPosition",
      "yesMint",
      "noMint",
      "makerYesAta",
      "makerNoAta",
      "yesPool",
      "noPool",
      "clock",
      "associatedTokenProgram",
      "tokenProgram",
      "systemProgram",
    ]);
  });

  it("ixMergeToken：为抵押品和两侧代币都准备 ATA", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();

    const ixs = await ixMergeToken(program, market, USER, 2_000_000n);
    expect(ixs).toHaveLength(5); // CU + 3 ATA + 主指令
    expectCuLimit(ixs[0], 800_000);
    expectAtaCreate(ixs[1], USER, COLLATERAL_MINT, TOKEN_PROGRAM_ID);
    expectAtaCreate(ixs[2], USER, market.pdas.yesMint, TOKEN_PROGRAM_ID);
    expectAtaCreate(ixs[3], USER, market.pdas.noMint, TOKEN_PROGRAM_ID);

    const call = calls[0];
    expect(call.method).toBe("mergeToken");
    expect(asBnString(call.args)).toBe("2000000");
    expectAccountNames(call, [
      "signer",
      "market",
      "collateralAta",
      "collateralMint",
      "collateralVault",
      "yesMint",
      "noMint",
      "yesTokenAta",
      "noTokenAta",
      "tokenProgram",
    ]);
  });
});

describe("裁决与快照指令", () => {
  const pre = Buffer.alloc(226, 1);
  const post = Buffer.alloc(226, 2);

  it("ixResolveMarket：有快照时带上 snapshot PDA，CU 上限 1_000_000", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();

    const ixs = await ixResolveMarket(program, market, USER, {
      rawPre: pre,
      rawPost: post,
      hasSnapshot: true,
    });

    expect(ixs).toHaveLength(2);
    expectCuLimit(ixs[0], 1_000_000);

    const call = calls[0];
    expect(call.method).toBe("resolveMarket");
    const args = asRecord(call.args);
    expect((args.rawPre as Buffer).equals(pre)).toBe(true);
    expect((args.rawPost as Buffer).equals(post)).toBe(true);
    assertKey(call.accounts.snapshot, market.pdas.snapshot);
    assertKey(call.accounts.ocr2State, market.ocr2State);
    assertKey(call.accounts.clock, SYSVAR_CLOCK_PUBKEY);
    expectAccountNames(call, ["signer", "market", "snapshot", "ocr2State", "clock"]);
  });

  it("ixResolveMarket：无快照时 snapshot 传 null（不能传默认公钥）", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();

    await ixResolveMarket(program, market, USER, {
      rawPre: pre,
      rawPost: post,
      hasSnapshot: false,
    });

    expect(calls[0].accounts.snapshot).toBeNull();
  });

  it("ixTakeSnapshot：CU 200_000，feed 账户透传", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();
    const feed = new PublicKey(Buffer.alloc(32, 5));

    const ixs = await ixTakeSnapshot(program, market, USER, feed);
    expect(ixs).toHaveLength(2);
    expectCuLimit(ixs[0], 200_000);

    const call = calls[0];
    expect(call.method).toBe("takeSnapshot");
    assertKey(call.accounts.caller, USER);
    assertKey(call.accounts.feed, feed);
    expectAccountNames(call, [
      "caller",
      "market",
      "snapshot",
      "ocr2State",
      "feed",
      "clock",
      "systemProgram",
    ]);
  });

  it("ixVoidMarket：只返回一条指令（不加 ComputeBudget）", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();

    const ixs = await ixVoidMarket(program, market, USER);
    expect(ixs).toHaveLength(1);
    expect(ixs[0].programId.equals(PROGRAM_ID)).toBe(true);
    expect(calls[0].method).toBe("voidMarket");
    expectAccountNames(calls[0], ["signer", "market", "clock"]);
  });
});

describe("兑付与销毁", () => {
  it("ixGetCollateral：tokenMint 与其 ATA 必须成对出现", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();
    const yesMint = market.pdas.yesMint;

    const ixs = await ixGetCollateral(program, market, USER, yesMint, 7_000_000n);
    expect(ixs).toHaveLength(4);
    expectCuLimit(ixs[0], 800_000);
    expectAtaCreate(ixs[1], USER, COLLATERAL_MINT, TOKEN_PROGRAM_ID);
    expectAtaCreate(ixs[2], USER, yesMint, TOKEN_PROGRAM_ID);

    const call = calls[0];
    expect(call.method).toBe("getCollateral");
    expect(asBnString(call.args)).toBe("7000000");
    assertKey(call.accounts.tokenMint, yesMint);
    assertKey(call.accounts.tokenAta, ataOf(yesMint, USER, TOKEN_PROGRAM_ID));
    assertKey(call.accounts.userCollateralAta, ataOf(COLLATERAL_MINT, USER, TOKEN_PROGRAM_ID));
    expectAccountNames(call, [
      "signer",
      "market",
      "tokenMint",
      "tokenAta",
      "collateralMint",
      "collateralVault",
      "userCollateralAta",
      "tokenProgram",
    ]);
  });

  it("ixBurnAccount：CU 400_000，并带上快照与两侧池子", async () => {
    const market = makeMarket();
    const { program, calls } = makeProgram();

    const ixs = await ixBurnAccount(program, market, USER);
    expect(ixs).toHaveLength(3); // CU + 抵押品 ATA + 主指令
    expectCuLimit(ixs[0], 400_000);
    expectAtaCreate(ixs[1], USER, COLLATERAL_MINT, TOKEN_PROGRAM_ID);

    const call = calls[0];
    expect(call.method).toBe("burnAccount");
    assertKey(call.accounts.snapshot, market.pdas.snapshot);
    assertKey(call.accounts.yesPool, market.pdas.yesPool);
    assertKey(call.accounts.noPool, market.pdas.noPool);
    assertKey(call.accounts.collateralVault, market.pdas.collateralVault);
    expectAccountNames(call, [
      "signer",
      "market",
      "snapshot",
      "yesPool",
      "noPool",
      "yesMint",
      "noMint",
      "collateralAta",
      "collateralVault",
      "collateralMint",
      "tokenProgram",
      "clock",
    ]);
  });
});
