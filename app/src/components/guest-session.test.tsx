import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocaleProvider } from "@/i18n/provider";
import { hasKey } from "@/i18n/store";

const walletState = vi.hoisted(() => ({
  publicKey: null as PublicKey | null,
  connected: false,
}));

const connectionMock = vi.hoisted(() => ({
  rpcEndpoint: "https://api.devnet.solana.com",
  getBalance: vi.fn(),
  getAccountInfo: vi.fn(),
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  WalletProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useConnection: () => ({ connection: connectionMock }),
  useWallet: () => walletState,
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const sendSandboxIxsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sandbox-send", () => ({
  sendSandboxIxs: sendSandboxIxsMock,
}));

const { Providers } = await import("@/components/providers");
const {
  SANDBOX_ACTIVATE_INTERVAL_MS,
  SANDBOX_STORAGE_KEY,
  faucetErrorKey,
  useGuestSession,
  useSandboxTx,
} = await import("@/components/guest-session");

function Harness() {
  const session = useGuestSession();
  const { busy, runSandbox } = useSandboxTx();
  return (
    <div>
      <span data-testid="mode">{session.mode}</span>
      <span data-testid="eff">{session.effectivePublicKey?.toBase58() ?? "none"}</span>
      <span data-testid="sandbox">{session.sandboxPublicKey?.toBase58() ?? "none"}</span>
      <span data-testid="storage">{String(session.storageAvailable)}</span>
      <span data-testid="locked">{String(session.locked)}</span>
      <span data-testid="busy">{String(busy)}</span>
      <span data-testid="usdt">{session.balance ? session.balance.usdtAtoms.toString() : "none"}</span>
      <span data-testid="sol">{session.balance ? String(session.balance.solLamports) : "none"}</span>
      <span data-testid="stale">{String(session.balanceStale)}</span>
      <span data-testid="mode-sync">{session.balanceSyncMode}</span>
      <span data-testid="err">{session.lastError ?? "none"}</span>
      <button type="button" onClick={() => void session.enterSandbox()}>
        enter
      </button>
      <button type="button" onClick={() => session.exitSandbox()}>
        exit
      </button>
      <button type="button" onClick={() => void session.refillSandbox()}>refill</button>
      <button type="button" onClick={() => void session.resetSandbox()}>
        reset
      </button>
      <button
        type="button"
        onClick={() => {
          if (!session.effectivePublicKey) return;
          void runSandbox("Buy YES", async () => [
            new TransactionInstruction({
              keys: [],
              programId: SystemProgram.programId,
              data: Buffer.alloc(0),
            }),
          ]);
        }}
      >
        tx
      </button>
    </div>
  );
}

function renderWithProviders(ui: ReactNode) {
  return render(<Providers>{ui}</Providers>);
}

