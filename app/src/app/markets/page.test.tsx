import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublicKey } from "@solana/web3.js";
import { emptyQuotes } from "@/lib/chainlink";
import { listSection, marketDurationBucket, marketKind, type DurationFilter } from "@/lib/display";
import { FEEDS } from "@/lib/feeds";
import type { ListSectionFilter } from "@/lib/market-dto";
import type { MarketView } from "@/lib/markets";
import type { FeedKey, FeedQuote } from "@/lib/types";
import { LocaleProvider } from "@/i18n/provider";

const NOW = 1_767_225_600;
const USER_KEY = new PublicKey(Buffer.alloc(32, 7));

const feedQuotesState = vi.hoisted(() => ({
  quotes: {} as Record<FeedKey, FeedQuote>,
}));

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

function filterMockMarkets(section: ListSectionFilter, duration: DurationFilter) {
  const byDur =
    duration === "all"
      ? marketState.markets
      : marketState.markets.filter((m) => marketDurationBucket(m) === duration);
  if (section === "live") {
    return byDur
      .filter((m) => listSection(marketKind(m, NOW)) === "live")
      .sort((a, b) => a.expiry - b.expiry);
  }
  if (section === "unsettled") {
    return byDur
      .filter((m) => listSection(marketKind(m, NOW)) === "unsettled")
      .sort((a, b) => b.expiry - a.expiry);
  }
  if (section === "ended") {
    return byDur
      .filter((m) => listSection(marketKind(m, NOW)) === "ended")
      .sort((a, b) => b.expiry - a.expiry);
  }
  return byDur;
}

vi.mock("@/hooks/use-markets", () => ({
  useMarketsPage: ({
    section,
    duration = "all",
    page = 1,
    pageSize = 30,
    enabled = true,
  }: {
    section: ListSectionFilter;
    duration?: DurationFilter;
    page?: number;
    pageSize?: number;
    enabled?: boolean;
  }) => {
    if (!enabled) {
      return {
        markets: [],
        total: 0,
        hasMore: false,
        indexedAt: NOW,
        loading: false,
        refreshing: false,
        updatedAt: NOW * 1000,
        isStaleError: false,
        error: null,
        reload: vi.fn(),
      };
    }
    const all = filterMockMarkets(section, duration);
    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    return {
      markets: slice,
      total: all.length,
      hasMore: page * pageSize < all.length,
      indexedAt: NOW,
      loading: false,
      refreshing: false,
      updatedAt: NOW * 1000,
      isStaleError: false,
      error: null,
      reload: vi.fn(),
    };
  },
  useMarketsInfinite: ({
    section,
    duration = "all",
    pageSize = 30,
    enabled = true,
  }: {
    section: ListSectionFilter;
    duration?: DurationFilter;
    pageSize?: number;
    enabled?: boolean;
  }) => {
    if (!enabled) {
      return {
        markets: [],
        total: 0,
        hasMore: false,
        indexedAt: NOW,
        loading: false,
        loadingMore: false,
        refreshing: false,
        updatedAt: NOW * 1000,
        isStaleError: false,
        error: null,
        loadMore: vi.fn(),
        reload: vi.fn(),
      };
    }
    const all = filterMockMarkets(section, duration);
    return {
      markets: all.slice(0, pageSize),
      total: all.length,
      hasMore: all.length > pageSize,
      indexedAt: NOW,
      loading: false,
      loadingMore: false,
      refreshing: false,
      updatedAt: NOW * 1000,
      isStaleError: false,
      error: null,
      loadMore: vi.fn(),
      reload: vi.fn(),
    };
  },
  useMarketPhaseTime: () => NOW,
  useVisibleVaults: () => (m: MarketView) => m.vault,
}));

vi.mock("@/hooks/use-now", () => ({
  useNow: () => NOW,
}));

