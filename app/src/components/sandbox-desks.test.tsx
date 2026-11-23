import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublicKey } from "@solana/web3.js";
import type { MarketView, UserPosition } from "@/lib/markets";
import { FEEDS } from "@/lib/feeds";

const SANDBOX_KEY = new PublicKey(Buffer.alloc(32, 5));

const guestMock = vi.hoisted(() => ({
  hydrated: true,
  mode: "sandbox" as "sandbox" | "real" | "none",
  isReal: false,
  isSandbox: true,
  hasSavedKey: true,
  storageAvailable: true,
  keypair: null as unknown,
  sandboxPublicKey: null as PublicKey | null,
  effectivePublicKey: null as PublicKey | null,
  entering: false,
  txPending: false,
  locked: false,
  balance: { solLamports: 40_000_000, usdtAtoms: 30_000_000n, usdtDecimals: 6 },
  balanceLoading: false,
  enterSandbox: vi.fn(),
  refillSandbox: vi.fn(),
  exitSandbox: vi.fn(),
  resetSandbox: vi.fn(),
  runSandbox: vi.fn(),
  beginTx: vi.fn(),
  endTx: vi.fn(),
}));

vi.mock("@/components/guest-session", () => ({
  useGuestSession: () => guestMock,
  useEffectivePublicKey: () => guestMock.effectivePublicKey,
  useSandboxTx: () => ({ busy: guestMock.txPending, runSandbox: guestMock.runSandbox }),
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    publicKey: null,
    connected: false,
    connecting: false,
    wallet: null,
    wallets: [],
    select: vi.fn(),
    disconnect: vi.fn(),
  }),
  useConnection: () => ({
    connection: {
      rpcEndpoint: "https://api.devnet.solana.com",
      getEpochInfo: vi.fn().mockResolvedValue({ epoch: 1 }),
    },
  }),
  useAnchorWallet: () => null,
}));

vi.mock("@/hooks/use-program", () => ({
  useProgram: () => ({}),
}));

vi.mock("@/components/providers", () => ({
  useRefresh: () => ({ nonce: 0, bump: vi.fn() }),
  useSettings: () => ({
    settings: {
      rpcUrl: "https://api.devnet.solana.com",
      cluster: "devnet",
      programId: "",
      collateralMint: "",
    },
  }),
  useToasts: () => ({ push: vi.fn(), update: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/markets",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const ixUserBetOn = vi.hoisted(() => vi.fn());
const ixSwap = vi.hoisted(() => vi.fn());
const ixGetCollateral = vi.hoisted(() => vi.fn());
const ixAddLiquidity = vi.hoisted(() => vi.fn());
const ixGetLiquidity = vi.hoisted(() => vi.fn());
const ixResolveMarket = vi.hoisted(() => vi.fn());
vi.mock("@/lib/instructions", () => ({
  ixUserBetOn,
  ixSwap,
  ixGetCollateral,
  ixAddLiquidity,
  ixGetLiquidity,
  ixResolveMarket,
  ixMergeToken: vi.fn(),
  ixTakeSnapshot: vi.fn(),
  ixVoidMarket: vi.fn(),
  ixBurnAccount: vi.fn(),
}));

const findStraddlingReports = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resolve", () => ({
  resolveMarketWithChainlink: vi.fn(),
  findStraddlingReports,
}));

const fetchMarketSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/markets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/markets")>();
  return { ...actual, fetchMarketSnapshot };
});

const realRun = vi.hoisted(() => vi.fn());
const openWalletModal = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, useTx: () => ({ busy: false, run: realRun }), openWalletModal };
});

const { TradeDesk } = await import("@/components/trade-desk");
const { SettleDesk } = await import("@/components/settle-desk");
const { LpDesk } = await import("@/components/lp-desk");
const { Header } = await import("@/components/ui");
const { LocaleProvider } = await import("@/i18n/provider");

