import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublicKey } from "@solana/web3.js";
import type { MarketView, UserPosition } from "@/lib/markets";
import { applySlippage, pmAmmReservesFromPrice, quoteBet, quoteSwapDetail, quoteSwapOut } from "@/lib/quote";
import { DEFAULT_COLLATERAL_MINT, DEFAULT_SLIPPAGE_BPS } from "@/lib/constants";
import { formatFixed } from "@/lib/format";

// ---- 依赖替身：只替换外部链路，保留真实业务计算与真实渲染 ----
const wallet = vi.hoisted(() => ({ publicKey: null as PublicKey | null }));
const walletBalanceState = vi.hoisted(() => ({
  data: null as { usdtAtoms: bigint; usdtDecimals: number; solLamports: number } | null,
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({ publicKey: wallet.publicKey, connected: !!wallet.publicKey }),
  useConnection: () => ({ connection: undefined }),
}));

vi.mock("@/hooks/use-wallet-balance", () => ({
  useWalletBalance: () => ({
    data: walletBalanceState.data,
    loading: false,
    refreshing: false,
    stale: false,
    updatedAt: walletBalanceState.data ? Date.now() : null,
    error: null,
    isSandbox: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-program", () => ({
  useProgram: () => ({}), // 真值表示程序已就绪
}));

// 指令构造器单独有 instructions.test.ts 的参数级测试；这里只验证
// TradeDesk 传给它的金额/方向/minOut 是否正确。
const ixBet = vi.hoisted(() => vi.fn());
const ixSwap = vi.hoisted(() => vi.fn());
vi.mock("@/lib/instructions", () => ({ ixUserBetOn: ixBet, ixSwap }));

vi.mock("@/components/faucet-claim", () => ({
  FaucetClaimButton: () => <button type="button">faucet</button>,
}));

const run = vi.hoisted(() => vi.fn());
const openWalletModal = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, useTx: () => ({ busy: false, run }), openWalletModal };
});

const { TradeDesk } = await import("@/components/trade-desk");
const { LocaleProvider } = await import("@/i18n/provider");
const { setLocale } = await import("@/i18n/store");

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
    collateral: 10_000_000n, // 10 USDT
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
      <TradeDesk market={market} position={position} />
    </LocaleProvider>
  );
}

/** 提交按钮始终是 DOM 中最后一个 button（SegTabs 的 tab 会与它同名） */
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
  walletBalanceState.data = null;
  ixBet.mockReset();
  ixBet.mockResolvedValue([]);
  ixSwap.mockReset();
  ixSwap.mockResolvedValue([]);
  run.mockReset();
  openWalletModal.mockReset();
  // 执行回调，让 submit 里真正的指令构造路径跑到
  run.mockImplementation(async (_label: string, build: () => Promise<unknown>) => {
    await build();
    return null;
  });
});

afterEach(() => {
  cleanup();
  setLocale("en");
});

