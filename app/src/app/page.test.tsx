import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { FEEDS } from "@/lib/feeds";
import type { ListSectionFilter } from "@/lib/market-dto";
import type { MarketView } from "@/lib/markets";
import { LocaleProvider } from "@/i18n/provider";

const NOW = 1_767_225_600;
const USER_KEY = new PublicKey(Buffer.alloc(32, 7));

const homeState = vi.hoisted(() => ({
  live: [] as MarketView[],
  ended: [] as MarketView[],
  endedTotal: 0,
  mode: "none" as "none" | "sandbox" | "real",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-markets", () => ({
  useMarketsPage: ({ section }: { section: ListSectionFilter }) => {
    const markets = section === "live" ? homeState.live : homeState.ended;
    const total = section === "live" ? homeState.live.length : homeState.endedTotal || homeState.ended.length;
    return {
      markets,
      total,
      hasMore: false,
      indexedAt: NOW,
      loading: false,
      refreshing: false,
      updatedAt: NOW * 1000,
      isStaleError: false,
      error: null,
      reload: vi.fn(),
    };
  },
  useMarketPhaseTime: () => NOW,
  useVisibleVaults: () => (market: MarketView) => market.vault,
}));

vi.mock("@/hooks/use-feeds", () => ({
  useFeeds: () => ({ quotes: {}, ready: false }),
}));

vi.mock("@/components/guest-session", () => ({
  useGuestSession: () => ({
    hydrated: true,
    mode: homeState.mode,
    effectivePublicKey: homeState.mode === "none" ? null : USER_KEY,
    hasSavedKey: false,
    entering: false,
    locked: false,
    lastError: null,
    enterSandbox: vi.fn(),
  }),
}));

vi.mock("@/components/price-tape", () => ({
  PricePanel: () => <div data-testid="price-panel" />,
}));

vi.mock("@/components/demo-video", () => ({
  DemoVideo: () => <div data-testid="demo-video" />,
}));

const { default: HomePage } = await import("@/app/page");

function makeEndedMarket(seed: number, feedIndex = 0, overrides: Partial<MarketView> = {}): MarketView {
  const key = new PublicKey(Buffer.alloc(32, seed));
  const feed = FEEDS[feedIndex];
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
    title: `${feed.symbol} at or above opening price in 15 min?`,
    id: Array.from({ length: 16 }, () => seed),
    creator: USER_KEY,
    collateralMint: key,
    yesMint: key,
    noMint: key,
    status: "resolved",
    winner: "yes",
    expiry: NOW - seed * 60,
    endTs: NOW - seed * 60,
    finishTs: NOW - seed * 60 + 4,
    bump: 255,
    yesPool: 0n,
    noPool: 0n,
    vault: 150_000_000n,
    decimals: 6,
    tokenProgram: PublicKey.default,
    yesPrice: 1,
    noPrice: 0,
    reserveYes: 150_000_000n,
    reserveNo: 150_000_000n,
    totalLpShares: 150_000_000n,
    ocr2State: new PublicKey(feed.state),
    feedKey: feed.key,
    feedSymbol: feed.symbol,
    priceDecimals: 8,
    threshold: 95_000n * 10n ** 8n,
    settleAbove: true,
    settledPrice: 96_000n * 10n ** 8n,
    settledPublishTime: NOW - seed * 60 + 1,
    feeBps: 30,
    lastAccrualTs: 0,
    cumYesPerShare: 0n,
    cumNoPerShare: 0n,
    ...overrides,
  };
}

function renderHome() {
  return render(
    <LocaleProvider>
      <HomePage />
    </LocaleProvider>
  );
}

beforeEach(() => {
  homeState.live = [];
  homeState.ended = [];
  homeState.endedTotal = 0;
  homeState.mode = "none";
});

afterEach(() => cleanup());

describe("HomePage finished marquee & token logos", () => {
  it("renders marquee loop of real finished markets with token logos and clickable links", () => {
    homeState.ended = [
      makeEndedMarket(1, 0),
      makeEndedMarket(2, 1),
      makeEndedMarket(3, 2),
      makeEndedMarket(4, 3),
    ];
    homeState.endedTotal = 10;

    const { container } = renderHome();

    const marquee = container.querySelector(".home-fin-marquee");
    expect(marquee).not.toBeNull();
    const groups = container.querySelectorAll(".home-fin-group");
    expect(groups).toHaveLength(2);
    expect(groups[0].querySelectorAll(".home-fin-item")).toHaveLength(4);
    expect(groups[1]).toHaveClass("home-fin-dup");
    expect(groups[1]).toHaveAttribute("aria-hidden", "true");
    expect(groups[1].querySelectorAll(".home-fin-item")).toHaveLength(4);

    // Every item in both groups remains a real clickable link to /markets/<addr>
    const firstAddr = homeState.ended[0].address.toBase58();
    const cardLinks = container.querySelectorAll(`a[href="/markets/${firstAddr}"]`);
    expect(cardLinks).toHaveLength(2);

    // BTC, ETH, SOL, LINK logos all present
    expect(container.querySelector('[data-asset-logo="btc"] img')).toHaveAttribute("src", "/tokens/btc.svg");
    expect(container.querySelector('[data-asset-logo="eth"] img')).toHaveAttribute("src", "/tokens/eth.svg");
    expect(container.querySelector('[data-asset-logo="sol"] img')).toHaveAttribute("src", "/tokens/sol.svg");
    expect(container.querySelector('[data-asset-logo="link"] img')).toHaveAttribute("src", "/tokens/link.svg");

    // Total > 6 shows View all finished link targeting /markets?tape=history
    const viewAllLink = screen.getByRole("link", { name: /View all finished/i });
    expect(viewAllLink).toHaveAttribute("href", "/markets?tape=history");
  });

  it("does not duplicate or fabricate cards when only 1 finished market exists", () => {
    homeState.ended = [makeEndedMarket(1, 0)];
    homeState.endedTotal = 1;

    const { container } = renderHome();
    expect(container.querySelector(".home-fin-marquee")).toBeNull();
    expect(container.querySelector(".home-fin-strip")).not.toBeNull();
    expect(container.querySelectorAll(".home-fin-item")).toHaveLength(1);
  });
});

