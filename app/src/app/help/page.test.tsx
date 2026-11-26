import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n/provider";

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

afterEach(() => cleanup());

describe("HelpPage low-threshold Solana fee breakdown", () => {
  it("renders the Solana fee comparison paragraph at the end of 01 · Low threshold", () => {
    render(
      <LocaleProvider>
        <HelpPage />
      </LocaleProvider>
    );

    const toggle = screen.getByRole("button", { name: /01 · Low threshold/i });
    fireEvent.click(toggle);

    expect(screen.getByText(/1,000,001 micro-units/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "A threshold this low is only practical on Solana. Creating a market, seeding it and settling it together cost a fraction of a cent in transaction fees, so a pool of this size remains economical. At EVM gas prices, the transaction fees for the same operations would consume a substantial share of a 1 USDT pool."
      )
    ).toBeInTheDocument();
  });
});
