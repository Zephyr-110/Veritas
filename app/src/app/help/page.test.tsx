import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n/provider";
import { setLocale } from "@/i18n/store";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-markets", () => ({
  useMarkets: () => ({ markets: [] }),
}));

vi.mock("@/hooks/use-now", () => ({
  useNow: () => 0,
}));

vi.mock("@/components/providers", () => ({
  useToasts: () => ({ push: vi.fn() }),
}));

import HelpPage from "./page";

afterEach(() => {
  cleanup();
  setLocale("en");
});

describe("HelpPage low-threshold Solana fee breakdown", () => {
  it("renders the Solana fee comparison paragraph at the end of 01 · Low threshold", () => {
    render(
      <LocaleProvider>
        <HelpPage />
      </LocaleProvider>
    );

    const toggle = screen.getByRole("button", { name: /01 · Low threshold/i });
    fireEvent.click(toggle);

    expect(
      screen.getByText(
        "Short-duration markets on crypto prices. Anyone can open one, anyone can trade. Settlement is decided jointly by the last signed report before expiry and the first one after it, with the ruling price taken from the first report after expiry — no intermediary decides the outcome."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(/When a balance runs low, it is topped up to 0\.04 SOL and 30 test USDT \(enough to place orders and redeem\)\./)
    ).toBeInTheDocument();
    expect(screen.getByText(/1,000,001 micro-units/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "A threshold this low is only practical on Solana. Creating a market, seeding it and settling it together cost a fraction of a cent in transaction fees, so a pool of this size remains economical. At EVM gas prices, the transaction fees for the same operations would consume a substantial share of a 1 USDT pool."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Placing a bet (user_bet_on) consumes roughly 540,000–560,000 compute units per transaction, measured on devnet."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Creating a market also requires roughly 0.014 SOL of account rent, locked until the market's accounts are burned 30 days after it finalises."
      )
    ).toBeInTheDocument();
  });

  it("renders verbatim ZH account rent and bet CU disclosures in the creation/cost section", () => {
    setLocale("zh");
    render(
      <LocaleProvider>
        <HelpPage />
      </LocaleProvider>
    );

    const toggle = screen.getByRole("button", { name: /01 · 门槛低/i });
    fireEvent.click(toggle);

    expect(
      screen.getByText(
        "下单（user_bet_on）每笔交易消耗约 540,000–560,000 计算单元（devnet 实测）。"
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "创建市场另需约 0.014 SOL 的账户租金，锁定至市场完结 30 天后烧毁账户时回收。"
      )
    ).toBeInTheDocument();
  });
});
