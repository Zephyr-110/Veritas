import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen, cleanup } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { markTxRefresh } from "@/hooks/use-markets";

vi.mock("next/navigation", () => ({
  usePathname: () => "/markets",
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  WalletProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useConnection: () => ({ connection: { rpcEndpoint: "https://api.devnet.solana.com" } }),
  useWallet: () => ({ publicKey: null, connected: false }),
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { Providers, useRefresh, useToasts, MAX_ERR_TOAST_MS } = await import("@/components/providers");

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
    expect(spy).toHaveBeenCalledWith({ queryKey: ["wallet-balance"], refetchType: "all" });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["ruling-db"], refetchType: "all" });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["ruling"], refetchType: "all" });
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

function ToastProbe() {
  const { push, clearMarketErrors } = useToasts();
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          push("err", "Submit settlement failed", "errors.notOpen", undefined, {
            marketAddress: "MKT_A",
            action: "resolve",
            sticky: true,
          })
        }
      >
        push-err-a
      </button>
      <button
        type="button"
        onClick={() =>
          push("err", "Other market failed", "errors.txFailed", undefined, {
            marketAddress: "MKT_B",
            action: "resolve",
          })
        }
      >
        push-err-b
      </button>
      <button
        type="button"
        onClick={() =>
          push("ok", "Submit settlement", "Confirmed", undefined, {
            marketAddress: "MKT_A",
            action: "resolve",
          })
        }
      >
        push-ok-a
      </button>
      <button type="button" onClick={() => clearMarketErrors("MKT_A")}>
        clear-a
      </button>
    </div>
  );
}

describe("Toast lifecycle for market-bound errors", () => {
  it("clears market-bound error toasts when market status changes, without clearing other markets", async () => {
    render(
      <Providers>
        <ToastProbe />
      </Providers>
    );

    await act(async () => {
      screen.getByRole("button", { name: "push-err-a" }).click();
      screen.getByRole("button", { name: "push-err-b" }).click();
    });
    expect(screen.getByText("Submit settlement failed")).toBeInTheDocument();
    expect(screen.getByText("Other market failed")).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: "clear-a" }).click();
    });
    expect(screen.queryByText("Submit settlement failed")).toBeNull();
    expect(screen.getByText("Other market failed")).toBeInTheDocument();
  });

  it("clears pending market error toast when the same action succeeds", async () => {
    render(
      <Providers>
        <ToastProbe />
      </Providers>
    );

    await act(async () => {
      screen.getByRole("button", { name: "push-err-a" }).click();
    });
    expect(screen.getByText("Submit settlement failed")).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: "push-ok-a" }).click();
    });
    expect(screen.queryByText("Submit settlement failed")).toBeNull();
    expect(screen.getByText("Submit settlement")).toBeInTheDocument();
  });

  it("auto-dismisses error toasts within bounded lifetime even if sticky=true, and preserves manual dismiss", async () => {
    vi.useFakeTimers();
    render(
      <Providers>
        <ToastProbe />
      </Providers>
    );

    await act(async () => {
      screen.getByRole("button", { name: "push-err-a" }).click();
    });
    expect(screen.getByText("Submit settlement failed")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_ERR_TOAST_MS);
    });
    expect(screen.queryByText("Submit settlement failed")).toBeNull();

    // Manual dismiss still works immediately
    await act(async () => {
      screen.getByRole("button", { name: "push-err-b" }).click();
    });
    const alertBtn = screen.getByText("Other market failed").closest("button")!;
    await act(async () => {
      alertBtn.click();
    });
    expect(screen.queryByText("Other market failed")).toBeNull();
    vi.useRealTimers();
  });
});
