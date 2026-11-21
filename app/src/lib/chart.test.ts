import { describe, it, expect, vi, afterEach } from "vitest";
import { chartPair, fetchCandles } from "@/lib/chart";

describe("chartPair", () => {
  it("映射支持的 feedKey 并在未知或空值时返回 null", () => {
    expect(chartPair("btc")).toBe("BTC-USD");
    expect(chartPair("eth")).toBe("ETH-USD");
    expect(chartPair("sol")).toBe("SOL-USD");
    expect(chartPair("link")).toBe("LINK-USD");
    expect(chartPair("usdc")).toBe("USDC-USD");
    expect(chartPair("usdt")).toBe("USDT-USD");
    expect(chartPair("unknown")).toBeNull();
    expect(chartPair(null)).toBeNull();
    expect(chartPair(undefined)).toBeNull();
  });
});

describe("fetchCandles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("已过期市场使用 granularity=60 且截止于 expiry+600，结果按 time 升序排列", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          [200, 90, 110, 95, 105],
          [100, 80, 100, 85, 95],
        ]),
        { status: 200 }
      )
    );

    const expiry = 1_700_000_000;
    const candles = await fetchCandles("BTC-USD", expiry, expiry + 120);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("/chart/products/BTC-USD/candles?granularity=60");
    expect(url).toContain(encodeURIComponent(new Date((expiry + 600) * 1000).toISOString()));
    expect(candles).toEqual([
      { time: 100, low: 80, high: 100, open: 85, close: 95 },
      { time: 200, low: 90, high: 110, open: 95, close: 105 },
    ]);
  });

  it("距离到期超过 4 小时使用 granularity=300 与 23 小时回溯窗口", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );

    const now = 1_700_000_000;
    const expiry = now + 5 * 3600;
    await fetchCandles("ETH-USD", expiry, now);

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("/chart/products/ETH-USD/candles?granularity=300");
    expect(url).toContain(encodeURIComponent(new Date((now - 23 * 3600) * 1000).toISOString()));
    expect(url).toContain(encodeURIComponent(new Date(now * 1000).toISOString()));
  });

  it("距离到期 4 小时以内使用 granularity=60 与 expiry-4.5h 起点", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );

    const now = 1_700_000_000;
    const expiry = now + 2 * 3600;
    await fetchCandles("SOL-USD", expiry, now);

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("/chart/products/SOL-USD/candles?granularity=60");
    expect(url).toContain(encodeURIComponent(new Date((expiry - 4.5 * 3600) * 1000).toISOString()));
    expect(url).toContain(encodeURIComponent(new Date(now * 1000).toISOString()));
  });

  it("HTTP 非 2xx 时抛错", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status: 502 }));
    await expect(fetchCandles("BTC-USD", 1_700_001_000, 1_700_000_000)).rejects.toThrow(
      "chart fetch failed"
    );
  });
});
