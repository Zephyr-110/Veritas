import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyQuotes } from "@/lib/chainlink";
import type { FeedKey, FeedQuote } from "@/lib/types";

const feedsState = vi.hoisted(() => ({
  ready: true,
  quotes: {} as Record<FeedKey, FeedQuote>,
  retry: vi.fn(),
}));

const openWalletModal = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-feeds", () => ({
  useFeeds: () => feedsState,
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, openWalletModal };
});

const { SimOrderPreview } = await import("@/components/sim-preview");
const { LocaleProvider } = await import("@/i18n/provider");

function renderSim() {
  return render(
    <LocaleProvider>
      <SimOrderPreview />
    </LocaleProvider>
  );
}

beforeEach(() => {
  feedsState.ready = true;
  feedsState.quotes = emptyQuotes();
  feedsState.retry.mockReset();
  openWalletModal.mockReset();
});

afterEach(() => cleanup());

describe("SimOrderPreview", () => {
  it("预言机未就绪时显示骨架条", () => {
    feedsState.ready = false;
    const { container } = renderSim();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("预言机不可达时不编造假报价并提供重试", async () => {
    renderSim();
    expect(screen.getByText(/Chainlink feed accounts are currently unreachable/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(feedsState.retry).toHaveBeenCalledTimes(1);
  });

  it("拿到实时报价后明确标注模拟、实时重算份额并在提交时引导连钱包", async () => {
    feedsState.quotes.btc = {
      key: "btc",
      price: 90000,
      decimals: 8,
      publishTime: Math.floor(Date.now() / 1000) - 3,
      counter: 100,
      available: true,
    };
    feedsState.quotes.sol = {
      key: "sol",
      price: 150,
      decimals: 8,
      publishTime: Math.floor(Date.now() / 1000) - 2,
      counter: 200,
      available: true,
    };

    const { container } = renderSim();
    expect(screen.getByText("SIMULATION")).toBeInTheDocument();
    expect(screen.getByText("90,000.00")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "SOL/USD" }));
    expect(screen.getByText("150.00")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "10" }));
    expect(container.textContent).toContain("30 bps per leg (~0.6% combined)");
    expect(screen.getByText(/^\d{2}\.\d¢$/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Connect wallet to execute on-chain \(Sim\)/i }));
    expect(openWalletModal).toHaveBeenCalledTimes(1);
  });
});
