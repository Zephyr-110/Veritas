import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublicKey } from "@solana/web3.js";
import type { MarketView, UserPosition } from "@/lib/markets";
import { quoteAddLiquidity, quoteWithdrawLiquidity } from "@/lib/quote";
import { formatFixed } from "@/lib/format";

const wallet = vi.hoisted(() => ({ publicKey: null as PublicKey | null }));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({ publicKey: wallet.publicKey, connected: !!wallet.publicKey }),
}));

vi.mock("@/hooks/use-program", () => ({
  useProgram: () => ({}),
}));

const ixAddLiquidity = vi.hoisted(() => vi.fn());
const ixGetLiquidity = vi.hoisted(() => vi.fn());
vi.mock("@/lib/instructions", () => ({ ixAddLiquidity, ixGetLiquidity }));

const run = vi.hoisted(() => vi.fn());
const openWalletModal = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, useTx: () => ({ busy: false, run }), openWalletModal };
});

const { LpDesk } = await import("@/components/lp-desk");
const { LocaleProvider } = await import("@/i18n/provider");

function makeMarket(overrides: Partial<MarketView> = {}): MarketView {
  const key = PublicKey.default;
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
    title: "BTC/USD >= 73,479",
    id: Array.from({ length: 16 }, () => 1),
    creator: key,
    collateralMint: key,
    yesMint: key,
    noMint: key,
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
    reserveYes: 100_000_000n,
    reserveNo: 100_000_000n,
    totalLpShares: 100_000_000n,
    ocr2State: key,
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
    collateral: 10_000_000n,
    yes: 0n,
    no: 0n,
    lpShares: 5_000_000n,
    pendingYes: 0n,
    pendingNo: 0n,
    ...overrides,
  };
}

function renderDesk(market = makeMarket(), position = makePosition()) {
  return render(
    <LocaleProvider>
      <LpDesk market={market} position={position} />
    </LocaleProvider>
  );
}

function submitBtn(): HTMLElement {
  const all = screen.getAllByRole("button");
  return all[all.length - 1];
}

async function typeAmount(value: string) {
  const input = screen.getByRole("textbox");
  await userEvent.clear(input);
  await userEvent.type(input, value);
  return input;
}

beforeEach(() => {
  wallet.publicKey = new PublicKey(Buffer.alloc(32, 7));
  ixAddLiquidity.mockReset();
  ixAddLiquidity.mockResolvedValue([]);
  ixGetLiquidity.mockReset();
  ixGetLiquidity.mockResolvedValue([]);
  run.mockReset();
  openWalletModal.mockReset();
  run.mockImplementation(async (_label: string, build: () => Promise<unknown>) => {
    await build();
    return null;
  });
});

afterEach(() => cleanup());

describe("LpDesk 前置校验", () => {
  it("未连接钱包：进行中市场进入模拟预览并在提交时引导连钱包，已终局撤出模式保持禁用", async () => {
    wallet.publicKey = null;
    renderDesk();
    expect(screen.getByText("SIMULATION")).toBeInTheDocument();
    expect(submitBtn()).toBeEnabled();
    expect(submitBtn()).toHaveTextContent("Connect wallet to add liquidity (Sim)");
    await userEvent.click(submitBtn());
    expect(openWalletModal).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();

    cleanup();
    render(
      <LocaleProvider>
        <LpDesk market={makeMarket({ status: "resolved", winner: "yes" })} position={makePosition()} withdrawOnly />
      </LocaleProvider>
    );
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Connect a wallet first");
  });

  it("Add 模式：市场已过期则禁用并提示仅进行中市场可注入", () => {
    renderDesk(makeMarket({ expiry: 1_600_000_000 }));
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Only live markets accept liquidity");
  });

  it("Add 模式：金额非法提示 Enter a valid size", async () => {
    renderDesk();
    await typeAmount("abc");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Enter a valid size");
  });

  it("Add 模式：金额为 0 提示 Enter a size", async () => {
    renderDesk();
    await typeAmount("0");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Enter a size");
  });

  it("Add 模式：超出 USDT 余额提示 Insufficient USDT", async () => {
    renderDesk(makeMarket(), makePosition({ collateral: 1_000_000n }));
    await typeAmount("5");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Insufficient USDT");
  });

  it("Withdraw 模式：市场已过期仍允许撤出 LP，份额不足时禁用", async () => {
    renderDesk(
      makeMarket({ expiry: 1_600_000_000 }),
      makePosition({ lpShares: 5_000_000n })
    );
    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(submitBtn()).toBeEnabled();
    expect(submitBtn()).toHaveTextContent("Withdraw liquidity");

    await typeAmount("6");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Insufficient LP shares");
  });
});

