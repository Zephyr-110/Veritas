import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_PROGRAM_ID } from "@/lib/constants";
import { FEEDS } from "@/lib/feeds";
import type { SerializedMarket, WalletPositionItemDto } from "@/lib/market-dto";
import type { MarketView } from "@/lib/markets";
import {
  useMarketsInfinite,
  useMarketsPage,
  useVisibleVaults,
  useWalletPositionsPage,
} from "./use-markets";

const connection = vi.hoisted(() => ({ rpcEndpoint: "test", getMultipleAccountsInfo: vi.fn() }));
vi.mock("@solana/wallet-adapter-react", () => ({ useConnection: () => ({ connection }) }));
vi.mock("@/lib/tokens", async (original) => ({
  ...await original<typeof import("@/lib/tokens")>(),
  unpackAmount: (_key: PublicKey, info: { amount: bigint }) => info.amount,
}));
vi.mock("@/components/providers", () => ({
  useSettings: () => ({
    settings: {
      rpcUrl: "https://api.devnet.solana.com",
      cluster: "devnet",
      programId: DEFAULT_PROGRAM_ID,
      collateralMint: "CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG",
    },
  }),
}));
vi.mock("./use-program", () => ({
  useProgram: () => ({ programId: new PublicKey(DEFAULT_PROGRAM_ID) }),
}));

function makeDto(i: number): SerializedMarket {
  const addr = new PublicKey(new Uint8Array(32).fill(i + 1)).toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  return {
    address: addr,
    programId: DEFAULT_PROGRAM_ID,
    idHex: i.toString(16).padStart(32, "0"),
    bump: 254,
    creator: addr,
    title: "BTC/USD at or above opening price in 15 min?",
    feedKey: "btc",
    feedSymbol: "BTC/USD",
    ocr2State: FEEDS[0].state,
    collateralMint: mint,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6,
    yesMint: mint,
    noMint: mint,
    openedAt: 1_799_999_100,
    expiry: 1_800_000_000 - i * 60,
    endTs: 1_800_000_000 - i * 60,
    finishTs: 0,
    durationSec: 900,
    durationBucket: "15m",
    status: "resolved",
    winner: "yes",
    threshold: "9500000000000",
    priceDecimals: 8,
    settleAbove: true,
    settledPrice: "9600000000000",
    settledPublishTime: 1_800_000_000,
    feeBps: 30,
    lZero: "0",
    lastAccrualTs: 0,
    cumYesPerShare: "0",
    cumNoPerShare: "0",
    reserveYes: "100000000",
    reserveNo: "100000000",
    totalLpShares: "100000000",
    yesPool: "0",
    noPool: "0",
    vault: "50000000",
    yesPrice: 0.5,
    noPrice: 0.5,
    updatedAt: 1_800_000_000,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("use-markets hooks", () => {
  it("keeps the first page of vault balances visible while loading more history", async () => {
    const markets = Array.from({ length: 31 }, (_, i) => {
      const key = new PublicKey(new Uint8Array(32).fill(i + 1));
      return { address: key, status: "resolved", pdas: { collateralVault: key } } as MarketView;
    });
    connection.getMultipleAccountsInfo.mockImplementation(async (keys: PublicKey[]) =>
      keys.map((key) => ({ amount: BigInt(key.toBytes()[0]) }))
    );
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender, unmount } = renderHook(
      ({ limit }) => useVisibleVaults(markets.slice(0, limit)),
      { wrapper, initialProps: { limit: 30 } }
    );
    await waitFor(() => expect(result.current(markets[29])).toBe(30n));
    rerender({ limit: 60 });
    expect(result.current(markets[0])).toBe(1n);
    await waitFor(() => expect(result.current(markets[30])).toBe(31n));
    expect(connection.getMultipleAccountsInfo.mock.calls.map(([keys]) => keys.length)).toEqual([30, 1]);
    unmount();
    client.clear();
  });

  it("useMarketsPage and useMarketsInfinite fetch paginated SQLite endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url, "http://localhost");
      const page = Number(parsed.searchParams.get("page") || "1");
      const pageSize = Number(parsed.searchParams.get("pageSize") || "30");
      return {
        ok: true,
        json: async () => ({
          items: page === 1 ? [makeDto(0), makeDto(1)] : [makeDto(2)],
          total: 3,
          page,
          pageSize,
          hasMore: page === 1,
          indexedAt: 1_800_000_000,
          source: "sqlite",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result: pageHook } = renderHook(
      () => useMarketsPage({ section: "live", duration: "15m", page: 1, pageSize: 2 }),
      { wrapper }
    );
    await waitFor(() => expect(pageHook.current.markets).toHaveLength(2));
    expect(pageHook.current.total).toBe(3);
    expect(pageHook.current.hasMore).toBe(true);

    const { result: infHook } = renderHook(
      () => useMarketsInfinite({ section: "ended", duration: "all", pageSize: 2 }),
      { wrapper }
    );
    await waitFor(() => expect(infHook.current.markets).toHaveLength(2));
    await act(async () => {
      await infHook.current.loadMore();
    });
    await waitFor(() => expect(infHook.current.markets).toHaveLength(3));
    expect(infHook.current.hasMore).toBe(false);
    client.clear();
  });

  it("useWalletPositionsPage loads paginated wallet positions and supports force refresh", async () => {
    const posItem: WalletPositionItemDto = {
      market: makeDto(0),
      yes: "3000000",
      no: "0",
      lpShares: "0",
      pendingYes: "0",
      pendingNo: "0",
      claimableAmount: "3000000",
      canClaim: true,
      collateral: "25000000",
      updatedAt: 1_800_000_000,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [posItem],
        summary: {
          totalMarkets: 1,
          sumYes: 3,
          sumNo: 0,
          sumPending: 0,
          claimCount: 1,
          claimTotal: 3,
          lpUnclaimed: false,
        },
        total: 1,
        page: 1,
        pageSize: 30,
        hasMore: false,
        syncedAt: 1_800_000_000,
        source: "sqlite",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const wallet = Keypair.generate().publicKey.toBase58();

    const { result } = renderHook(
      () =>
        useWalletPositionsPage({
          wallet,
          programId: DEFAULT_PROGRAM_ID,
          rpcUrl: "https://api.devnet.solana.com",
          pageSize: 30,
        }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.summary.claimCount).toBe(1);

    await act(async () => {
      await result.current.reload(true);
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("refresh=1"))).toBe(true);
    client.clear();
  });
});
