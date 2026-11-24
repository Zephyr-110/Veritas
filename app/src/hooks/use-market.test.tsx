import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DEFAULT_COLLATERAL_MINT } from "@/lib/constants";
import { FEEDS } from "@/lib/feeds";
import type { MarketView, UserPosition } from "@/lib/markets";

const MARKET_KEY = new PublicKey(Buffer.alloc(32, 11));
const COLLATERAL_MINT = new PublicKey(DEFAULT_COLLATERAL_MINT);

const wsEmitter = vi.hoisted(() => {
  const map = new Map<string, Set<() => void>>();
  return {
    on(event: string, fn: () => void) {
      if (!map.has(event)) map.set(event, new Set());
      map.get(event)!.add(fn);
    },
    off(event: string, fn: () => void) {
      map.get(event)?.delete(fn);
    },
    emit(event: string) {
      for (const fn of map.get(event) ?? []) fn();
    },
    removeAllListeners() {
      map.clear();
    },
  };
});
const connectionMock = vi.hoisted(() => ({
  rpcEndpoint: "https://api.devnet.solana.com",
  getBalance: vi.fn(),
  getAccountInfo: vi.fn(),
  onAccountChange: vi.fn(),
  removeAccountChangeListener: vi.fn().mockResolvedValue(undefined),
  _rpcWebSocket: wsEmitter,
}));

const walletState = vi.hoisted(() => ({
  publicKey: null as PublicKey | null,
  connected: false,
}));

const fetchMarket = vi.hoisted(() => vi.fn());
const fetchPosition = vi.hoisted(() => vi.fn());
const fetchMintMeta = vi.hoisted(() => vi.fn());
const unpackAmount = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => `/markets/${MARKET_KEY.toBase58()}`,
  useParams: () => ({ address: MARKET_KEY.toBase58() }),
}));

vi.mock("@/hooks/use-feeds", () => ({ useFeeds: () => ({ quotes: {}, ready: false }) }));
vi.mock("@/components/market-visuals", () => ({ PriceChartCard: () => null }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  WalletProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useConnection: () => ({ connection: connectionMock }),
  useWallet: () => ({
    ...walletState,
    connecting: false,
    wallet: null,
    wallets: [],
    select: vi.fn(),
    disconnect: vi.fn(),
  }),
  useAnchorWallet: () => null,
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/use-program", () => ({
  useProgram: () => ({
    programId: new PublicKey("CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER"),
  }),
}));

vi.mock("@/hooks/use-now", () => ({
  useNow: () => 1_767_225_600,
}));

vi.mock("@/lib/markets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/markets")>();
  return { ...actual, fetchMarket, fetchPosition };
});

vi.mock("@/lib/tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tokens")>();
  return { ...actual, fetchMintMeta, unpackAmount };
});

vi.mock("@/components/faucet-claim", () => ({
  FaucetClaimButton: () => <button type="button">faucet</button>,
}));

const { Providers } = await import("@/components/providers");
const { SandboxCapsule } = await import("@/components/ui");
const { TradeDesk } = await import("@/components/trade-desk");
const { useMarket } = await import("@/hooks/use-market");
const { default: MarketDetailPage } = await import("@/app/markets/[address]/page");

function makeMarket(): MarketView {
  const key = MARKET_KEY;
  return {
    address: key,
    pdas: {
      market: key,
      marketBump: 255,
      snapshot: Keypair.generate().publicKey,
      yesMint: new PublicKey(Buffer.alloc(32, 3)),
      noMint: new PublicKey(Buffer.alloc(32, 4)),
      collateralVault: new PublicKey(Buffer.alloc(32, 5)),
      yesPool: new PublicKey(Buffer.alloc(32, 6)),
      noPool: new PublicKey(Buffer.alloc(32, 8)),
    },
    title: "BTC/USD at or above opening price in 15 min?",
    id: Array.from({ length: 16 }, () => 1),
    creator: key,
    collateralMint: COLLATERAL_MINT,
    yesMint: new PublicKey(Buffer.alloc(32, 3)),
    noMint: new PublicKey(Buffer.alloc(32, 4)),
    status: "open",
    winner: null,
    expiry: 1_767_226_500,
    endTs: 1_767_226_500,
    finishTs: 0,
    bump: 255,
    yesPool: 0n,
    noPool: 0n,
    vault: 150_000_000n,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    yesPrice: 0.5,
    noPrice: 0.5,
    reserveYes: 150_000_000n,
    reserveNo: 150_000_000n,
    totalLpShares: 150_000_000n,
    ocr2State: new PublicKey(FEEDS[0].state),
    feedKey: "btc",
    feedSymbol: "BTC/USD",
    priceDecimals: 8,
    threshold: 95_000n * 10n ** 8n,
    settleAbove: true,
    settledPrice: 0n,
    settledPublishTime: 0,
    feeBps: 30,
    lastAccrualTs: 0,
    cumYesPerShare: 0n,
    cumNoPerShare: 0n,
  };
}

function makePos(collateral = 30_000_000n): UserPosition {
  return {
    collateral,
    yes: 0n,
    no: 0n,
    lpShares: 0n,
    pendingYes: 0n,
    pendingNo: 0n,
  };
}