beforeEach(() => {
  localStorage.clear();
  walletState.publicKey = null;
  walletState.connected = false;
  connectionMock.getBalance.mockReset().mockResolvedValue(40_000_000);
  connectionMock.getAccountInfo.mockReset().mockResolvedValue(null);
  sendSandboxIxsMock.mockReset().mockResolvedValue("sandbox-sig-1");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GuestSessionProvider state machine", () => {
  it("enters sandbox with one click, calls atomic faucet once on rapid double-click, and preserves key across real wallet switch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, skipped: false, signature: "faucet-sig-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderWithProviders(<Harness />);
    expect(screen.getByTestId("mode")).toHaveTextContent("none");

    // Rapid double-click should only send 1 faucet request
    const enterBtn = screen.getByRole("button", { name: "enter" });
    await act(async () => {
      enterBtn.click();
      enterBtn.click();
    });

    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("sandbox"));
    const faucetCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/faucet/sandbox");
    const activateCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/sandbox/activate");
    expect(faucetCalls).toHaveLength(1);
    expect(activateCalls).toHaveLength(1);
    const sandboxAddr = screen.getByTestId("sandbox").textContent!;
    expect(sandboxAddr).not.toBe("none");
    expect(screen.getByTestId("eff")).toHaveTextContent(sandboxAddr);

    // Connecting a real wallet switches mode to real while keeping local secretKey intact
    const realPk = new PublicKey(Buffer.alloc(32, 9));
    walletState.publicKey = realPk;
    walletState.connected = true;
    rerender(
      <Providers>
        <Harness />
      </Providers>
    );

    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("real"));
    expect(screen.getByTestId("eff")).toHaveTextContent(realPk.toBase58());
    const saved = JSON.parse(localStorage.getItem(SANDBOX_STORAGE_KEY)!);
    expect(saved.secretKey).toHaveLength(64);
    expect(saved.active).toBe(false);

    // Disconnecting real wallet restores previous saved sandbox key on re-enter
    walletState.publicKey = null;
    walletState.connected = false;
    rerender(
      <Providers>
        <Harness />
      </Providers>
    );
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("none"));
    expect(screen.getByTestId("sandbox")).toHaveTextContent(sandboxAddr);

    await userEvent.click(screen.getByRole("button", { name: "enter" }));
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("sandbox"));
    expect(screen.getByTestId("sandbox")).toHaveTextContent(sandboxAddr);
  });

  it("locks exit and reset while a sandbox transaction is in progress, and shows 3-stage toast", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, skipped: false, signature: "faucet-sig-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    let resolveTx!: (sig: string) => void;
    sendSandboxIxsMock.mockImplementation(
      (_conn: unknown, _kp: unknown, _ixs: unknown, opts?: { onStage?: (s: unknown) => void }) => {
        opts?.onStage?.({ stage: "signing" });
        opts?.onStage?.({ stage: "broadcasted", signature: "live-sig-1" });
        return new Promise<string>((resolve) => {
          resolveTx = (s) => {
            opts?.onStage?.({ stage: "confirmed", signature: s });
            resolve(s);
          };
        });
      }
    );

    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "enter" }));
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("sandbox"));
    const firstAddr = screen.getByTestId("sandbox").textContent!;

    await userEvent.click(screen.getByRole("button", { name: "tx" }));
    await waitFor(() => expect(screen.getByTestId("locked")).toHaveTextContent("true"));
    expect(screen.getByText(/Broadcasted/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Sent to Solana Devnet/i })).toHaveAttribute(
      "href",
      "https://explorer.solana.com/tx/live-sig-1?cluster=devnet"
    );

    // Exit and reset must be ignored while tx is pending
    await userEvent.click(screen.getByRole("button", { name: "exit" }));
    await userEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(screen.getByTestId("mode")).toHaveTextContent("sandbox");
    expect(screen.getByTestId("sandbox")).toHaveTextContent(firstAddr);

    await act(async () => {
      resolveTx("live-sig-1");
    });

    await waitFor(() => expect(screen.getByTestId("locked")).toHaveTextContent("false"));
    expect(screen.getByText(/Confirmed/)).toBeInTheDocument();
  });

  it("degrades gracefully without crashing when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, skipped: false, signature: "faucet-sig-mem" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <LocaleProvider>
          <Providers>
            <Harness />
          </Providers>
        </LocaleProvider>
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByTestId("storage")).toHaveTextContent("false"));
    await userEvent.click(screen.getByRole("button", { name: "enter" }));
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("sandbox"));
    expect(screen.getByTestId("sandbox")).not.toHaveTextContent("none");
  });

  it("seeds sandbox balance immediately from faucet response without waiting on RPC refetch", async () => {
    connectionMock.getBalance.mockImplementation(() => new Promise(() => {}));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        skipped: false,
        signature: "faucet-sig-seeded",
        solLamports: 40_000_000,
        usdtAtoms: "30000000",
        usdtDecimals: 6,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "enter" }));
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("sandbox"));
    expect(screen.getByTestId("usdt")).toHaveTextContent("30000000");
    expect(screen.getByTestId("sol")).toHaveTextContent("40000000");
    expect(screen.getByTestId("stale")).toHaveTextContent("false");

    // Simulate full page reload (fresh QueryClient + Providers, RPC still hanging)
    unmount();
    renderWithProviders(<Harness />);
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("sandbox"));
    expect(screen.getByTestId("usdt")).toHaveTextContent("30000000");
    expect(screen.getByTestId("sol")).toHaveTextContent("40000000");
    expect(screen.getByTestId("stale")).toHaveTextContent("true");
  });

  it("shows a target-reached receipt for zero top-ups and logs the backend reason privately on failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const faucetResponses = [
      { ok: true, json: async () => ({ ok: true, signature: "seed" }) },
      { ok: true, json: async () => ({ ok: true, skipped: true, signature: null }) },
      { ok: false, json: async () => ({ error: "upstream_specific_error" }) },
    ];
    let faucetIdx = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/sandbox/activate") {
        return { ok: true, json: async () => ({ ok: true, touched: true }) };
      }
      return faucetResponses[faucetIdx++];
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "enter" }));
    await userEvent.click(screen.getByRole("button", { name: "refill" }));
    expect(await screen.findByText("Target balances reached")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "refill" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("upstream_specific_error");
    expect(warn).toHaveBeenCalledWith("Sandbox faucet", "upstream_specific_error");
  });

  it("pings /api/sandbox/activate on restored sandbox session and refreshes every 10 minutes until exit", async () => {
    vi.useFakeTimers();
    const savedKp = (await import("@solana/web3.js")).Keypair.generate();
    localStorage.setItem(
      SANDBOX_STORAGE_KEY,
      JSON.stringify({ secretKey: Array.from(savedKp.secretKey), active: true })
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, touched: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<Harness />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const activateCalls = () =>
      fetchMock.mock.calls.filter(([url]) => url === "/api/sandbox/activate");
    expect(screen.getByTestId("mode")).toHaveTextContent("sandbox");
    expect(activateCalls()).toHaveLength(1);
    // Restored session must not call faucet
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/faucet/sandbox")).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SANDBOX_ACTIVATE_INTERVAL_MS);
    });
    expect(activateCalls()).toHaveLength(2);

    await act(async () => {
      screen.getByRole("button", { name: "exit" }).click();
    });
    expect(screen.getByTestId("mode")).toHaveTextContent("none");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SANDBOX_ACTIVATE_INTERVAL_MS * 2);
    });
    expect(activateCalls()).toHaveLength(2);
    vi.useRealTimers();
  });

  it("exposes localized lastError and alert toast when sandbox faucet fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "empty" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "enter" }));

    await waitFor(() =>
      expect(screen.getByTestId("err")).toHaveTextContent(/faucet reserves are depleted/i)
    );
    expect(screen.getByTestId("mode")).toHaveTextContent("none");
    expect(screen.getByRole("alert")).toHaveTextContent(/faucet reserves are depleted/i);
  });

  it("maps every known server faucet error code (except failed) to a dedicated locale key", () => {
    const dedicatedCodes = [
      "bad_address",
      "ip_limit",
      "daily_sol_cap",
      "daily_cap",
      "locked",
      "empty",
      "disabled",
      "rate_limited",
      "address_limit",
      "cooldown",
    ] as const;

    for (const code of dedicatedCodes) {
      const key = faucetErrorKey(code);
      expect(key, `code ${code} must not fall back to generic error`).not.toBe(
        "errors.sandboxFaucetFailed"
      );
      expect(hasKey(key), `missing locale key ${key} for ${code}`).toBe(true);
    }

    expect(faucetErrorKey("daily_cap")).toBe("errors.sandboxDailyCap");
    expect(faucetErrorKey("daily_sol_cap")).toBe("errors.sandboxDailyCap");
    expect(faucetErrorKey("failed")).toBe("errors.sandboxFaucetFailed");
    expect(faucetErrorKey(undefined)).toBe("errors.sandboxFaucetFailed");
  });
});