function makeMarket(overrides: Partial<MarketView> = {}): MarketView {
  const key = PublicKey.default;
  return {
    address: key,
    pdas: {
      market: key,
      marketBump: 255,
      snapshot: key,
      yesMint: new PublicKey(Buffer.alloc(32, 3)),
      noMint: new PublicKey(Buffer.alloc(32, 4)),
      collateralVault: key,
      yesPool: key,
      noPool: key,
    },
    title: "BTC/USD at or above opening price in 2 min?",
    id: Array.from({ length: 16 }, () => 1),
    creator: key,
    collateralMint: key,
    yesMint: new PublicKey(Buffer.alloc(32, 3)),
    noMint: new PublicKey(Buffer.alloc(32, 4)),
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
    tokenProgram: key,
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

function makePosition(overrides: Partial<UserPosition> = {}): UserPosition {
  return {
    collateral: 30_000_000n,
    yes: 0n,
    no: 0n,
    lpShares: 0n,
    pendingYes: 0n,
    pendingNo: 0n,
    ...overrides,
  };
}

beforeEach(() => {
  guestMock.mode = "sandbox";
  guestMock.isReal = false;
  guestMock.isSandbox = true;
  guestMock.keypair = { publicKey: SANDBOX_KEY };
  guestMock.effectivePublicKey = SANDBOX_KEY;
  guestMock.sandboxPublicKey = SANDBOX_KEY;
  guestMock.locked = false;
  guestMock.txPending = false;
  guestMock.enterSandbox.mockReset().mockResolvedValue(true);
  guestMock.refillSandbox.mockReset().mockResolvedValue(true);
  guestMock.exitSandbox.mockReset();
  guestMock.resetSandbox.mockReset().mockResolvedValue(true);
  guestMock.runSandbox.mockReset().mockImplementation(async (_label: string, build: () => Promise<unknown>) => {
    await build();
    return "sandbox-sig-1";
  });
  realRun.mockReset();
  openWalletModal.mockReset();
  ixUserBetOn.mockReset().mockResolvedValue([]);
  ixSwap.mockReset().mockResolvedValue([]);
  ixGetCollateral.mockReset().mockResolvedValue([]);
  ixAddLiquidity.mockReset().mockResolvedValue([]);
  ixGetLiquidity.mockReset().mockResolvedValue([]);
  ixResolveMarket.mockReset().mockResolvedValue([]);
  fetchMarketSnapshot.mockReset().mockResolvedValue(null);
  findStraddlingReports.mockReset().mockResolvedValue({
    pre: { raw: Buffer.from([1]) },
    post: { raw: Buffer.from([2]) },
    hasSnapshot: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("Sandbox desks & header integration", () => {
  it("TradeDesk executes user_bet_on via runSandbox without simulation banner, and guides swap to real wallet without gray-lock", async () => {
    const market = makeMarket();
    render(
      <LocaleProvider>
        <TradeDesk market={market} position={makePosition()} />
      </LocaleProvider>
    );

    expect(screen.queryByText("SIMULATION")).toBeNull();
    const allBtns = screen.getAllByRole("button");
    const submit = allBtns[allBtns.length - 1];
    expect(submit).toHaveTextContent("Buy YES");
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    await waitFor(() => expect(guestMock.runSandbox).toHaveBeenCalledTimes(1));
    expect(ixUserBetOn).toHaveBeenCalledWith({}, market, SANDBOX_KEY, expect.objectContaining({
      collateralAmount: 2_000_000n,
      tokenType: "yes",
    }));
    expect(realRun).not.toHaveBeenCalled();

    // Switch to Swap tab: stays enabled with real-wallet prompt, no insufficient-shares lock
    await userEvent.click(screen.getByRole("button", { name: "Swap" }));
    const swapBtns = screen.getAllByRole("button");
    const swapSubmit = swapBtns[swapBtns.length - 1];
    expect(swapSubmit).toBeEnabled();
    expect(swapSubmit).toHaveTextContent("Connect real wallet to swap");
    await userEvent.click(swapSubmit);
    expect(openWalletModal).toHaveBeenCalledTimes(1);
    expect(ixSwap).not.toHaveBeenCalled();
  });

  it("SettleDesk claims resolved winnings and void refunds via runSandbox, and shows polling status when expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredOpen = makeMarket({ status: "open", expiry: now - 5, endTs: now - 5 });
    const { rerender } = render(
      <LocaleProvider>
        <SettleDesk market={expiredOpen} position={makePosition({ yes: 3_000_000n })} />
      </LocaleProvider>
    );
    expect(screen.getByText(/Awaiting on-chain settlement/i)).toBeInTheDocument();
    const manualResolveBtn = screen.getByRole("button", { name: "Submit settlement now" });
    expect(manualResolveBtn).toBeEnabled();
    await userEvent.click(manualResolveBtn);
    await waitFor(() => expect(findStraddlingReports).toHaveBeenCalledTimes(1));
    expect(ixResolveMarket).toHaveBeenCalledWith(
      {},
      expiredOpen,
      SANDBOX_KEY,
      expect.objectContaining({ hasSnapshot: false })
    );

    const resolved = makeMarket({ status: "resolved", winner: "yes" });
    rerender(
      <LocaleProvider>
        <SettleDesk market={resolved} position={makePosition({ yes: 3_000_000n })} />
      </LocaleProvider>
    );
    const redeemBtn = screen.getByRole("button", { name: "Redeem 3 USDT" });
    expect(redeemBtn).toBeEnabled();
    await userEvent.click(redeemBtn);
    await waitFor(() => expect(ixGetCollateral).toHaveBeenCalledTimes(1));
    expect(ixGetCollateral).toHaveBeenCalledWith(
      {},
      resolved,
      SANDBOX_KEY,
      resolved.pdas.yesMint,
      3_000_000n
    );
    expect(realRun).not.toHaveBeenCalled();

    const voided = makeMarket({ status: "staleBurn" });
    rerender(
      <LocaleProvider>
        <SettleDesk market={voided} position={makePosition({ no: 4_000_000n })} />
      </LocaleProvider>
    );
    const voidRedeemBtn = screen.getByRole("button", { name: "Redeem 2 USDT" });
    await userEvent.click(voidRedeemBtn);
    await waitFor(() => expect(ixGetCollateral).toHaveBeenCalledTimes(2));
  });

  it("LpDesk keeps quote calculation active in sandbox mode and guides to real wallet without gray-lock", async () => {
    const market = makeMarket();
    render(
      <LocaleProvider>
        <LpDesk market={market} position={makePosition({ collateral: 0n })} />
      </LocaleProvider>
    );
    expect(screen.queryByText("SIMULATION")).toBeNull();
    const btns = screen.getAllByRole("button");
    const submit = btns[btns.length - 1];
    expect(submit).toBeEnabled();
    expect(submit).toHaveTextContent("Connect real wallet to add liquidity");
    await userEvent.click(submit);
    expect(openWalletModal).toHaveBeenCalledTimes(1);
    expect(ixAddLiquidity).not.toHaveBeenCalled();
  });

  it("Header renders low-saturation Sandbox capsule with dropdown details (full address, Solscan, reset)", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(
      <LocaleProvider>
        <Header />
      </LocaleProvider>
    );

    expect(screen.queryByRole("button", { name: /Connect wallet/i })).toBeNull();
    const capsule = screen.getByRole("button", { name: /Sandbox · .* · 30 USDT/i });
    expect(capsule).toBeInTheDocument();

    await userEvent.click(capsule);
    expect(screen.getByText("Sandbox Account (Devnet)")).toBeInTheDocument();
    expect(screen.getByText(SANDBOX_KEY.toBase58())).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Solscan/i })).toHaveAttribute(
      "href",
      `https://solscan.io/account/${SANDBOX_KEY.toBase58()}?cluster=devnet`
    );

    // Two-step confirmation for Reset sandbox
    await userEvent.click(screen.getByRole("button", { name: /Reset sandbox/i }));
    expect(guestMock.resetSandbox).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Replacing this local keypair permanently discards access/i)
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(guestMock.resetSandbox).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirm reset" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Reset sandbox/i }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
    expect(guestMock.resetSandbox).toHaveBeenCalledTimes(1);
  });
});
