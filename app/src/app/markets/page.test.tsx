import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublicKey } from "@solana/web3.js";
import { emptyQuotes } from "@/lib/chainlink";
import { FEEDS } from "@/lib/feeds";
import type { MarketView } from "@/lib/markets";
import { LocaleProvider } from "@/i18n/provider";

const NOW = 1_767_225_600;
const USER_KEY = new PublicKey(Buffer.alloc(32, 7));

const marketState = vi.hoisted(() => ({
  markets: [] as MarketView[],
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-markets", () => ({
  useMarkets: () => ({
    markets: marketState.markets,
    loading: false,
    refreshing: false,
    updatedAt: NOW * 1000,
    isStaleError: false,
    error: null,
    reload: vi.fn(),
  }),
  useMarketPhaseTime: () => NOW,
  useVisibleVaults: () => (m: MarketView) => m.vault,
}));

vi.mock("@/hooks/use-feeds", () => ({
  useFeeds: () => ({
    quotes: emptyQuotes(),
    ready: true,
    error: null,
    lastUpdated: NOW,
    retry: vi.fn(),
  }),
}));

vi.mock("@/components/guest-session", () => ({
  useEffectivePublicKey: () => USER_KEY,
  useGuestSession: () => ({
    effectivePublicKey: USER_KEY,
    isSandbox: false,
  }),
}));

vi.mock("@/components/providers", () => ({
  useSettings: () => ({
    settings: {
      rpcUrl: "https://api.devnet.solana.com",
      cluster: "devnet",
      programId: "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER",
      collateralMint: "CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG",
    },
  }),
}));

vi.mock("@/components/sim-preview", () => ({
  SimOrderPreview: () => <div data-testid="sim-preview" />,
}));

const { default: MarketsPage } = await import("@/app/markets/page");

function makeMarket(seed: number, overrides: Partial<MarketView> = {}): MarketView {
  const key = new PublicKey(Buffer.alloc(32, seed));
  return {
    address: key,
    pdas: {
      market: key,
      marketBump: 255,
      snapshot: key,
      yesMint: key,
      noMint: key,
      collateralVault: key,
      yesPool: key,
      noPool: key,
    },
    title: `BTC/USD at or above opening price in 15 min?`,
    id: Array.from({ length: 16 }, () => seed),
    creator: USER_KEY,
    collateralMint: key,
    yesMint: key,
    noMint: key,
    status: "open",
    winner: null,
    expiry: NOW + 600,
    endTs: NOW + 600,
    finishTs: 0,
    bump: 255,
    yesPool: 0n,
    noPool: 0n,
    vault: 150_000_000n,
    decimals: 6,
    tokenProgram: PublicKey.default,
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
    ...overrides,
  };
}

function renderMarkets() {
  return render(
    <LocaleProvider>
      <MarketsPage />
    </LocaleProvider>
  );
}

beforeEach(() => {
  marketState.markets = [];
});

afterEach(() => cleanup());

describe("MarketsPage duration filter chips", () => {
  it("supports All / 2 min / 15 min / 24 hours across both Live tape and History", async () => {
    const live2m = makeMarket(1, {
      title: "BTC/USD at or above opening price in 2 min?",
      ocr2State: new PublicKey(FEEDS[0].state),
      expiry: NOW + 90,
      endTs: NOW + 90,
    });
    const live15m = makeMarket(2, {
      title: "ETH/USD at or above opening price in 15 min?",
      ocr2State: new PublicKey(FEEDS[1].state),
      feedKey: "eth",
      feedSymbol: "ETH/USD",
      expiry: NOW + 600,
      endTs: NOW + 600,
    });
    const live24h = makeMarket(3, {
      title: "SOL/USD at or above opening price in 24 hours?",
      ocr2State: new PublicKey(FEEDS[2].state),
      feedKey: "sol",
      feedSymbol: "SOL/USD",
      expiry: NOW + 80_000,
      endTs: NOW + 80_000,
    });
    const hist2m = makeMarket(4, {
      title: "BTC/USD at or above opening price in 120 sec?",
      ocr2State: new PublicKey(FEEDS[0].state),
      status: "resolved",
      winner: "yes",
      expiry: NOW - 120,
      endTs: NOW - 120,
      finishTs: NOW - 110,
    });
    const hist15m = makeMarket(5, {
      title: "ETH/USD at or above opening price in 15 min?",
      ocr2State: new PublicKey(FEEDS[1].state),
      feedKey: "eth",
      feedSymbol: "ETH/USD",
      status: "resolved",
      winner: "no",
      expiry: NOW - 900,
      endTs: NOW - 900,
      finishTs: NOW - 890,
    });
    const hist24h = makeMarket(6, {
      title: "LINK/USD 1 天后能站上开盘价吗？",
      ocr2State: new PublicKey(FEEDS[3].state),
      feedKey: "link",
      feedSymbol: "LINK/USD",
      status: "resolved",
      winner: "yes",
      expiry: NOW - 3600,
      endTs: NOW - 3600,
      finishTs: NOW - 3590,
    });

    marketState.markets = [live2m, live15m, live24h, hist2m, hist15m, hist24h];

    renderMarkets();

    // Live tape + All: shows all 3 live markets
    expect(screen.getByRole("link", { name: /in 2 min\?/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /in 15 min\?/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /in 24 hours\?/ })).toBeInTheDocument();

    // Filter live 2 min
    await userEvent.click(screen.getByRole("button", { name: "2 min" }));
    expect(screen.getByRole("link", { name: /in 2 min\?/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /in 15 min\?/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /in 24 hours\?/ })).toBeNull();

    // Switch to History while 2 min chip is active
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("link", { name: /in 120 sec\?/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /ETH\/USD at or above opening price in 15 min\?/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /LINK\/USD/ })).toBeNull();

    // Filter History 15 min
    await userEvent.click(screen.getByRole("button", { name: "15 min" }));
    expect(screen.getByRole("link", { name: /ETH\/USD at or above opening price in 15 min\?/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /in 120 sec\?/ })).toBeNull();

    // Filter History 24 hours
    await userEvent.click(screen.getByRole("button", { name: "24 hours" }));
    expect(screen.getByRole("link", { name: /LINK\/USD.*in 1 day\?/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /ETH\/USD/ })).toBeNull();

    // Reset back to All
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("link", { name: /in 120 sec\?/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /ETH\/USD at or above opening price in 15 min\?/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /LINK\/USD.*in 1 day\?/ })).toBeInTheDocument();
  });

  it("shows reset filter CTA when a duration filter has no matches", async () => {
    marketState.markets = [
      makeMarket(1, {
        title: "BTC/USD at or above opening price in 15 min?",
        expiry: NOW + 600,
        endTs: NOW + 600,
      }),
    ];

    renderMarkets();
    await userEvent.click(screen.getByRole("button", { name: "24 hours" }));

    const resetBtn = screen.getByRole("button", { name: "Show all durations" });
    expect(resetBtn).toBeInTheDocument();

    await userEvent.click(resetBtn);
    expect(screen.getByRole("link", { name: /in 15 min\?/ })).toBeInTheDocument();
  });
});
