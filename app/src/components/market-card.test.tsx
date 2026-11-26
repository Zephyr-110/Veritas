import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { LocaleProvider } from "@/i18n/provider";
import { setLocale } from "@/i18n/store";
import { FeatureCard, MarketCard } from "@/components/market-card";
import { LiveCountdown } from "@/components/live";
import type { MarketView } from "@/lib/markets";

// 只替换路由外壳，保留 <a> 的真实渲染，用于断言 href
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const wrap = (ui: ReactNode) => render(<LocaleProvider>{ui}</LocaleProvider>);

function makeMarket(overrides: Partial<MarketView> = {}): MarketView {
  const key = PublicKey.default;
  const pdas = {
    market: key,
    marketBump: 255,
    snapshot: key,
    yesMint: key,
    noMint: key,
    collateralVault: key,
    yesPool: key,
    noPool: key,
  };
  return {
    address: key,
    pdas,
    title: "BTC/USD >= 73,479 @ 2026-01-01",
    id: Array.from({ length: 16 }, () => 1),
    creator: key,
    collateralMint: key,
    yesMint: key,
    noMint: key,
    status: "open",
    winner: null,
    expiry: 2_000_000_000, // 2033，确保相对当前时间仍处于 live
    endTs: 2_000_000_000,
    finishTs: 0,
    bump: 255,
    yesPool: 0n,
    noPool: 0n,
    vault: 1_000_000_000n, // 1000 USDT @6dp
    decimals: 6,
    tokenProgram: key,
    yesPrice: 0.65,
    noPrice: 0.35,
    reserveYes: 65n,
    reserveNo: 35n,
    totalLpShares: 0n,
    ocr2State: key,
    feedKey: null,
    feedSymbol: "11111111",
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

afterEach(() => {
  cleanup();
  setLocale("en");
});

describe("FeatureCard", () => {
  it("渲染标题、赔率行与流动性", () => {
    wrap(<FeatureCard title="BTC 会上涨吗？" yesPrice={0.65} liquidity="1,000.00 USDT" />);
    expect(screen.getByText("BTC 会上涨吗？")).toBeInTheDocument();
    expect(screen.getByText(/YES 65\.0% · NO 35\.0%/)).toBeInTheDocument();
    expect(screen.getByText("1,000.00 USDT")).toBeInTheDocument();
  });

  it("标题为空时回退到 untitled 文案", () => {
    wrap(<FeatureCard title="" liquidity="0.00 USDT" />);
    expect(screen.getByText("Untitled market")).toBeInTheDocument();
  });

  it("没有 expiry 时显示破折号，有过期时间时显示日期", () => {
    const { rerender } = wrap(<FeatureCard title="t" liquidity="0.00 USDT" />);
    expect(screen.getByText("—")).toBeInTheDocument();

    rerender(
      <LocaleProvider>
        <FeatureCard title="t" liquidity="0.00 USDT" expiry={1_600_000_000} />
      </LocaleProvider>
    );
    expect(screen.getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it("状态标签跟随语言切换", () => {
    wrap(<FeatureCard title="t" liquidity="0.00 USDT" statusKey="kind.live" />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    act(() => setLocale("zh"));
    expect(screen.getByText("进行中")).toBeInTheDocument();
  });
});

describe("MarketCard", () => {
  it("链接指向 /markets/<address> 并按 vault 显示流动性", () => {
    const market = makeMarket();
    wrap(<MarketCard market={market} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", `/markets/${PublicKey.default.toBase58()}`);
    expect(screen.getByText("1000.00 USDT")).toBeInTheDocument();
  });

  it("open 且在有效期内标记为 Live", () => {
    wrap(<MarketCard market={makeMarket()} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("已裁决市场显示胜方兑付文案", () => {
    wrap(<MarketCard market={makeMarket({ status: "resolved", winner: "no" })} />);
    expect(screen.getByText("NO redeems 1:1")).toBeInTheDocument();
  });

  it("进行中市场卡片保持显示实时 AMM 报价", () => {
    wrap(<MarketCard market={makeMarket({ status: "open", yesPrice: 0.65 })} />);
    expect(screen.getByText("YES 65.0% · NO 35.0%")).toBeInTheDocument();
  });

  it("已裁决市场卡片按胜负显示 100/0 兑付百分比而非储备报价", () => {
    const { rerender } = wrap(
      <MarketCard market={makeMarket({ status: "resolved", winner: "yes", yesPrice: 0.5 })} />
    );
    expect(screen.getByText("YES 100.0% · NO 0.0%")).toBeInTheDocument();
    expect(screen.queryByText(/50\.0%/)).toBeNull();

    rerender(
      <LocaleProvider>
        <MarketCard market={makeMarket({ status: "resolved", winner: "no", yesPrice: 0.5 })} />
      </LocaleProvider>
    );
    expect(screen.getByText("YES 0.0% · NO 100.0%")).toBeInTheDocument();
    expect(screen.queryByText(/50\.0%/)).toBeNull();
  });

  it("作废市场卡片显示破折号而非 50/50 报价", () => {
    const { rerender } = wrap(
      <MarketCard
        market={makeMarket({ status: "staleBurn", winner: null, yesPrice: 0.5, expiry: 1_700_000_000 })}
      />
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/YES 50\.0%/)).toBeNull();

    rerender(
      <LocaleProvider>
        <MarketCard
          market={makeMarket({ status: "windowBurn", winner: null, yesPrice: 0.5, expiry: 1_700_000_000 })}
        />
      </LocaleProvider>
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/YES 50\.0%/)).toBeNull();
  });

  it("为 BTC/ETH/SOL/LINK 渲染自托管 logo，无 logo 的 feed 安全降级渲染", () => {
    const { container, rerender } = wrap(
      <MarketCard market={makeMarket({ feedKey: "btc", feedSymbol: "BTC/USD" })} />
    );
    expect(container.querySelector('[data-asset-logo="btc"] img')).toHaveAttribute(
      "src",
      "/tokens/btc.svg"
    );

    for (const [key, sym] of [
      ["eth", "ETH/USD"],
      ["sol", "SOL/USD"],
      ["link", "LINK/USD"],
    ] as const) {
      rerender(
        <LocaleProvider>
          <MarketCard market={makeMarket({ feedKey: key, feedSymbol: sym })} />
        </LocaleProvider>
      );
      expect(container.querySelector(`[data-asset-logo="${key}"] img`)).toHaveAttribute(
        "src",
        `/tokens/${key}.svg`
      );
    }

    rerender(
      <LocaleProvider>
        <MarketCard
          market={makeMarket({
            title: "DOGE/USD at or above 0.25 in 15 min?",
            feedKey: null,
            feedSymbol: "DOGE/USD",
          })}
        />
      </LocaleProvider>
    );
    expect(container.querySelector('[data-asset-logo="fallback"]')).toHaveTextContent("DO");
  });
});

describe("LiveCountdown", () => {
  it("按剩余时间输出 HH:MM:SS", () => {
    wrap(<LiveCountdown expiry={1000 + 3661} now={1000} />);
    const el = document.querySelector('[aria-live="polite"]');
    expect(el?.textContent).toBe("01:01:01");
  });

  it("已到期显示结束文案", () => {
    wrap(<LiveCountdown expiry={500} now={1000} />);
    const el = document.querySelector('[aria-live="polite"]');
    expect(el?.textContent).toBe("Ended");
  });
});