function MarketHarness() {
  const { market, position, positionStale, syncMode, loading } = useMarket(MARKET_KEY.toBase58());
  return (
    <div>
      <SandboxCapsule />
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="sync-mode">{syncMode}</span>
      <span data-testid="pos-stale">{String(positionStale)}</span>
      {market ? <TradeDesk market={market} position={position} positionStale={positionStale} /> : null}
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  wsEmitter.removeAllListeners();
  walletState.publicKey = null;
  walletState.connected = false;
  let nextSubId = 1;
  connectionMock.onAccountChange.mockReset().mockImplementation(() => nextSubId++);
  connectionMock.removeAccountChangeListener.mockReset().mockResolvedValue(undefined);
  connectionMock.getBalance.mockReset().mockResolvedValue(40_000_000);
  connectionMock.getAccountInfo.mockReset().mockResolvedValue({
    owner: TOKEN_PROGRAM_ID,
    data: Buffer.alloc(165),
  });
  fetchMarket.mockReset().mockResolvedValue(makeMarket());
  fetchPosition.mockReset().mockResolvedValue(makePos(30_000_000n));
  fetchMintMeta.mockReset().mockResolvedValue({ tokenProgram: TOKEN_PROGRAM_ID, decimals: 6 });
  unpackAmount.mockReset().mockReturnValue(30_000_000n);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useMarket + GuestSession A1/A6 integration", () => {
  it("scrolls to the claim after the position arrives later than the market", async () => {
    walletState.publicKey = MARKET_KEY;
    walletState.connected = true;
    fetchMarket.mockResolvedValue({ ...makeMarket(), status: "windowBurn" });
    let finishPosition!: (value: UserPosition) => void;
    fetchPosition.mockReturnValue(new Promise<UserPosition>(resolve => { finishPosition = resolve; }));
    const scroll = vi.fn();
    const originalUrl = window.location.href;
    window.history.replaceState(null, "", `/markets/${MARKET_KEY}#settle-claim`);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      render(<Providers><MarketDetailPage /></Providers>);
      await screen.findByRole("heading", { level: 1 });
      await new Promise(requestAnimationFrame);
      expect(fetchPosition).toHaveBeenCalled();
      expect(document.getElementById("settle-claim")).toBeNull();
      expect(scroll).not.toHaveBeenCalled();

      await act(async () => finishPosition({ ...makePos(), yes: 4_000_000n }));
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
      expect(scroll.mock.contexts[0]).toBe(document.getElementById("settle-claim"));
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      window.history.replaceState(null, "", originalUrl);
    }
  });

  it("A6: releases TradeDesk in the same state update as sandbox activation without skeleton or insufficient-balance flash", async () => {
    // Keep fetchPosition pending forever to prove TradeDesk unlocks immediately from seeded sandbox balance.
    fetchPosition.mockImplementation(() => new Promise(() => {}));
    connectionMock.getBalance.mockImplementation(() => new Promise(() => {}));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          skipped: false,
          signature: "faucet-sig-instant",
          solLamports: 40_000_000,
          usdtAtoms: "30000000",
          usdtDecimals: 6,
        }),
      })
    );

    render(
      <Providers>
        <MarketHarness />
      </Providers>
    );

    const tryBtn = await screen.findByRole("button", {
      name: /Open Sandbox Account \(Devnet\) for real on-chain trades/i,
    });
    expect(screen.getByText("SIMULATION")).toBeInTheDocument();

    await userEvent.click(tryBtn);

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Buy YES" }).at(-1)).toBeEnabled()
    );
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(screen.getByTestId("pos-stale")).toHaveTextContent("false");
    expect(screen.getByText(/Balance 30\.00 USDT/i)).toBeInTheDocument();
    expect(screen.queryByText(/Insufficient USDT/i)).toBeNull();
  });

  it("A1: falls back to HTTP polling on WS disconnect, converges Header & TradeDesk balances, and marks stale on RPC error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          skipped: false,
          signature: "faucet-sig-ws",
          solLamports: 40_000_000,
          usdtAtoms: "30000000",
          usdtDecimals: 6,
        }),
      })
    );

    render(
      <Providers>
        <MarketHarness />
      </Providers>
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: /Open Sandbox Account \(Devnet\) for real on-chain trades/i,
      })
    );
    await waitFor(() => expect(screen.getByText(/Balance 30\.00 USDT/i)).toBeInTheDocument());

    // Now switch to fake timers, update mocked on-chain collateral to 25 USDT, and drop WS
    vi.useFakeTimers();
    unpackAmount.mockReturnValue(25_000_000n);
    fetchPosition.mockResolvedValue(makePos(25_000_000n));

    await act(async () => {
      wsEmitter.emit("close");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByTestId("sync-mode")).toHaveTextContent("polling");
    expect(screen.getByText(/Balance 25\.00 USDT/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sandbox · .* · 25\.00 USDT/i })).toBeInTheDocument();
    expect(screen.getByTestId("pos-stale")).toHaveTextContent("false");

    // Simulate HTTP poll failure -> after poll interval + React Query retry delay, stale indicator appears instead of masquerading as live
    fetchPosition.mockRejectedValue(new Error("429"));
    connectionMock.getBalance.mockRejectedValue(new Error("429"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(screen.getByTestId("sync-mode")).toHaveTextContent("stale");
    expect(screen.getByTestId("pos-stale")).toHaveTextContent("true");
    expect(screen.getAllByText("Cached").length).toBeGreaterThanOrEqual(2);
  });
});