describe("TradeDesk 下单前置校验", () => {
  it("未连接钱包：进入模拟预览，使用实时储备算报价并在点击提交时引导连钱包", async () => {
    wallet.publicKey = null;
    const market = makeMarket();
    const { container } = renderDesk(market);
    expect(screen.getByText("SIMULATION")).toBeInTheDocument();
    expect(submitBtn()).toBeEnabled();
    expect(submitBtn()).toHaveTextContent("Connect wallet to Buy YES (Sim)");

    const expected = formatFixed(quoteBet(market.reserveYes, market.reserveNo, 2_000_000n, "yes").totalOut, market.decimals, 2);
    expect(container.querySelector(".desk")!.textContent).toContain(expected);

    await userEvent.click(submitBtn());
    expect(openWalletModal).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("市场已过期：禁用并显示交易关闭", () => {
    renderDesk(makeMarket({ expiry: 1_600_000_000 }));
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Trading closed");
  });

  it("金额非法：提示 Enter a valid size 且禁用", async () => {
    renderDesk();
    await typeAmount("abc");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Enter a valid size");
  });

  it("金额为 0：提示 Enter a size", async () => {
    renderDesk();
    await typeAmount("0");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Enter a size");
  });

  it("金额超过 USDT 余额：提示余额不足", async () => {
    renderDesk(makeMarket(), makePosition({ collateral: 1_000_000n }));
    await typeAmount("5");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Insufficient USDT");
  });

  it("条件齐备时可提交，文案为 Buy YES", async () => {
    renderDesk();
    await typeAmount("2");
    expect(submitBtn()).toBeEnabled();
    expect(submitBtn()).toHaveTextContent("Buy YES");
  });

  it("切到 NO 后提交文案跟随", async () => {
    renderDesk();
    await userEvent.click(screen.getByRole("button", { name: "Buy NO" }));
    await typeAmount("2");
    expect(submitBtn()).toBeEnabled();
    expect(submitBtn()).toHaveTextContent("Buy NO");
  });

  it("余额为 0 时展示水龙头入口", () => {
    renderDesk(makeMarket(), makePosition({ collateral: 0n }));
    expect(screen.getByRole("button", { name: "faucet" })).toBeInTheDocument();
  });
});

describe("TradeDesk 报价展示", () => {
  it("输入金额后 Receive 显示与 quoteBet 一致的输出量", async () => {
    const market = makeMarket();
    const { container } = renderDesk(market);
    await typeAmount("10");

    const expected = quoteBet(market.reserveYes, market.reserveNo, 10_000_000n, "yes").totalOut;
    const shown = formatFixed(expected, market.decimals, 2);
    // StableText 会同时渲染双语（一种 aria-hidden），所以按面板文本断言
    expect(shown).not.toBe("0.00");
    expect(container.querySelector(".desk")!.textContent).toContain(shown);
  });

  it("池子极浅 / 大单时给出价格冲击警告", async () => {
    // 拿池子的一半（50 USDT）砸 100/100 的池子，均价必然显著高于现价
    renderDesk(makeMarket(), makePosition({ collateral: 100_000_000n }));
    await typeAmount("50");

    const out = quoteBet(100_000_000n, 100_000_000n, 50_000_000n, "yes").totalOut;
    const avgCents = (Number(50_000_000n) / Number(out)) * 100;
    const impact = (avgCents / (0.5 * 100) - 1) * 100;
    expect(impact).toBeGreaterThan(10); // 前提成立，UI 才应该警告
    expect(screen.getByText(/Shallow pool/)).toBeInTheDocument();
  });

  it("小额下单不出现冲击警告", async () => {
    renderDesk();
    await typeAmount("1");
    expect(screen.queryByText(/Shallow pool/)).toBeNull();
  });
});

describe("TradeDesk 卖出（swap）分支", () => {
  // 合约语义：token_type 是"目标方"，No → Yes 即用 NO 换 YES
  it("换到 YES 时用 NO 余额判定；没有 NO 则禁用并提示 Insufficient NO", async () => {
    renderDesk(makeMarket(), makePosition({ yes: 10_000_000n, no: 0n }));
    await userEvent.click(screen.getByRole("button", { name: "Swap" }));
    await typeAmount("1");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Insufficient NO");
  });

  it("换到 NO 时用 YES 余额判定；没有 YES 则提示 Insufficient YES", async () => {
    renderDesk(makeMarket(), makePosition({ yes: 0n, no: 10_000_000n }));
    await userEvent.click(screen.getByRole("button", { name: "Swap" }));
    await userEvent.click(screen.getByRole("button", { name: "Buy NO" }));
    await typeAmount("1");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Insufficient YES");
  });

  it("持有 NO 且数量足够时可提交换到 YES", async () => {
    renderDesk(makeMarket(), makePosition({ yes: 0n, no: 5_000_000n }));
    await userEvent.click(screen.getByRole("button", { name: "Swap" }));
    await typeAmount("1");
    expect(submitBtn()).toBeEnabled();
  });
});

describe("TradeDesk 提交", () => {
  it("点击提交会调用 run 一次", async () => {
    renderDesk();
    await typeAmount("2");
    await userEvent.click(submitBtn());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("买入 YES：金额、方向与滑点后的 minOut 传参正确", async () => {
    const market = makeMarket();
    renderDesk(market);
    await typeAmount("2");
    await userEvent.click(submitBtn());

    const expected = applySlippage(
      quoteBet(market.reserveYes, market.reserveNo, 2_000_000n, "yes").swapOut,
      DEFAULT_SLIPPAGE_BPS
    );
    await waitFor(() => expect(ixBet).toHaveBeenCalledTimes(1));
    expect(ixBet).toHaveBeenCalledWith({}, market, wallet.publicKey, {
      collateralAmount: 2_000_000n,
      tokenType: "yes",
      minOut: expected,
    });
    expect(ixSwap).not.toHaveBeenCalled();
  });

  it("买入 NO：方向与报价都取 NO 一侧", async () => {
    const market = makeMarket();
    renderDesk(market);
    await userEvent.click(screen.getByRole("button", { name: "Buy NO" }));
    await typeAmount("3");
    await userEvent.click(submitBtn());

    const expected = applySlippage(
      quoteBet(market.reserveYes, market.reserveNo, 3_000_000n, "no").swapOut,
      DEFAULT_SLIPPAGE_BPS
    );
    await waitFor(() => expect(ixBet).toHaveBeenCalled());
    expect(ixBet.mock.calls[0][3]).toEqual({
      collateralAmount: 3_000_000n,
      tokenType: "no",
      minOut: expected,
    });
  });

  it("滑点滑杆直接改变 minOut（500 bps → 95%）", async () => {
    const market = makeMarket();
    renderDesk(market);
    await typeAmount("2");

    fireEvent.change(screen.getByRole("slider"), { target: { value: "500" } });
    await userEvent.click(submitBtn());

    const swapOut = quoteBet(market.reserveYes, market.reserveNo, 2_000_000n, "yes").swapOut;
    await waitFor(() => expect(ixBet).toHaveBeenCalled());
    expect(ixBet.mock.calls[0][3]).toMatchObject({
      minOut: (swapOut * 9_500n) / 10_000n,
    });
  });

  it("Max 用满余额并允许提交", async () => {
    renderDesk();
    await userEvent.click(screen.getByRole("button", { name: "Max" }));

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("10");
    expect(submitBtn()).toBeEnabled();

    await userEvent.click(submitBtn());
    await waitFor(() => expect(ixBet).toHaveBeenCalled());
    expect(ixBet.mock.calls[0][3]).toMatchObject({ collateralAmount: 10_000_000n });
  });

  it("换仓提交：金额、目标方向与滑点后的 minOut 正确", async () => {
    const market = makeMarket();
    renderDesk(market, makePosition({ no: 5_000_000n }));
    await userEvent.click(screen.getByRole("button", { name: "Swap" }));
    await typeAmount("1");
    await userEvent.click(submitBtn());

    const expected = applySlippage(
      quoteSwapOut(market.reserveYes, market.reserveNo, 1_000_000n),
      DEFAULT_SLIPPAGE_BPS
    );
    await waitFor(() => expect(ixSwap).toHaveBeenCalledTimes(1));
    expect(ixSwap).toHaveBeenCalledWith({}, market, wallet.publicKey, {
      amountIn: 1_000_000n,
      tokenType: "yes",
      minOut: expected,
    });
    expect(ixBet).not.toHaveBeenCalled();
  });

  it("余额显示开关可隐藏与恢复下注区余额", async () => {
    window.localStorage.clear();
    renderDesk(makeMarket(), makePosition({ collateral: 12_500_000n }));
    expect(screen.getByText("Balance 12.50 USDT")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Hide balances" }));
    expect(screen.getByText("Balance •••• USDT")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show balances" }));
    expect(screen.getByText("Balance 12.50 USDT")).toBeInTheDocument();
  });
});

function makePmAmmMarket(
  yesPrice: number,
  overrides: Partial<MarketView> = {}
): MarketView {
  const nowSec = Math.floor(Date.now() / 1000);
  const remainSec = 900;
  const endTs = overrides.endTs ?? nowSec + remainSec;
  const lastAccrualTs = overrides.lastAccrualTs ?? nowSec;
  const tRem = Math.max(1, endTs - lastAccrualTs);
  // Target L_eff ≈ 375_994_241 (~150 USDT pool per side at P=0.5)
  const lZeroInt = BigInt(Math.round(375_994_241 / Math.sqrt(tRem)));
  const lEff = Number(lZeroInt) * Math.sqrt(tRem);
  const { yes, no } = pmAmmReservesFromPrice(yesPrice, lEff);
  return makeMarket({
    lZero: lZeroInt << 48n,
    lastAccrualTs,
    endTs,
    expiry: overrides.expiry ?? endTs,
    reserveYes: BigInt(Math.round(yes)),
    reserveNo: BigInt(Math.round(no)),
    yesPrice,
    noPrice: 1 - yesPrice,
    ...overrides,
  });
}

describe("TradeDesk 手续费估算与余额口径", () => {
  it("动态费率市场在下注区仅展示单腿费率，换仓区才展示双腿括注；P=0.5 下单估算按两腿折算 USDT 与锚点一致", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // 900s flagship market at 50% time remaining -> 123 bps/leg = 1.23% / leg
    const market = makePmAmmMarket(0.5, {
      startTs: nowSec - 450,
      endTs: nowSec + 450,
      expiry: nowSec + 450,
      lastAccrualTs: nowSec + 5,
      feeBps: 0,
    });
    renderDesk(market, makePosition({ collateral: 50_000_000n, yes: 50_000_000n, no: 50_000_000n }));
    expect(screen.getByText("Current fee")).toBeInTheDocument();
    expect(screen.getByText("1.23% / leg")).toBeInTheDocument();
    expect(screen.queryByText(/total\)/)).toBeNull();

    // 5 USDT at P=0.5, 123 bps/leg: feeIn=0.0615 NO, feeOut≈0.0595 YES -> 0.5*(feeIn+feeOut) ≈ 0.0605 -> 0.060 USDT
    await typeAmount("5");
    expect(screen.getByTestId("trade-fee-estimate")).toHaveTextContent("Fee ≈ 0.060 USDT");

    // 5 USDT anchor at P=0.5, 50 bps/leg -> 0.025 USDT (matches feeRate * principal)
    cleanup();
    const openMarket = makePmAmmMarket(0.5, {
      startTs: nowSec + 5,
      endTs: nowSec + 905,
      expiry: nowSec + 905,
      lastAccrualTs: nowSec + 5,
      feeBps: 0,
    });
    renderDesk(openMarket, makePosition({ collateral: 50_000_000n, yes: 50_000_000n, no: 50_000_000n }));
    await typeAmount("5");
    expect(screen.getByTestId("trade-fee-estimate")).toHaveTextContent("Fee ≈ 0.025 USDT");

    // Swap tab keeps the two-leg combined parenthetical and reports token-unit two-leg fees (never USDT)
    await userEvent.click(screen.getByRole("button", { name: "Swap" }));
    expect(screen.getByText(/0\.50% \/ leg \(~1\.00% total\)/)).toBeInTheDocument();
    const swapEstimate = screen.getByTestId("trade-fee-estimate").textContent ?? "";
    expect(swapEstimate).toMatch(/Fee ≈ [0-9.]+ NO \+ [0-9.]+ YES/);
    expect(swapEstimate).not.toContain("USDT");
  });

  it("Buy 页签在偏价市场按当前两侧价格折算两腿 USDT 费用，并随价格正确增减", async () => {
    // Skewed market: YES = 0.80, NO = 0.20, 100 bps/leg (1%)
    const skewedMarket = makePmAmmMarket(0.8, { feeBps: 100 });
    renderDesk(skewedMarket, makePosition({ collateral: 50_000_000n }));
    await typeAmount("5");

    // Buying expensive YES (0.80): swaps 5 NO (worth 1 USDT) -> ~0.020 USDT total fee (< 0.050 at P=0.5)
    const buyYesText = screen.getByTestId("trade-fee-estimate").textContent ?? "";
    const buyYesMatch = buyYesText.match(/Fee ≈ ([0-9.]+) USDT/);
    expect(buyYesMatch).not.toBeNull();
    const buyYesFee = Number(buyYesMatch![1]);
    expect(buyYesFee).toBeGreaterThan(0.015);
    expect(buyYesFee).toBeLessThan(0.025);

    // Buying cheap NO (0.20): swaps 5 YES (worth 4 USDT) -> ~0.077 USDT total fee (> 0.050 at P=0.5)
    await userEvent.click(screen.getByRole("button", { name: "Buy NO" }));
    const buyNoText = screen.getByTestId("trade-fee-estimate").textContent ?? "";
    const buyNoMatch = buyNoText.match(/Fee ≈ ([0-9.]+) USDT/);
    expect(buyNoMatch).not.toBeNull();
    const buyNoFee = Number(buyNoMatch![1]);
    expect(buyNoFee).toBeGreaterThan(0.06);
    expect(buyNoFee).toBeLessThan(0.09);
    expect(buyNoFee).toBeGreaterThan(buyYesFee * 3);
  });

  it("买入小额不截断为 0.00，换仓展示双腿代币符号（YES/NO 双向），且支持中英双语", async () => {
    const market = makePmAmmMarket(0.5, { feeBps: 175 });
    const pos = makePosition({ collateral: 100_000_000n, yes: 100_000_000n, no: 100_000_000n });
    const { rerender } = renderDesk(market, pos);

    // Sub-0.01 USDT must keep >= 3 decimals / sig figs, never 0.00
    await typeAmount("0.1");
    expect(screen.getByTestId("trade-fee-estimate")).toHaveTextContent("Fee ≈ 0.002 USDT");
    expect(screen.getByTestId("trade-fee-estimate").textContent).not.toContain("0.00 USDT");

    await typeAmount("0.01");
    expect(screen.getByTestId("trade-fee-estimate").textContent).toMatch(/Fee ≈ 0\.00017[0-9] USDT/);

    // Swap NO -> YES (default side=yes): shows NO (in) + YES (out), no USDT
    await userEvent.click(screen.getByRole("button", { name: "Swap" }));
    await typeAmount("10");
    const lEff = Number(market.lZero! >> 48n) * Math.sqrt(market.endTs - market.lastAccrualTs);
    const swapYes = quoteSwapDetail(market.reserveYes, market.reserveNo, 10_000_000n, lEff, 175);
    expect(swapYes.feeIn).toBe(175_000n);
    expect(swapYes.feeOut).toBeGreaterThan(0n);
    expect(screen.getByTestId("trade-fee-estimate")).toHaveTextContent(/Fee ≈ 0\.175 NO \+ 0\.16[0-9] YES/);
    expect(screen.getByTestId("trade-fee-estimate").textContent).not.toContain("USDT");

    // Swap YES -> NO (side=no): shows YES (in) + NO (out), no USDT
    await userEvent.click(screen.getByRole("button", { name: "Buy NO" }));
    expect(screen.getByTestId("trade-fee-estimate")).toHaveTextContent(/Fee ≈ 0\.175 YES \+ 0\.16[0-9] NO/);
    expect(screen.getByTestId("trade-fee-estimate").textContent).not.toContain("USDT");

    // Chinese locale for both Swap and Buy
    act(() => {
      setLocale("zh");
    });
    rerender(
      <LocaleProvider>
        <TradeDesk market={market} position={pos} />
      </LocaleProvider>
    );
    expect(screen.getByTestId("trade-fee-estimate")).toHaveTextContent(/手续费约 0\.175 YES \+ 0\.16[0-9] NO/);
    expect(screen.getByTestId("trade-fee-estimate").textContent).not.toContain("USDT");

    await userEvent.click(screen.getByRole("button", { name: "买入" }));
    await typeAmount("2");
    expect(screen.getByTestId("trade-fee-estimate")).toHaveTextContent("手续费约 0.035 USDT");
  });

  it("真实钱包场景：walletBalance 有余额且同 mint、position.collateral 为 0 时，门禁放行、Max 填入 effectiveCollateral、无领币提示", async () => {
    walletBalanceState.data = {
      usdtAtoms: 15_000_000n,
      usdtDecimals: 6,
      solLamports: 100_000_000,
    };
    const market = makeMarket({
      collateralMint: new PublicKey(DEFAULT_COLLATERAL_MINT),
    });
    renderDesk(market, makePosition({ collateral: 0n }));

    // Top displays walletBalance (15.00 USDT) and NO faucet prompt
    expect(screen.getByText("Balance 15.00 USDT")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "faucet" })).toBeNull();

    // Default 2 USDT passes order gate
    expect(submitBtn()).toBeEnabled();
    expect(submitBtn()).toHaveTextContent("Buy YES");

    // Max fills effectiveCollateral (15) and allows submit
    await userEvent.click(screen.getByRole("button", { name: "Max" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("15");
    expect(submitBtn()).toBeEnabled();

    await userEvent.click(submitBtn());
    await waitFor(() => expect(ixBet).toHaveBeenCalledTimes(1));
    expect(ixBet.mock.calls[0][3]).toMatchObject({ collateralAmount: 15_000_000n });

    // Exceeding effectiveCollateral (20 > 15) blocks with Insufficient USDT
    await typeAmount("20");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Insufficient USDT");
  });

  it("市场 collateralMint 与 settings.collateralMint 不一致时回退 position.collateral，不误用 walletBalance", async () => {
    walletBalanceState.data = {
      usdtAtoms: 50_000_000n,
      usdtDecimals: 6,
      solLamports: 100_000_000,
    };
    const otherMintMarket = makeMarket({
      collateralMint: new PublicKey(Buffer.alloc(32, 9)),
    });
    renderDesk(otherMintMarket, makePosition({ collateral: 1_000_000n }));

    expect(screen.getByText("Balance 1.00 USDT")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Max" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("1");

    await typeAmount("5");
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent("Insufficient USDT");

    // When position.collateral is 0 on a mismatched mint, faucet prompt still shows
    cleanup();
    renderDesk(otherMintMarket, makePosition({ collateral: 0n }));
    expect(screen.getByText("Balance 0.00 USDT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "faucet" })).toBeInTheDocument();
  });
});
