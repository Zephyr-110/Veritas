import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { FEEDS } from "@/lib/feeds";
import { toUi } from "@/lib/format";
import type { WalletPositionsSummaryDto } from "@/lib/market-dto";
import { claimableOf, isFinalizedStatus, pendingValueOf, type MarketView, type UserPosition } from "@/lib/markets";
import { LocaleProvider } from "@/i18n/provider";

const NOW = 1_767_225_600;
const USER_KEY = new PublicKey(Buffer.alloc(32, 7));
const PROGRAM_KEY = new PublicKey("CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER");

type PositionRow = { market: MarketView; position: UserPosition };

const positionState = vi.hoisted(() => ({
  rows: [] as PositionRow[],
}));

const fetchRedemptions = vi.hoisted(() => vi.fn());

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: { rpcEndpoint: "https://api.devnet.solana.com" } }),
}));

vi.mock("@/hooks/use-program", () => ({
  useProgram: () => ({ programId: PROGRAM_KEY }),
}));

function buildSummary(rows: PositionRow[]): WalletPositionsSummaryDto {
  const finalized = rows.filter(({ market }) => isFinalizedStatus(market.status));
  return {
    totalMarkets: rows.length,
    sumYes: rows.reduce(
      (a, r) =>
        a +
        (r.market.status === "open" || (r.market.status === "resolved" && r.market.winner === "yes")
          ? Number(toUi(r.position.yes, r.market.decimals, 2))
          : 0),
      0
    ),
    sumNo: rows.reduce(
      (a, r) =>
        a +
        (r.market.status === "open" || (r.market.status === "resolved" && r.market.winner === "no")
          ? Number(toUi(r.position.no, r.market.decimals, 2))
          : 0),
      0
    ),
    sumPending: rows.reduce(
      (a, r) => a + Number(toUi(pendingValueOf(r.market, r.position), r.market.decimals, 4)),
      0
    ),
    claimCount: finalized.filter(({ market, position }) => claimableOf(market, position) > 0n).length,
    claimTotal: finalized.reduce(
      (a, { market, position }) => a + Number(toUi(claimableOf(market, position), market.decimals, 2)),
      0
    ),
    lpUnclaimed: finalized.some(
      ({ position }) => position.lpShares > 0n || position.pendingYes > 0n || position.pendingNo > 0n
    ),
  };
}

vi.mock("@/hooks/use-markets", () => ({
  useWalletPositionsPage: () => ({
    rows: positionState.rows,
    summary: buildSummary(positionState.rows),
    total: positionState.rows.length,
    hasMore: false,
    syncedAt: NOW,
    loading: false,
    loadingMore: false,
    refreshing: false,
    updatedAt: NOW * 1000,
    isStaleError: false,
    error: null,
    loadMore: vi.fn(),
    reload: vi.fn(),
  }),
  useMarketPhaseTime: () => NOW,
}));

vi.mock("@/lib/history", () => ({
  fetchRedemptions,
}));

vi.mock("@/components/guest-session", () => ({
  useGuestSession: () => ({
    effectivePublicKey: USER_KEY,
    isSandbox: false,
    hasSavedKey: false,
    storageAvailable: true,
    entering: false,
    locked: false,
    lastError: null,
    enterSandbox: vi.fn(),
  }),
}));

vi.mock("@/components/providers", () => ({
  useSettings: () => ({
    settings: {
      rpcUrl: "https://api.devnet.solana.com",
      cluster: "devnet",
      programId: PROGRAM_KEY.toBase58(),
      collateralMint: "CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG",
    },
  }),
}));

const { default: MePage } = await import("@/app/me/page");

function makeMarket(seed: number, overrides: Partial<MarketView> = {}): MarketView {
  const address = new PublicKey(Buffer.alloc(32, seed));
  const key = new PublicKey(Buffer.alloc(32, seed + 20));
  return {
    address,
    pdas: {
      market: address,
      marketBump: 255,
      snapshot: key,
      yesMint: key,
      noMint: key,
      collateralVault: key,
      yesPool: key,
      noPool: key,
    },
    title: `Market ${seed}`,
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
    vault: 0n,
    decimals: 6,
    tokenProgram: PublicKey.default,
    yesPrice: 0.5,
    noPrice: 0.5,
    reserveYes: 100_000_000n,
    reserveNo: 100_000_000n,
    totalLpShares: 100_000_000n,
    ocr2State: new PublicKey(FEEDS[0].state),
    feedKey: "btc",
    feedSymbol: "BTC/USD",
    priceDecimals: 8,
    threshold: 73_479n * 10n ** 8n,
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

function makePosition(overrides: Partial<UserPosition> = {}): UserPosition {
  return {
    collateral: 0n,
    yes: 0n,
    no: 0n,
    lpShares: 0n,
    pendingYes: 0n,
    pendingNo: 0n,
    ...overrides,
  };
}

function renderMePage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <MePage />
      </LocaleProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  positionState.rows = [];
  fetchRedemptions.mockReset().mockResolvedValue([]);
});

