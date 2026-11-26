import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen, cleanup } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { markTxRefresh } from "@/hooks/use-markets";

vi.mock("@solana/wallet-adapter-react", () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  WalletProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useConnection: () => ({ connection: { rpcEndpoint: "https://api.devnet.solana.com" } }),
  useWallet: () => ({ publicKey: null, connected: false }),
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { Providers, useRefresh } = await import("@/components/providers");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Probe() {
  const { nonce, bump } = useRefresh();
  return (
    <button type="button" onClick={bump}>
      nonce:{nonce}
    </button>
  );
}

describe("Providers refresh invalidation", () => {
  it("bump() increments nonce and invalidates markets, market, positions, and redemptions across all mounted/cached queries", async () => {
    const spy = vi
      .spyOn(QueryClient.prototype, "invalidateQueries")
      .mockResolvedValue(undefined);

    render(
      <Providers>
        <Probe />
      </Providers>
    );

    const btn = screen.getByRole("button", { name: "nonce:0" });
    await act(async () => {
      btn.click();
    });

    expect(screen.getByRole("button", { name: "nonce:1" })).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["markets"], refetchType: "all" });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["market"], refetchType: "all" });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["position"], refetchType: "all" });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["positions"], refetchType: "all" });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["redemptions"], refetchType: "all" });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["sandbox-balance"], refetchType: "all" });
    expect(typeof markTxRefresh).toBe("function");
  });

  it("schedules follow-up position & balance invalidations after confirmation to cover Devnet RPC lag", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(QueryClient.prototype, "invalidateQueries")
      .mockResolvedValue(undefined);

    render(
      <Providers>
        <Probe />
      </Providers>
    );

    const btn = screen.getByRole("button", { name: "nonce:0" });
    await act(async () => {
      btn.click();
    });

    const initialCalls = spy.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(spy.mock.calls.length).toBeGreaterThan(initialCalls);

    const midCalls = spy.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(spy.mock.calls.length).toBeGreaterThan(midCalls);
    vi.useRealTimers();
  });
});
