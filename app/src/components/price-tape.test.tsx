import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FEEDS } from "@/lib/feeds";
import type { FeedKey, FeedQuote } from "@/lib/types";
import { LocaleProvider } from "@/i18n/provider";

const quotesState = vi.hoisted(() => ({
  quotes: {} as Record<FeedKey, FeedQuote>,
  ready: true,
  error: null as string | null,
}));

vi.mock("@/hooks/use-feeds", () => ({
  useFeeds: () => ({
    ...quotesState,
    retry: vi.fn(),
  }),
}));

const { PricePanel } = await import("@/components/price-tape");

function seedQuotes() {
  const now = Math.floor(Date.now() / 1000);
  const prices: Record<FeedKey, number> = {
    btc: 95420.5,
    eth: 3420.15,
    sol: 215.4,
    link: 18.25,
    usdc: 1.0,
    usdt: 0.9998,
  };
  for (const f of FEEDS) {
    quotesState.quotes[f.key] = {
      key: f.key,
      price: prices[f.key],
      decimals: 8,
      publishTime: now - 5,
      counter: 1,
      available: true,
    };
  }
}

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <LocaleProvider>
        <PricePanel />
      </LocaleProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  seedQuotes();
  quotesState.ready = true;
  quotesState.error = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PricePanel", () => {
  it("renders borderless SVG logos, full names for volatile assets, and code-only for stablecoins", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        [1700003600, 99, 106, 100, 105],
        [1700000000, 98, 101, 100, 100],
      ],
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { container } = renderPanel();

    expect(screen.getByText("Bitcoin")).toBeInTheDocument();
    expect(screen.getByText("Ethereum")).toBeInTheDocument();
    expect(screen.getByText("Solana")).toBeInTheDocument();
    expect(screen.getByText("Chainlink")).toBeInTheDocument();
    expect(screen.getByText("BTC/USD")).toBeInTheDocument();
    expect(screen.getByText("USDC/USD")).toBeInTheDocument();
    expect(screen.getByText("USDT/USD")).toBeInTheDocument();
    expect(screen.queryByText(/USD Coin|Tether/i)).toBeNull();

    for (const key of ["btc", "eth", "sol", "link", "usdc", "usdt"] as const) {
      const badge = container.querySelector(`[data-asset-logo="${key}"]`);
      expect(badge).not.toBeNull();
      expect(badge?.className).not.toContain("border ");
      expect(badge?.querySelector("img")).toHaveAttribute("src", `/tokens/${key}.svg`);
    }

    // Only the 5 feeds with valid Coinbase pairs fetch sparklines; USDC never triggers a 404 request.
    await waitFor(() => {
      expect(container.querySelectorAll('[data-sparkline="true"]')).toHaveLength(5);
    });
    expect(screen.getAllByText("+5.00%")).toHaveLength(5);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(5);
    expect(urls.some((u) => u.includes("USDC-USD"))).toBe(false);
  });

  it("degrades cleanly without fabricating percentages or sparklines when /chart fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
      })
    );

    const { container } = renderPanel();

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container.querySelectorAll('[data-sparkline="true"]')).toHaveLength(0);
    expect(screen.queryByText(/0\.00%/)).toBeNull();
  });

  it("replaces stale price numbers (>30s since last client receipt) with stale state while preserving age, and restores live price on recovery", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const f of FEEDS) {
      quotesState.quotes[f.key] = {
        ...quotesState.quotes[f.key],
        publishTime: nowSec - 35,
        receivedAt: Date.now() - 35_000,
      };
    }

    const { rerender, container } = renderPanel();
    expect(container.querySelectorAll('[data-quote-stale="true"]')).toHaveLength(6);
    expect(screen.getAllByText("Quote stale — reconnecting")).toHaveLength(6);
    expect(screen.queryByText("95,420.50")).toBeNull();
    expect(screen.getAllByText("35s ago")).toHaveLength(6);

    // Quotes recover with fresh client receivedAt
    const freshNowMs = Date.now();
    for (const f of FEEDS) {
      quotesState.quotes[f.key] = {
        ...quotesState.quotes[f.key],
        publishTime: Math.floor(freshNowMs / 1000) - 2,
        receivedAt: freshNowMs,
      };
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <LocaleProvider>
          <PricePanel />
        </LocaleProvider>
      </QueryClientProvider>
    );
    expect(container.querySelectorAll('[data-quote-stale="true"]')).toHaveLength(0);
  });
});