afterEach(() => cleanup());

describe("MePage Claim 跳转分流", () => {
  it("按领取类型分别指向 #settle-claim、#lp-withdraw，非 Claim 行不拼锚点", async () => {
    const winnerMarket = makeMarket(1, {
      title: "Winner Claim Market",
      status: "resolved",
      winner: "yes",
      expiry: NOW - 600,
      endTs: NOW - 600,
      finishTs: NOW - 300,
    });
    const voidMarket = makeMarket(2, {
      title: "Void Refund Market",
      status: "staleBurn",
      expiry: NOW - 600,
      endTs: NOW - 600,
      finishTs: NOW - 300,
    });
    const lpOnlyMarket = makeMarket(3, {
      title: "LP Withdraw Market",
      status: "resolved",
      winner: "yes",
      expiry: NOW - 600,
      endTs: NOW - 600,
      finishTs: NOW - 300,
    });
    const liveMarket = makeMarket(4, {
      title: "Live Trading Market",
      status: "open",
      expiry: NOW + 600,
      endTs: NOW + 600,
    });
    const loserViewMarket = makeMarket(5, {
      title: "Loser View Market",
      status: "resolved",
      winner: "yes",
      expiry: NOW - 600,
      endTs: NOW - 600,
      finishTs: NOW - 300,
    });

    positionState.rows = [
      {
        market: winnerMarket,
        position: makePosition({ yes: 4_000_000n, lpShares: 0n }),
      },
      {
        market: voidMarket,
        position: makePosition({ yes: 4_000_000n, lpShares: 0n }),
      },
      {
        market: lpOnlyMarket,
        position: makePosition({ no: 2_000_000n, lpShares: 5_000_000n }),
      },
      {
        market: liveMarket,
        position: makePosition({ yes: 1_000_000n, lpShares: 2_000_000n }),
      },
      {
        market: loserViewMarket,
        position: makePosition({ no: 2_000_000n, lpShares: 0n }),
      },
    ];

    renderMePage();

    const winnerLink = (await screen.findByText("Winner Claim Market")).closest("a");
    const voidLink = screen.getByText("Void Refund Market").closest("a");
    const lpLink = screen.getByText("LP Withdraw Market").closest("a");
    const liveLink = screen.getByText("Live Trading Market").closest("a");
    const loserLink = screen.getByText("Loser View Market").closest("a");

    await waitFor(() => expect(winnerLink).not.toBeNull());
    expect(winnerLink).toHaveAttribute(
      "href",
      `/markets/${winnerMarket.address.toBase58()}#settle-claim`
    );
    expect(voidLink).toHaveAttribute(
      "href",
      `/markets/${voidMarket.address.toBase58()}#settle-claim`
    );
    expect(lpLink).toHaveAttribute(
      "href",
      `/markets/${lpOnlyMarket.address.toBase58()}#lp-withdraw`
    );
    expect(liveLink).toHaveAttribute(
      "href",
      `/markets/${liveMarket.address.toBase58()}`
    );
    expect(loserLink).toHaveAttribute(
      "href",
      `/markets/${loserViewMarket.address.toBase58()}`
    );
    expect(screen.getByText(/in 2 finalized markets —/)).toBeInTheDocument();
    expect(screen.getByText("Maker pending")).toBeInTheDocument();
    expect(screen.getByText("Redeemable")).toBeInTheDocument();
    expect(screen.getAllByText("0.0000").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("6.00 USDT")).toBeInTheDocument();
    expect(screen.queryByText("Pending total")).toBeNull();
  });

  it("未领取横幅在 count=1 时显示单数文案", async () => {
    const winnerMarket = makeMarket(9, {
      title: "Single Unclaimed Market",
      status: "resolved",
      winner: "yes",
      expiry: NOW - 600,
      endTs: NOW - 600,
      finishTs: NOW - 300,
    });
    positionState.rows = [
      {
        market: winnerMarket,
        position: makePosition({ yes: 3_000_000n, lpShares: 0n }),
      },
    ];

    renderMePage();

    await screen.findByText("Single Unclaimed Market");
    expect(screen.getByText(/in 1 finalized market —/)).toBeInTheDocument();
    expect(screen.queryByText(/in 1 finalized markets/)).toBeNull();
  });

  it("兑付记录拉取失败时显示错误态与重试按钮，不伪装成无记录", async () => {
    fetchRedemptions.mockRejectedValue(new Error("429 Too Many Requests"));
    positionState.rows = [
      {
        market: makeMarket(10, { title: "Active Market" }),
        position: makePosition({ yes: 2_000_000n }),
      },
    ];

    renderMePage();

    expect(await screen.findByText("Could not load redemption history from RPC.")).toBeInTheDocument();
    expect(
      screen.getByText("Public RPC may be rate-limited or temporarily unavailable. Please retry in a moment.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("No redemption signatures in the recent history window.")).toBeNull();
  });
});
