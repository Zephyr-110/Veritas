import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Keypair, type Connection } from "@solana/web3.js";
import { subscribeAccountsWithFallback, type SyncMode } from "@/lib/account-sync";

function makeFakeConnection() {
  const ws = new EventEmitter();
  const callbacks = new Map<number, () => void>();
  let nextSubId = 1;
  const removed: number[] = [];
  const onAccountChange = vi.fn((_pk: unknown, cb: () => void) => {
    const id = nextSubId++;
    callbacks.set(id, cb);
    return id;
  });
  const removeAccountChangeListener = vi.fn(async (id: number) => {
    removed.push(id);
    callbacks.delete(id);
  });
  return {
    connection: {
      onAccountChange,
      removeAccountChangeListener,
      _rpcWebSocket: ws,
    } as unknown as Connection,
    ws,
    callbacks,
    removed,
    onAccountChange,
    removeAccountChangeListener,
  };
}

describe("subscribeAccountsWithFallback", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces bursts of WS account events and cleanly tears down subscriptions", async () => {
    vi.useFakeTimers();
    const { connection, callbacks, onAccountChange, removeAccountChangeListener } = makeFakeConnection();
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const modes: SyncMode[] = [];
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    const stop = subscribeAccountsWithFallback({
      connection,
      accounts: [a, b, a], // dedupes identical keys
      onRefresh,
      onModeChange: (m) => modes.push(m),
      debounceMs: 100,
    });

    expect(onAccountChange).toHaveBeenCalledTimes(2);
    expect(modes).toEqual(["live"]);

    for (const cb of callbacks.values()) cb();
    expect(onRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    stop();
    expect(removeAccountChangeListener).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("degrades to HTTP polling on WS disconnect, self-heals on reconnect, and marks stale on HTTP failure", async () => {
    vi.useFakeTimers();
    const { connection, ws, onAccountChange } = makeFakeConnection();
    const acct = Keypair.generate().publicKey;
    const modes: SyncMode[] = [];
    let shouldFail = false;
    const onRefresh = vi.fn(async () => {
      if (shouldFail) throw new Error("rpc 503");
    });

    const stop = subscribeAccountsWithFallback({
      connection,
      accounts: [acct],
      onRefresh,
      onModeChange: (m) => modes.push(m),
      pollIntervalMs: 5_000,
      heartbeatMs: 30_000,
      reconnectBaseMs: 12_000,
      reconnectMaxMs: 30_000,
    });

    expect(modes).toEqual(["live"]);

    // Drop WebSocket -> immediate polling mode & reconciliation refresh
    ws.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(modes[modes.length - 1]).toBe("polling");
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Fallback HTTP poll succeeds at 5s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onRefresh).toHaveBeenCalledTimes(2);

    // HTTP poll fails -> transitions to "stale" instead of pretending to be live
    shouldFail = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onRefresh).toHaveBeenCalledTimes(3);
    expect(modes[modes.length - 1]).toBe("stale");

    // WS reconnects at 12s while backend recovers -> restores "live" & reconciles
    shouldFail = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onAccountChange).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(modes[modes.length - 1]).toBe("live");
    expect(onRefresh).toHaveBeenCalledTimes(4);

    // Fast 5s HTTP polling is now stopped; only 30s heartbeat runs
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRefresh).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onRefresh).toHaveBeenCalledTimes(5);

    stop();
  });

  it("falls back cleanly to HTTP polling when onAccountChange is unavailable or throws", async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const modes: SyncMode[] = [];
    const conn = {
      onAccountChange: vi.fn(() => {
        throw new Error("ws blocked");
      }),
      removeAccountChangeListener: vi.fn(),
    } as unknown as Connection;

    const stop = subscribeAccountsWithFallback({
      connection: conn,
      accounts: [Keypair.generate().publicKey],
      onRefresh,
      onModeChange: (m) => modes.push(m),
      pollIntervalMs: 4_000,
      reconnectBaseMs: 10_000,
    });

    expect(modes).toEqual(["polling"]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    stop();
  });
});
