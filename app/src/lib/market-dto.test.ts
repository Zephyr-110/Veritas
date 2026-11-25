// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DEFAULT_PROGRAM_ID } from "@/lib/constants";
import { FEEDS } from "@/lib/feeds";
import {
  deserializeMarket,
  deserializePositionItem,
  type SerializedMarket,
  type WalletPositionItemDto,
} from "@/lib/market-dto";

function makeSerializedMarket(overrides: Partial<SerializedMarket> = {}): SerializedMarket {
  const creator = Keypair.generate().publicKey.toBase58();
  const collateralMint = Keypair.generate().publicKey.toBase58();
  const yesMint = Keypair.generate().publicKey.toBase58();
  const noMint = Keypair.generate().publicKey.toBase58();
  const address = Keypair.generate().publicKey.toBase58();
  return {
    address,
    programId: DEFAULT_PROGRAM_ID,
    idHex: "0102030405060708090a0b0c0d0e0f10",
    bump: 254,
    creator,
    title: "BTC/USD at or above opening price in 15 min?",
    feedKey: "btc",
    feedSymbol: "BTC/USD",
    ocr2State: FEEDS[0].state,
    collateralMint,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6,
    yesMint,
    noMint,
    openedAt: 1_799_999_100,
    expiry: 1_800_000_000,
    endTs: 1_800_000_000,
    finishTs: 0,
    durationSec: 900,
    durationBucket: "15m",
    status: "open",
    winner: null,
    threshold: "9500000000000",
    priceDecimals: 8,
    settleAbove: true,
    settledPrice: "0",
    settledPublishTime: 0,
    feeBps: 30,
    lZero: "28147497671065600",
    lastAccrualTs: 1_799_999_100,
    cumYesPerShare: "100",
    cumNoPerShare: "200",
    reserveYes: "150000000",
    reserveNo: "148000000",
    totalLpShares: "150000000",
    yesPool: "150000000",
    noPool: "148000000",
    vault: "152000000",
    yesPrice: 0.51,
    noPrice: 0.49,
    updatedAt: 1_799_999_200,
    ...overrides,
  };
}

describe("market-dto", () => {
  it("deserializes SerializedMarket into MarketView with BigInts, PublicKeys, and PDAs", () => {
    const dto = makeSerializedMarket();
    const view = deserializeMarket(dto);

    expect(view.address.toBase58()).toBe(dto.address);
    expect(view.yesMint.toBase58()).toBe(dto.yesMint);
    expect(view.noMint.toBase58()).toBe(dto.noMint);
    expect(view.vault).toBe(152_000_000n);
    expect(view.threshold).toBe(95_000_00000000n);
    expect(view.lZero).toBe(28_147_497_671_065_600n);
    expect(view.cumYesPerShare).toBe(100n);
    expect(view.cumNoPerShare).toBe(200n);
    expect(view.yesPrice).toBe(0.51);
    expect(view.pdas.marketBump).toBeGreaterThanOrEqual(0);
    expect(view.id).toHaveLength(16);
  });

  it("deserializes WalletPositionItemDto into market + UserPosition", () => {
    const item: WalletPositionItemDto = {
      market: makeSerializedMarket({ status: "resolved", winner: "yes" }),
      yes: "4000000",
      no: "0",
      lpShares: "5000000",
      pendingYes: "12000",
      pendingNo: "8000",
      claimableAmount: "4000000",
      canClaim: true,
      collateral: "25000000",
      updatedAt: 1_800_000_100,
    };
    const res = deserializePositionItem(item);
    expect(res.market.status).toBe("resolved");
    expect(res.market.winner).toBe("yes");
    expect(res.position.yes).toBe(4_000_000n);
    expect(res.position.lpShares).toBe(5_000_000n);
    expect(res.position.pendingYes).toBe(12_000n);
    expect(res.position.pendingNo).toBe(8_000n);
    expect(res.position.collateral).toBe(25_000_000n);
  });
});