describe("HomePage hero copy, layout order, and why cards", () => {
  it("renders finalized hero headline & subline without masthead brand row or previous draft copy", () => {
    const { container } = renderHome();
    expect(container.querySelector(".mh-brand")).toBeNull();
    expect(screen.getByText("A prediction market")).toBeInTheDocument();
    expect(screen.getByText("with no dispute window.")).toBeInTheDocument();
    const sub = container.querySelector('.home-sub span[lang="en"]');
    expect(sub).toHaveTextContent(
      "Settlement is decided solely by the first signed Chainlink OCR2 report after expiry — no intermediary decides the outcome. A market can be opened with just over 1 USDT."
    );
    expect(sub?.querySelector(".whitespace-nowrap")).toHaveTextContent("1 USDT");
    expect(screen.queryByText(/New rounds open every 15 minutes/i)).toBeNull();
    expect(screen.queryByText(/pm-AMM prediction/i)).toBeNull();
    expect(screen.queryByText(/A fast-paced prediction market/i)).toBeNull();
    expect(screen.queryByText(/Settlement disputes eliminated at the protocol layer\./i)).toBeNull();
  });

  it("places Live this round immediately below Hero and above the settlement architecture strip", () => {
    const { container } = renderHome();
    const hero = container.querySelector(".home-hero");
    const liveHeading = screen.getByText("Live this round");
    const settleHeading = screen.getByText(/ON-CHAIN SETTLEMENT/i);
    expect(hero).not.toBeNull();
    expect(hero!.compareDocumentPosition(liveHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(liveHeading.compareDocumentPosition(settleHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders reverted short why1 copy and keeps concise dispute-free why2 copy", () => {
    renderHome();
    expect(
      screen.getByText("Open a market with just over 1 USDT. No one's approval needed.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No voting, no dispute bond, no appeal window\./)
    ).toBeInTheDocument();
    expect(screen.queryByText(/At EVM gas prices/)).toBeNull();
    expect(screen.queryByText(/24 cases the round sequence jumped/)).toBeNull();
  });

  it("excludes expired status=open markets from homepage Live this round", () => {
    const expiredOpen = makeEndedMarket(9, 0);
    expiredOpen.status = "open";
    expiredOpen.winner = null;
    homeState.live = [expiredOpen];

    renderHome();
    expect(screen.getByText("No markets this round.")).toBeInTheDocument();
  });

  it("renders sandbox one-click jump prioritizing shortest 2m market, falling back to shortest live, and omitting when empty", () => {
    homeState.mode = "sandbox";
    const m15 = makeEndedMarket(21, 0, {
      status: "open",
      winner: null,
      expiry: NOW + 30,
      endTs: NOW + 30,
      title: "BTC/USD at or above opening price in 15 min?",
    });
    const m2Short = makeEndedMarket(22, 1, {
      status: "open",
      winner: null,
      expiry: NOW + 70,
      endTs: NOW + 70,
      title: "ETH/USD at or above opening price in 2 min?",
    });
    const m2Long = makeEndedMarket(23, 2, {
      status: "open",
      winner: null,
      expiry: NOW + 110,
      endTs: NOW + 110,
      title: "SOL/USD at or above opening price in 2 min?",
    });
    homeState.live = [m15, m2Long, m2Short];

    const { rerender } = renderHome();
    expect(screen.getByTestId("home-sandbox-quick-jump")).toHaveAttribute(
      "href",
      `/markets/${m2Short.address.toBase58()}`
    );

    homeState.live = [m15];
    rerender(
      <LocaleProvider>
        <HomePage />
      </LocaleProvider>
    );
    expect(screen.getByTestId("home-sandbox-quick-jump")).toHaveAttribute(
      "href",
      `/markets/${m15.address.toBase58()}`
    );

    homeState.live = [];
    rerender(
      <LocaleProvider>
        <HomePage />
      </LocaleProvider>
    );
    expect(screen.queryByTestId("home-sandbox-quick-jump")).toBeNull();
  });
});
