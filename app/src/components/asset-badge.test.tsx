import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { AssetBadge, TOKEN_LOGOS } from "@/components/asset-badge";
import type { FeedKey } from "@/lib/types";

afterEach(() => cleanup());

describe("AssetBadge", () => {
  it.each(["btc", "eth", "sol", "link"] as const)(
    "renders self-hosted static SVG logo for %s",
    (feedKey) => {
      const { container } = render(<AssetBadge feedKey={feedKey} symbol={`${feedKey.toUpperCase()}/USD`} />);
      const badge = container.querySelector(`[data-asset-logo="${feedKey}"]`);
      expect(badge).not.toBeNull();
      const img = badge?.querySelector("img");
      expect(img).not.toBeNull();
      expect(img).toHaveAttribute("src", TOKEN_LOGOS[feedKey]);
      expect(img).toHaveAttribute("alt", "");
    }
  );

  it("renders a restrained monogram fallback when feed has no logo (unknown or unmapped feed)", () => {
    const { container, rerender } = render(
      <AssetBadge feedKey={null} symbol="AVAX/USD" />
    );
    const fallback = container.querySelector('[data-asset-logo="fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback).toHaveTextContent("AV");
    expect(fallback?.querySelector("img")).toBeNull();

    rerender(<AssetBadge feedKey={"usdc" as FeedKey} symbol="USDC/USD" />);
    const usdcFallback = container.querySelector('[data-asset-logo="fallback"]');
    expect(usdcFallback).not.toBeNull();
    expect(usdcFallback).toHaveTextContent("US");
  });

  it("degrades gracefully to monogram fallback if logo image fails to load", () => {
    const { container } = render(<AssetBadge feedKey="btc" symbol="BTC/USD" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    const fallback = container.querySelector('[data-asset-logo="fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback).toHaveTextContent("BT");
  });
});
