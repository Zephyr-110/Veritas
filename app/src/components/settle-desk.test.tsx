import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublicKey } from "@solana/web3.js";
import { CLAIM_WINDOW, RESOLVE_WINDOW, SNAPSHOT_MAX_ENTRIES } from "@/lib/constants";
import { ConfirmedTransactionError } from "@/lib/errors";
import { FEEDS } from "@/lib/feeds";
import type { MarketView, UserPosition } from "@/lib/markets";

const USER_KEY = new PublicKey(Buffer.alloc(32, 7));
const OTHER_KEY = new PublicKey(Buffer.alloc(32, 9));

const walletState = vi.hoisted(() => ({
  publicKey: null as PublicKey | null,
  anchorWallet: null as { publicKey: PublicKey } | null,
  connection: {},
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({ publicKey: walletState.publicKey, connected: !!walletState.publicKey }),
  useConnection: () => ({ connection: walletState.connection }),
  useAnchorWallet: () => walletState.anchorWallet,
}));

vi.mock("@/hooks/use-program", () => ({
  useProgram: () => ({}),
}));

const bump = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
const clearMarketErrors = vi.hoisted(() => vi.fn());
vi.mock("@/components/providers", () => ({
  useRefresh: () => ({ nonce: 0, bump }),
  useSettings: () => ({ settings: { cluster: "devnet" } }),
  useToasts: () => ({ push, clearMarketErrors }),
}));

const ixMergeToken = vi.hoisted(() => vi.fn());
const ixGetCollateral = vi.hoisted(() => vi.fn());
const ixResolveMarket = vi.hoisted(() => vi.fn());
const ixTakeSnapshot = vi.hoisted(() => vi.fn());
const ixVoidMarket = vi.hoisted(() => vi.fn());
const ixBurnAccount = vi.hoisted(() => vi.fn());
vi.mock("@/lib/instructions", () => ({
  ixMergeToken,
  ixGetCollateral,
  ixResolveMarket,
  ixTakeSnapshot,
  ixVoidMarket,
  ixBurnAccount,
}));

const resolveMarketWithChainlink = vi.hoisted(() => vi.fn());
const findStraddlingReports = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resolve", () => ({
  resolveMarketWithChainlink,
  findStraddlingReports,
}));

const fetchMarketSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/markets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/markets")>();
  return { ...actual, fetchMarketSnapshot };
});

const run = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, useTx: () => ({ busy: false, run }) };
});

const { SettleDesk } = await import("@/components/settle-desk");
const { LocaleProvider } = await import("@/i18n/provider");

