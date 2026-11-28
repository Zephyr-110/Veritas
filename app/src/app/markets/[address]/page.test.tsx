import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen, cleanup } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { FEEDS } from "@/lib/feeds";
import { emptyQuotes } from "@/lib/chainlink";
import type { MarketView, UserPosition } from "@/lib/markets";
import { LocaleProvider } from "@/i18n/provider";
import { setLocale } from "@/i18n/store";

const NOW = 1_767_225_600;
const MARKET_KEY = new PublicKey(Buffer.alloc(32, 31));

function makeExpiredMarket(): MarketView {
  return {
    address: MARKET_KEY,
    pdas: {
      market: MARKET_KEY,
      marketBump: 255,
      snapshot: MARKET_KEY,
      yesMint: MARKET_KEY,
      noMint: MARKET_KEY,
      collateralVault: MARKET_KEY,
      yesPool: MARKET_KEY,
      noPool: MARKET_KEY,
    },
    title: "BTC/USD at or above opening price in 2 min?",
    id: Array.from({ length: 16 }, () => 31),
    creator: MARKET_KEY,
    collateralMint: MARKET_KEY,
    yesMint: MARKET_KEY,
    noMint: MARKET_KEY,
    status: "open",
    winner: null,
    expiry: NOW - 30,
    endTs: NOW - 30,
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
    threshold: 5_992_444_000_000n,
    settleAbove: true,
    settledPrice: 0n,
    settledPublishTime: 0,
    feeBps: 50,
    lastAccrualTs: NOW - 60,
    cumYesPerShare: 0n,
    cumNoPerShare: 0n,
  };
}

const emptyPos: UserPosition = {
  collateral: 0n,
  yes: 0n,
  no: 0n,
  lpShares: 0n,
  pendingYes: 0n,
  pendingNo: 0n,
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ address: MARKET_KEY.toBase58() }),
  usePathname: () => `/markets/${MARKET_KEY.toBase58()}`,
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

let currentMarket: MarketView = makeExpiredMarket();

vi.mock("@/hooks/use-market", () => ({
  useMarket: () => ({
    market: currentMarket,
    position: emptyPos,
    positionStale: false,
    loading: false,
    refreshing: false,
    updatedAt: NOW * 1000,
    isStaleError: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-now", () => ({
  useNow: () => NOW,
}));

vi.mock("@/hooks/use-feeds", () => ({
  useFeeds: () => ({ quotes: emptyQuotes(), ready: true }),
}));

vi.mock("@/components/guest-session", () => ({
  useGuestSession: () => ({ effectivePublicKey: null, isSandbox: false }),
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
  useToasts: () => ({ push: vi.fn(), clearMarketErrors: vi.fn() }),
}));

vi.mock("@/components/market-visuals", () => ({
  LiquidityCard: () => null,
  PriceChartCard: () => null,
}));

vi.mock("@/components/settle-desk", () => ({
  SettleDesk: () => null,
}));

vi.mock("@/components/trade-desk", () => ({
  TradeDesk: () => null,
}));

vi.mock("@/components/lp-desk", () => ({
  LpDesk: () => null,
}));

vi.mock("@/components/ruling-evidence", () => ({
  RulingEvidence: () => null,
}));

const { default: MarketDetailPage } = await import("./page");

afterEach(() => {
  cleanup();
  setLocale("en");
  currentMarket = makeExpiredMarket();
});

describe("MarketDetailPage StatusBand settlement rule wrapping", () => {
  it("renders full settlement rule without single-line truncation in both EN and ZH", () => {
    const { container, rerender } = render(
      <LocaleProvider>
        <MarketDetailPage />
      </LocaleProvider>
    );

    const bandGrid = container.querySelector(".band-grid")!;
    expect(bandGrid).not.toBeNull();
    const enRule = screen.getAllByText("YES redeems 1:1 if print ≥ 59,924.44")[0];
    const bandRuleCell = bandGrid.querySelector(".whitespace-normal.break-words");
    expect(bandRuleCell).not.toBeNull();
    expect(bandRuleCell!.className).not.toContain("truncate");
    expect(bandRuleCell!.textContent).toContain("YES redeems 1:1 if print ≥ 59,924.44");
    expect(enRule).toBeInTheDocument();

    act(() => {
      setLocale("zh");
    });
    rerender(
      <LocaleProvider>
        <MarketDetailPage />
      </LocaleProvider>
    );
    expect(bandRuleCell!.textContent).toContain("读数 ≥ 59,924.44，YES 按 1:1 兑付");
  });

  it("shows legacy v1 note only when startTs is absent and status is open (hides on v2 open and v1 finalized)", () => {
    // 1. Legacy v1 open -> shown in EN and ZH
    currentMarket = { ...makeExpiredMarket(), startTs: undefined, status: "open" };
    const { rerender } = render(
      <LocaleProvider>
        <MarketDetailPage />
      </LocaleProvider>
    );
    expect(screen.getByTestId("legacy-market-note")).toHaveTextContent(
      "Created under the previous program version — the current program cannot settle this market. It will be marked void once the 48-hour resolve window ends."
    );
    act(() => {
      setLocale("zh");
    });
    rerender(
      <LocaleProvider>
        <MarketDetailPage />
      </LocaleProvider>
    );
    expect(screen.getByTestId("legacy-market-note")).toHaveTextContent(
      "该市场由上一版程序创建，当前程序无法为其结算；48 小时裁决窗口结束后将标记为作废。"
    );

    // 2. v2 open (has startTs) -> hidden
    currentMarket = { ...makeExpiredMarket(), startTs: NOW - 150, status: "open" };
    rerender(
      <LocaleProvider>
        <MarketDetailPage />
      </LocaleProvider>
    );
    expect(screen.queryByTestId("legacy-market-note")).toBeNull();

    // 3. Legacy v1 finalized -> hidden
    currentMarket = { ...makeExpiredMarket(), startTs: undefined, status: "windowBurn" };
    rerender(
      <LocaleProvider>
        <MarketDetailPage />
      </LocaleProvider>
    );
    expect(screen.queryByTestId("legacy-market-note")).toBeNull();
  });
});
