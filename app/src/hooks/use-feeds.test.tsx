import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import type { Connection } from "@solana/web3.js";
import type { FeedKey, FeedQuote } from "@/lib/types";
import { FEEDS } from "@/lib/feeds";
import { isQuoteStale, QUOTE_STALE_MS } from "@/lib/chainlink";

const chainlinkMocks = vi.hoisted(() => ({
  fetchFeedQuotes: vi.fn(),
  subscribeFeedQuotes: vi.fn(),
  connection: { rpcEndpoint: "https://mock.devnet.rpc" } as unknown as Connection,
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({
    connection: chainlinkMocks.connection,
  }),
}));

vi.mock("@/lib/chainlink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chainlink")>();
  return {
    ...actual,
    fetchFeedQuotes: chainlinkMocks.fetchFeedQuotes,
    subscribeFeedQuotes: chainlinkMocks.subscribeFeedQuotes,
  };
});

const { POLL_MS, WATCHDOG_CHECK_MS, resetFeedsForTests, useFeeds } = await import("@/hooks/use-feeds");

function makeQuotes(nowMs: number, publishTimeSec: number): Record<FeedKey, FeedQuote> {
  const out = {} as Record<FeedKey, FeedQuote>;
  for (const f of FEEDS) {
    out[f.key] = {
      key: f.key,
      price: 60_000,
      decimals: 8,
      publishTime: publishTimeSec,
      counter: 1,
      available: true,
      receivedAt: nowMs,
    };
  }
  return out;
}

function emptyMockQuotes(): Record<FeedKey, FeedQuote> {
  const out = {} as Record<FeedKey, FeedQuote>;
  for (const f of FEEDS) {
    out[f.key] = {
      key: f.key,
      price: null,
      decimals: 8,
      publishTime: null,
      counter: null,
      available: false,
      receivedAt: null,
    };
  }
  return out;
}

describe("isQuoteStale", () => {
  it("uses client receivedAt > 30s rather than Chainlink publishTime", () => {
    const nowMs = 1_800_000_000_000;
    const quietLive: FeedQuote = {
      key: "btc",
      price: 60_000,
      decimals: 8,
      publishTime: Math.floor(nowMs / 1000) - 120,
      counter: 10,
      available: true,
      receivedAt: nowMs - 5_000,
    };
    expect(isQuoteStale(quietLive, nowMs)).toBe(false);
    expect(isQuoteStale({ ...quietLive, receivedAt: nowMs - QUOTE_STALE_MS }, nowMs)).toBe(false);
    expect(isQuoteStale({ ...quietLive, receivedAt: nowMs - QUOTE_STALE_MS - 1 }, nowMs)).toBe(true);
    expect(isQuoteStale({ ...quietLive, receivedAt: null }, nowMs)).toBe(true);
    expect(isQuoteStale({ ...quietLive, available: false }, nowMs)).toBe(true);
  });
});

describe("useFeeds watchdog & self-healing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    resetFeedsForTests();
    chainlinkMocks.fetchFeedQuotes.mockReset();
    chainlinkMocks.subscribeFeedQuotes.mockReset();
  });

  afterEach(() => {
    cleanup();
    resetFeedsForTests();
    vi.useRealTimers();
  });

  it("forces a poll after 30s without quotes, rebuilds WS+poll if still failing, and clears error on recovery", async () => {
    const unsubs: Array<ReturnType<typeof vi.fn>> = [];

    chainlinkMocks.subscribeFeedQuotes.mockImplementation((_conn, onChange) => {
      const unsub = vi.fn();
      unsubs.push(unsub);
      if (unsubs.length === 1) {
        onChange(makeQuotes(Date.now(), Math.floor(Date.now() / 1000) - 2));
      }
      return unsub;
    });
    let pollsFail = false;
    chainlinkMocks.fetchFeedQuotes.mockImplementation(async () => {
      if (pollsFail) throw new Error("RPC timeout");
      return emptyMockQuotes();
    });

    let latest!: ReturnType<typeof useFeeds>;
    function Harness() {
      latest = useFeeds();
      return null;
    }
    render(<Harness />);

    expect(chainlinkMocks.subscribeFeedQuotes).toHaveBeenCalledTimes(1);
    expect(latest.ready).toBe(true);
    expect(latest.error).toBeNull();
    const initialReceived = latest.lastReceivedAt!;
    expect(initialReceived).toBe(Date.now());

    // Stream & poll go silent > 30s
    pollsFail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTE_STALE_MS + WATCHDOG_CHECK_MS);
    });

    expect(unsubs[0]).toHaveBeenCalledTimes(1);
    expect(chainlinkMocks.subscribeFeedQuotes).toHaveBeenCalledTimes(2);
    expect(latest.error).not.toBeNull();

    // Recovery: fresh quotes arrive -> error clears and quote becomes live again
    pollsFail = false;
    chainlinkMocks.fetchFeedQuotes.mockResolvedValue(
      makeQuotes(Date.now(), Math.floor(Date.now() / 1000))
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(latest.error).toBeNull();
    expect(latest.lastReceivedAt).toBeGreaterThan(initialReceived);
    expect(isQuoteStale(latest.quotes.btc, Date.now())).toBe(false);
  });

  it("handles WS error/disconnect without silent death, rebuilds subscription, and recovers", async () => {
    const unsubs: Array<ReturnType<typeof vi.fn>> = [];
    let emitWsError!: (err: unknown) => void;

    chainlinkMocks.subscribeFeedQuotes.mockImplementation((_conn, onChange, onError) => {
      const unsub = vi.fn();
      unsubs.push(unsub);
      emitWsError = onError;
      onChange(makeQuotes(Date.now(), Math.floor(Date.now() / 1000)));
      return unsub;
    });
    chainlinkMocks.fetchFeedQuotes.mockRejectedValueOnce(new Error("poll failed during disconnect"));

    let latest!: ReturnType<typeof useFeeds>;
    function Harness() {
      latest = useFeeds();
      return null;
    }
    render(<Harness />);

    await act(async () => {
      emitWsError(new Error("WebSocket closed"));
      await Promise.resolve();
    });

    expect(unsubs[0]).toHaveBeenCalledTimes(1);
    expect(chainlinkMocks.subscribeFeedQuotes).toHaveBeenCalledTimes(2);
    expect(latest.error).toBeNull();
  });
});