describe("LpDesk 报价展示与指令提交", () => {
  it("Add 模式：显示与 quoteAddLiquidity 一致的 YES/NO 注入量并调用 ixAddLiquidity", async () => {
    const market = makeMarket({
      reserveYes: 300_000_000n,
      reserveNo: 100_000_000n,
      totalLpShares: 100_000_000n,
    });
    const { container } = renderDesk(market, makePosition({ collateral: 10_000_000n }));
    await typeAmount("4");

    const q = quoteAddLiquidity(
      market.reserveYes,
      market.reserveNo,
      market.totalLpShares,
      4_000_000n
    );
    const pops = Array.from(container.querySelectorAll(".pop-num")).map((el) => el.textContent);
    expect(pops).toEqual([formatFixed(q.yesIn, market.decimals, 2), formatFixed(q.noIn, market.decimals, 2)]);

    await userEvent.click(submitBtn());
    await waitFor(() => expect(ixAddLiquidity).toHaveBeenCalledTimes(1));
    expect(ixAddLiquidity).toHaveBeenCalledWith({}, market, wallet.publicKey, 4_000_000n);
    expect(ixGetLiquidity).not.toHaveBeenCalled();
  });

  it("Withdraw 模式：按撤资份额比例折算 pending，支持 Max 填满并调用 ixGetLiquidity", async () => {
    const market = makeMarket({
      reserveYes: 200_000_000n,
      reserveNo: 300_000_000n,
      totalLpShares: 50_000_000n,
    });
    const position = makePosition({
      lpShares: 10_000_000n,
      pendingYes: 500_000n,
      pendingNo: 250_000n,
    });
    const { container } = renderDesk(market, position);

    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await typeAmount("3");

    const q = quoteWithdrawLiquidity(
      market.reserveYes,
      market.reserveNo,
      market.totalLpShares,
      3_000_000n,
      position.pendingYes,
      position.pendingNo,
      position.lpShares
    );
    // Partial withdraw 3 / 10 -> working (12 + 18) + 30% pending (0.15 + 0.075)
    expect(q.yesOut).toBe(12_150_000n);
    expect(q.noOut).toBe(18_075_000n);
    const pops = Array.from(container.querySelectorAll(".pop-num")).map((el) => el.textContent);
    expect(pops).toEqual([formatFixed(q.yesOut, market.decimals, 2), formatFixed(q.noOut, market.decimals, 2)]);

    await userEvent.click(submitBtn());
    await waitFor(() => expect(ixGetLiquidity).toHaveBeenCalledTimes(1));
    expect(ixGetLiquidity).toHaveBeenCalledWith({}, market, wallet.publicKey, 3_000_000n);
    expect(ixAddLiquidity).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Max" }));
    const input = screen.getByRole("textbox", { name: "Withdraw" }) as HTMLInputElement;
    expect(input.value).toBe("10");
    const full = quoteWithdrawLiquidity(
      market.reserveYes,
      market.reserveNo,
      market.totalLpShares,
      position.lpShares,
      position.pendingYes,
      position.pendingNo,
      position.lpShares
    );
    const maxPops = Array.from(container.querySelectorAll(".pop-num")).map((el) => el.textContent);
    expect(maxPops).toEqual([formatFixed(full.yesOut, market.decimals, 2), formatFixed(full.noOut, market.decimals, 2)]);
  });

  it("已终局市场（withdrawOnly）：隐藏存入选项卡，成功撤出后显示去下方结算台 1:1 兑付指引", async () => {
    const market = makeMarket({ status: "resolved", winner: "yes", expiry: 1_600_000_000 });
    const position = makePosition({
      lpShares: 5_000_000n,
      pendingYes: 1_200_000n,
      pendingNo: 800_000n,
    });
    run.mockImplementationOnce(async (_label: string, build: () => Promise<unknown>) => {
      await build();
      return "5igTxSuccess11111111111111111111111111111111";
    });

    const { container } = render(
      <LocaleProvider>
        <LpDesk market={market} position={position} withdrawOnly />
      </LocaleProvider>
    );

    expect(container.querySelector("#lp-withdraw")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Deposit" })).toBeNull();
    expect(screen.getByText("Withdraw liquidity & pending")).toBeInTheDocument();

    await userEvent.click(submitBtn());
    await waitFor(() => expect(ixGetLiquidity).toHaveBeenCalledWith({}, market, wallet.publicKey, 2_000_000n));
    expect(
      screen.getByText(
        "Liquidity withdrawn and pending YES/NO tokens claimed. Go to the settlement desk below to redeem winning tokens 1:1 for USDT."
      )
    ).toBeInTheDocument();
  });

  it("长时间无交易后按结息重算储备预览，撤出时将释放量计入待领不低报实得", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // 15m market where 11.25m elapsed (T-t drops from 900s to 225s -> L_eff halves)
    // At P=0.5, reserves = L_eff * phi(0) ≈ L_eff * 0.39894228
    const lZeroInt = 8_355_426n; // L_eff(900) = 8_355_426 * 30 ≈ 250_662_780 -> reserves ≈ 100_000_000
    const market = makeMarket({
      status: "open",
      expiry: nowSec + 225,
      endTs: nowSec + 225,
      lastAccrualTs: nowSec - 675,
      lZero: lZeroInt << 48n,
      reserveYes: 100_000_000n,
      reserveNo: 100_000_000n,
      totalLpShares: 100_000_000n,
    });
    const position = makePosition({
      lpShares: 100_000_000n,
      pendingYes: 1_000_000n,
      pendingNo: 1_000_000n,
    });
    const { container } = renderDesk(market, position);

    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await userEvent.click(screen.getByRole("button", { name: "Max" }));

    // Full exit of 100% LP shares must conserve total working + newly released + prior pending (~101.00 each)
    const pops = Array.from(container.querySelectorAll(".pop-num")).map((el) => el.textContent);
    expect(pops).toEqual(["101.00", "101.00"]);
    // Also verify chips have no USDT suffix
    expect(pops.every((p) => !p?.includes("USDT"))).toBe(true);
  });
});