vi.mock("@/hooks/use-feeds", () => ({
  useFeeds: () => ({
    quotes: feedQuotesState.quotes,
    ready: true,
    error: null,
    lastUpdated: NOW,
    lastReceivedAt: Date.now(),
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
  feedQuotesState.quotes = emptyQuotes();
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

  it("supports 'Other' duration filter chip for custom parseable durations", async () => {
    const live15m = makeMarket(10, {
      title: "BTC/USD at or above opening price in 15 min?",
      expiry: NOW + 600,
      endTs: NOW + 600,
    });
    const live1h = makeMarket(11, {
      title: "LINK/USD above 20 in 1 hour?",
      expiry: NOW + 3600,
      endTs: NOW + 3600,
    });
    marketState.markets = [live15m, live1h];

    renderMarkets();
    await userEvent.click(screen.getByRole("button", { name: "Other" }));
    expect(screen.getByRole("link", { name: /in 1 hour\?/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /in 15 min\?/ })).toBeNull();
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

  it("renders token logos for BTC/ETH/SOL/LINK and safe fallback for a no-logo feed", async () => {
    marketState.markets = [
      makeMarket(1, { title: "BTC/USD at or above opening price in 15 min?", feedKey: "btc", feedSymbol: "BTC/USD" }),
      makeMarket(2, { title: "ETH/USD at or above opening price in 15 min?", feedKey: "eth", feedSymbol: "ETH/USD" }),
      makeMarket(3, { title: "SOL/USD at or above opening price in 15 min?", feedKey: "sol", feedSymbol: "SOL/USD" }),
      makeMarket(4, { title: "LINK/USD at or above opening price in 15 min?", feedKey: "link", feedSymbol: "LINK/USD" }),
      makeMarket(5, { title: "AVAX/USD at or above opening price in 15 min?", feedKey: null, feedSymbol: "AVAX/USD" }),
    ];

    const { container } = renderMarkets();
    expect(container.querySelector('[data-asset-logo="btc"] img')).toHaveAttribute("src", "/tokens/btc.svg");
    expect(container.querySelector('[data-asset-logo="eth"] img')).toHaveAttribute("src", "/tokens/eth.svg");
    expect(container.querySelector('[data-asset-logo="sol"] img')).toHaveAttribute("src", "/tokens/sol.svg");
    expect(container.querySelector('[data-asset-logo="link"] img')).toHaveAttribute("src", "/tokens/link.svg");
    expect(container.querySelector('[data-asset-logo="fallback"]')).toHaveTextContent("AV");
  });

  it("places expired status=open markets strictly in Unsettled tab in order Live tape | Unsettled | History", async () => {
    const liveM = makeMarket(10, {
      title: "BTC/USD at or above opening price in 15 min?",
      expiry: NOW + 600,
      endTs: NOW + 600,
    });
    const unsettledM = makeMarket(11, {
      title: "ETH/USD at or above opening price in 15 min?",
      ocr2State: new PublicKey(FEEDS[1].state),
      feedKey: "eth",
      feedSymbol: "ETH/USD",
      status: "open",
      expiry: NOW - 26 * 60,
      endTs: NOW - 26 * 60,
    });
    const endedM = makeMarket(12, {
      title: "SOL/USD at or above opening price in 15 min?",
      ocr2State: new PublicKey(FEEDS[2].state),
      feedKey: "sol",
      feedSymbol: "SOL/USD",
      status: "resolved",
      winner: "yes",
      expiry: NOW - 3600,
      endTs: NOW - 3600,
      finishTs: NOW - 3590,
    });

    marketState.markets = [liveM, unsettledM, endedM];
    const { container } = renderMarkets();

    const tabs = Array.from(container.querySelectorAll('.seg-slot button [lang="en"]')).map((el) =>
      el.textContent?.trim()
    );
    expect(tabs).toEqual(["Live tape", "Unsettled", "History"]);

    // Live tab shows only live market
    expect(screen.getByRole("link", { name: /BTC\/USD/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /ETH\/USD/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /SOL\/USD/ })).toBeNull();

    // Unsettled tab shows only expired-open market with explicit expired duration & pending status
    await userEvent.click(screen.getByRole("button", { name: "Unsettled" }));
    expect(screen.getByRole("link", { name: /ETH\/USD/ })).toBeInTheDocument();
    expect(screen.getAllByText("Expired 26m ago").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Pending Settlement").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("link", { name: /BTC\/USD/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /SOL\/USD/ })).toBeNull();

    // History tab shows only resolved/ended market
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("link", { name: /SOL\/USD/ })).toBeInTheDocument();
    expect(screen.getByText("100.0¢")).toBeInTheDocument();
    expect(screen.getAllByText("YES 100.0% · NO 0.0%").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("link", { name: /ETH\/USD/ })).toBeNull();
  });

  it("hides stale spot prices (>30s) in MarketTable, and shows empty Unsettled, settled NO=0.0¢/voided=—, and matching sidebar copy", async () => {
    const liveM = makeMarket(20, {
      title: "BTC/USD at or above opening price in 15 min?",
      expiry: NOW + 600,
      endTs: NOW + 600,
    });
    marketState.markets = [liveM];
    feedQuotesState.quotes.btc = {
      key: "btc",
      price: 99_123.45,
      decimals: 8,
      publishTime: NOW - 45,
      counter: 1,
      available: true,
      receivedAt: Date.now() - 45_000,
    };

    const { container, unmount } = renderMarkets();
    expect(container.querySelector('[data-quote-stale="true"]')).not.toBeNull();
    expect(screen.getByText("Quote stale — reconnecting")).toBeInTheDocument();
    expect(screen.queryByText(/99,123\.45/)).toBeNull();
    unmount();

    const noWinner = makeMarket(21, {
      title: "ETH/USD at or above opening price in 15 min?",
      ocr2State: new PublicKey(FEEDS[1].state),
      feedKey: "eth",
      feedSymbol: "ETH/USD",
      status: "resolved",
      winner: "no",
      yesPrice: 0.5,
      expiry: NOW - 300,
      endTs: NOW - 300,
      finishTs: NOW - 290,
    });
    const voided = makeMarket(22, {
      title: "SOL/USD at or above opening price in 15 min?",
      ocr2State: new PublicKey(FEEDS[2].state),
      feedKey: "sol",
      feedSymbol: "SOL/USD",
      status: "staleBurn",
      winner: null,
      yesPrice: 0.5,
      expiry: NOW - 600,
      endTs: NOW - 600,
      finishTs: NOW - 580,
    });
    marketState.markets = [noWinner, voided];

    renderMarkets();
    await userEvent.click(screen.getByRole("button", { name: "Unsettled" }));
    expect(screen.getByText("No unsettled markets right now.")).toBeInTheDocument();
    expect(screen.getByText("No live market this round.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByText("0.0¢")).toBeInTheDocument();
    expect(screen.getAllByText("YES 0.0% · NO 100.0%").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("50.0¢")).toBeNull();
  });
});