function makeMarket(overrides: Partial<MarketView> = {}): MarketView {
  const marketKey = new PublicKey(Buffer.alloc(32, 1));
  const snapshotKey = new PublicKey(Buffer.alloc(32, 2));
  const yesMint = new PublicKey(Buffer.alloc(32, 3));
  const noMint = new PublicKey(Buffer.alloc(32, 4));
  const vault = new PublicKey(Buffer.alloc(32, 5));
  const yesPool = new PublicKey(Buffer.alloc(32, 6));
  const noPool = new PublicKey(Buffer.alloc(32, 8));
  const collateralMint = new PublicKey(Buffer.alloc(32, 10));
  return {
    address: marketKey,
    pdas: {
      market: marketKey,
      marketBump: 255,
      snapshot: snapshotKey,
      yesMint,
      noMint,
      collateralVault: vault,
      yesPool,
      noPool,
    },
    title: "BTC/USD >= 73,479",
    id: Array.from({ length: 16 }, () => 1),
    creator: USER_KEY,
    collateralMint,
    yesMint,
    noMint,
    status: "open",
    winner: null,
    expiry: 2_000_000_000,
    startTs: 1_999_999_100,
    endTs: 2_000_000_000,
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

function renderDesk(market = makeMarket(), position = makePosition()) {
  return render(
    <LocaleProvider>
      <SettleDesk market={market} position={position} />
    </LocaleProvider>
  );
}

beforeEach(() => {
  walletState.publicKey = USER_KEY;
  walletState.anchorWallet = { publicKey: USER_KEY };
  ixMergeToken.mockReset().mockResolvedValue([]);
  ixGetCollateral.mockReset().mockResolvedValue([]);
  ixTakeSnapshot.mockReset().mockResolvedValue([]);
  ixVoidMarket.mockReset().mockResolvedValue([]);
  ixBurnAccount.mockReset().mockResolvedValue([]);
  findStraddlingReports.mockReset().mockResolvedValue({ pre: {}, post: {}, hasSnapshot: false });
  resolveMarketWithChainlink.mockReset().mockResolvedValue("resolve-sig-1");
  fetchMarketSnapshot.mockReset().mockResolvedValue(null);
  bump.mockReset();
  push.mockReset();
  clearMarketErrors.mockReset();
  run.mockReset().mockImplementation(async (_label: string, build: () => Promise<unknown>) => {
    await build();
    return null;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SettleDesk 合并与兑付", () => {
  it("双边合并（Merge）：按 min(yes, no) 显示 Merge 3 USDT 并调用 ixMergeToken", async () => {
    const market = makeMarket({ status: "open" });
    renderDesk(market, makePosition({ yes: 3_000_000n, no: 5_000_000n }));

    const btn = screen.getByRole("button", { name: "Merge 3.00 USDT" });
    await userEvent.click(btn);
    await waitFor(() => expect(ixMergeToken).toHaveBeenCalledTimes(1));
    expect(ixMergeToken).toHaveBeenCalledWith({}, market, USER_KEY, 3_000_000n);
  });

  it("胜方领奖（Claim Winner）：持有胜方 YES 渲染 Redeem 4 USDT 并调用 ixGetCollateral", async () => {
    const market = makeMarket({ status: "resolved", winner: "yes" });
    renderDesk(market, makePosition({ yes: 4_000_000n, no: 9_000_000n }));

    const btn = screen.getByRole("button", { name: "Redeem 4.00 USDT" });
    await userEvent.click(btn);
    await waitFor(() => expect(ixGetCollateral).toHaveBeenCalledTimes(1));
    expect(ixGetCollateral).toHaveBeenCalledWith(
      {},
      market,
      USER_KEY,
      market.pdas.yesMint,
      4_000_000n
    );
  });

  it("胜方领奖：仅持有败方代币时不渲染领奖按钮", () => {
    const market = makeMarket({ status: "resolved", winner: "yes" });
    renderDesk(market, makePosition({ yes: 0n, no: 9_000_000n }));
    expect(screen.queryByRole("button", { name: /Redeem/ })).toBeNull();
  });
});

describe("SettleDesk 作废半价退款（VoidClaim）", () => {
  it("默认向下取偶数份额并按半价折算，提交调用 ixGetCollateral", async () => {
    const market = makeMarket({ status: "windowBurn", finishTs: 1_900_000_000 });
    renderDesk(market, makePosition({ yes: 5_000_001n, no: 0n }));

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("5");

    const redeemBtn = screen.getByRole("button", { name: "Redeem 2.50 USDT" });
    expect(redeemBtn).toBeEnabled();
    await userEvent.click(redeemBtn);

    await waitFor(() => expect(ixGetCollateral).toHaveBeenCalledTimes(1));
    expect(ixGetCollateral).toHaveBeenCalledWith(
      {},
      market,
      USER_KEY,
      market.pdas.yesMint,
      5_000_000n
    );
  });

  it("输入 0 或切到无余额的一侧时重置金额并禁用按钮", async () => {
    const market = makeMarket({ status: "staleBurn", finishTs: 1_900_000_000 });
    renderDesk(market, makePosition({ yes: 5_000_000n, no: 0n }));

    const input = screen.getByRole("textbox") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "0");
    expect(screen.getByRole("button", { name: /Redeem 0\.00 USDT/ })).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, "2");
    await userEvent.click(screen.getByRole("button", { name: "Redeem NO" }));
    expect(input.value).toBe("0");
    expect(screen.getByRole("button", { name: /Redeem 0\.00 USDT/ })).toBeDisabled();
  });

  it("切换 YES/NO 时将金额重置为新一侧的平额", async () => {
    const market = makeMarket({ status: "staleBurn", finishTs: 1_900_000_000 });
    const { container } = renderDesk(
      market,
      makePosition({ yes: 5_000_001n, no: 2_000_001n })
    );

    expect(container.querySelector("#settle-claim")).not.toBeNull();
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("5");
    expect(screen.getByRole("button", { name: "Redeem 2.50 USDT" })).toBeEnabled();

    await userEvent.clear(input);
    await userEvent.type(input, "4");
    await userEvent.click(screen.getByRole("button", { name: "Redeem YES" }));
    expect(input.value).toBe("4");
    await userEvent.click(screen.getByRole("button", { name: "Redeem NO" }));
    expect(input.value).toBe("2");
    expect(screen.getByRole("button", { name: "Redeem 1.00 USDT" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Redeem YES" }));
    expect(input.value).toBe("5");
    expect(screen.getByRole("button", { name: "Redeem 2.50 USDT" })).toBeEnabled();
  });

  it("索引补记作废（status=windowBurn 且 finishTs=0）不渲染可点击的半价兑付入口", () => {
    const market = makeMarket({ status: "windowBurn", finishTs: 0 });
    renderDesk(market, makePosition({ yes: 6_000_000n, no: 4_000_000n }));
    expect(screen.queryByRole("button", { name: /Redeem/ })).toBeNull();
  });
});

describe("SettleDesk 到期快照（SnapshotCard）", () => {
  it("处于 ±10s 快照窗口内渲染记录计数并调用 ixTakeSnapshot", async () => {
    const now = Math.floor(Date.now() / 1000);
    const market = makeMarket({
      status: "open",
      expiry: now + 60,
      endTs: now + 5,
    });
    fetchMarketSnapshot.mockResolvedValue({
      entries: [
        { epoch: 1, round: 1, counter: 1, price: 0n, ts: 0n },
        { epoch: 1, round: 2, counter: 2, price: 0n, ts: 0n },
      ],
      bump: 255,
    });

    renderDesk(market);
    expect(
      await screen.findByText(`2 / ${SNAPSHOT_MAX_ENTRIES} entries recorded`)
    ).toBeInTheDocument();

    const btn = screen.getByRole("button", { name: "Take snapshot" });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);

    await waitFor(() => expect(ixTakeSnapshot).toHaveBeenCalledTimes(1));
    const feedArg = ixTakeSnapshot.mock.calls[0][3] as PublicKey;
    expect(feedArg.equals(new PublicKey(FEEDS[0].feed))).toBe(true);
  });

  it("快照已满 16 条时禁用拍摄按钮", async () => {
    const now = Math.floor(Date.now() / 1000);
    const market = makeMarket({
      status: "open",
      expiry: now + 60,
      endTs: now + 5,
    });
    fetchMarketSnapshot.mockResolvedValue({
      entries: Array.from({ length: SNAPSHOT_MAX_ENTRIES }, (_, i) => ({
        epoch: 1,
        round: i + 1,
        counter: i + 1,
        price: 0n,
        ts: 0n,
      })),
      bump: 255,
    });

    renderDesk(market);
    expect(
      await screen.findByText(`${SNAPSHOT_MAX_ENTRIES} / ${SNAPSHOT_MAX_ENTRIES} entries recorded`)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take snapshot" })).toBeDisabled();
  });
});

describe("SettleDesk 裁决与超时作废", () => {
  it("48h 裁决窗口内：Submit settlement 可用且 Void market 禁用；成功与失败均触发对应 toast", async () => {
    const now = Math.floor(Date.now() / 1000);
    const market = makeMarket({ status: "open", expiry: now - 100, endTs: now - 100 });
    renderDesk(market);

    const resolveBtn = screen.getByRole("button", { name: "Submit settlement" });
    const voidBtn = screen.getByRole("button", { name: "Void market" });
    await waitFor(() => expect(resolveBtn).toBeEnabled());
    expect(voidBtn).toBeDisabled();

    await userEvent.click(resolveBtn);
    await waitFor(() => expect(resolveMarketWithChainlink).toHaveBeenCalledTimes(1));
    const expectedMeta = { marketAddress: market.address.toBase58(), action: "resolve" };
    expect(push).toHaveBeenCalledWith(
      "ok",
      "Submit settlement",
      "View transaction",
      "https://explorer.solana.com/tx/resolve-sig-1?cluster=devnet",
      expectedMeta
    );
    expect(bump).toHaveBeenCalledTimes(1);

    resolveMarketWithChainlink.mockRejectedValueOnce(new Error("429 rate limit"));
    await userEvent.click(resolveBtn);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    expect(push).toHaveBeenLastCalledWith(
      "info",
      "Submit settlement",
      "errors.rpcRate",
      undefined,
      expectedMeta
    );
    resolveMarketWithChainlink.mockRejectedValueOnce(new ConfirmedTransactionError());
    await userEvent.click(resolveBtn);
    await waitFor(() =>
      expect(push).toHaveBeenLastCalledWith(
        "err",
        "Submit settlement failed",
        "errors.txFailed",
        undefined,
        expectedMeta
      )
    );
  });

  it("市场状态从 open 变为 resolved 或 windowBurn 时清除该市场的待处理错误 toast", () => {
    const openMarket = makeMarket({ status: "open" });
    const { rerender } = render(
      <LocaleProvider>
        <SettleDesk market={openMarket} position={makePosition()} />
      </LocaleProvider>
    );
    expect(clearMarketErrors).not.toHaveBeenCalled();

    rerender(
      <LocaleProvider>
        <SettleDesk
          market={makeMarket({ status: "resolved", winner: "yes" })}
          position={makePosition({ yes: 2_000_000n })}
        />
      </LocaleProvider>
    );
    expect(clearMarketErrors).toHaveBeenCalledTimes(1);
    expect(clearMarketErrors).toHaveBeenCalledWith(openMarket.address.toBase58());
  });

  it("keeps settlement disabled while the first post-expiry report is unavailable", async () => {
    findStraddlingReports.mockRejectedValue(new Error("errors.ocr2NoPostReport"));
    const endTs = Math.floor(Date.now() / 1000) - 100;
    renderDesk(makeMarket({ expiry: endTs, endTs }));
    await waitFor(() => expect(findStraddlingReports).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Submit settlement" })).toBeDisabled();
    expect(screen.getByText(/waiting for the first/i)).toBeVisible();
    expect(push).not.toHaveBeenCalled();
  });

  it("就绪轮询按 4s -> 8s -> 15s 退避，就绪后立即停止", async () => {
    vi.useFakeTimers();
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    findStraddlingReports
      .mockRejectedValueOnce(new Error("errors.ocr2NoPostReport"))
      .mockRejectedValueOnce(new Error("errors.ocr2NoPostReport"))
      .mockRejectedValueOnce(new Error("errors.ocr2NoPostReport"))
      .mockRejectedValueOnce(new Error("errors.ocr2NoPostReport"))
      .mockResolvedValueOnce({ pre: {}, post: {}, hasSnapshot: false });
    const endTs = Math.floor(Date.now() / 1000) - 100;
    renderDesk(makeMarket({ expiry: endTs, endTs }));

    await advance(0);
    expect(findStraddlingReports).toHaveBeenCalledTimes(1);

    await advance(3999);
    expect(findStraddlingReports).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(findStraddlingReports).toHaveBeenCalledTimes(2);

    await advance(7999);
    expect(findStraddlingReports).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(findStraddlingReports).toHaveBeenCalledTimes(3);

    await advance(14_999);
    expect(findStraddlingReports).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(findStraddlingReports).toHaveBeenCalledTimes(4);

    await advance(14_999);
    expect(findStraddlingReports).toHaveBeenCalledTimes(4);
    await advance(1);
    expect(findStraddlingReports).toHaveBeenCalledTimes(5);
    expect(screen.getByRole("button", { name: "Submit settlement" })).toBeEnabled();

    await advance(60_000);
    expect(findStraddlingReports).toHaveBeenCalledTimes(5);
  });

  it("组件卸载时立即停止就绪轮询", async () => {
    vi.useFakeTimers();
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    findStraddlingReports.mockRejectedValue(new Error("errors.ocr2NoPostReport"));
    const endTs = Math.floor(Date.now() / 1000) - 100;
    const { unmount } = renderDesk(makeMarket({ expiry: endTs, endTs }));

    await advance(0);
    expect(findStraddlingReports).toHaveBeenCalledTimes(1);

    unmount();
    await advance(60_000);
    expect(findStraddlingReports).toHaveBeenCalledTimes(1);
  });

  it("超过 48h 裁决窗口：Submit settlement 禁用，Void market 可用并调用 ixVoidMarket", async () => {
    const now = Math.floor(Date.now() / 1000);
    const market = makeMarket({
      status: "open",
      expiry: now - RESOLVE_WINDOW - 100,
      endTs: now - RESOLVE_WINDOW - 100,
    });
    renderDesk(market);

    expect(screen.getByRole("button", { name: "Submit settlement" })).toBeDisabled();
    const voidBtn = screen.getByRole("button", { name: "Void market" });
    expect(voidBtn).toBeEnabled();
    expect(screen.getByText(/48-hour settlement window has closed/)).toBeInTheDocument();

    await userEvent.click(voidBtn);
    await waitFor(() => expect(ixVoidMarket).toHaveBeenCalledTimes(1));
    expect(ixVoidMarket).toHaveBeenCalledWith({}, market, USER_KEY);
  });

  it("v1 老盘（无 startTs）过期后不渲染可点击的结算、作废或快照按钮", () => {
    const now = Math.floor(Date.now() / 1000);
    const v1Expired = makeMarket({
      status: "open",
      startTs: undefined,
      expiry: now - 100,
      endTs: now - 100,
    });
    renderDesk(v1Expired);
    expect(screen.queryByRole("button", { name: "Submit settlement" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Void market" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take snapshot" })).toBeNull();
  });
});

describe("SettleDesk 30 天后销毁关户（Burn）", () => {
  it("过 30 天领取窗口且当前钱包为 creator 时可点击 Close & sweep", async () => {
    const now = Math.floor(Date.now() / 1000);
    const market = makeMarket({
      status: "resolved",
      winner: "yes",
      creator: USER_KEY,
      expiry: now - CLAIM_WINDOW - 200,
      finishTs: now - CLAIM_WINDOW - 100,
    });
    renderDesk(market);

    const btn = screen.getByRole("button", { name: "Close & sweep" });
    await userEvent.click(btn);
    await waitFor(() => expect(ixBurnAccount).toHaveBeenCalledTimes(1));
    expect(ixBurnAccount).toHaveBeenCalledWith({}, market, USER_KEY);
  });

  it("非 creator 钱包不展示 Close & sweep 卡片", () => {
    const now = Math.floor(Date.now() / 1000);
    const market = makeMarket({
      status: "resolved",
      winner: "yes",
      creator: OTHER_KEY,
      expiry: now - CLAIM_WINDOW - 200,
      finishTs: now - CLAIM_WINDOW - 100,
    });
    renderDesk(market);

    expect(screen.queryByRole("button", { name: "Close & sweep" })).toBeNull();
  });
});
