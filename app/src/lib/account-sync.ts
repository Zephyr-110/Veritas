import type { Connection, PublicKey } from "@solana/web3.js";

export type SyncMode = "live" | "polling" | "stale";

type WsEventTarget = {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  addListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type AccountSyncOptions = {
  connection: Connection;
  accounts: PublicKey[];
  onRefresh: () => Promise<void> | void;
  onModeChange?: (mode: SyncMode) => void;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  debounceMs?: number;
};

function attachWsListener(ws: WsEventTarget, event: string, fn: () => void): () => void {
  if (typeof ws.on === "function") {
    ws.on(event, fn);
    return () => {
      if (typeof ws.off === "function") ws.off(event, fn);
      else ws.removeListener?.(event, fn);
    };
  }
  if (typeof ws.addListener === "function") {
    ws.addListener(event, fn);
    return () => {
      ws.removeListener?.(event, fn);
    };
  }
  return () => {};
}

function uniquePubkeys(accounts: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const pk of accounts) {
    const key = pk.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pk);
  }
  return out;
}

/**
 * Watches accounts over WebSocket and automatically degrades to HTTP polling
 * on disconnect or error, self-healing back to WebSocket with a reconciliation
 * refresh once connectivity recovers.
 */
export function subscribeAccountsWithFallback({
  connection,
  accounts,
  onRefresh,
  onModeChange,
  pollIntervalMs = 6_000,
  heartbeatMs = 30_000,
  reconnectBaseMs = 10_000,
  reconnectMaxMs = 30_000,
  debounceMs = 150,
}: AccountSyncOptions): () => void {
  const targets = uniquePubkeys(accounts);
  if (targets.length === 0) return () => {};

  let disposed = false;
  let wsHealthy = false;
  let mode: SyncMode | null = null;
  let subIds: number[] = [];
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;

  const setMode = (next: SyncMode) => {
    if (disposed || mode === next) return;
    mode = next;
    onModeChange?.(next);
  };

  const clearPollTimer = () => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const clearHeartbeatTimer = () => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const clearSubs = () => {
    const ids = subIds;
    subIds = [];
    for (const id of ids) {
      try {
        void Promise.resolve(connection.removeAccountChangeListener?.(id)).catch(() => {});
      } catch {
        // Ignore teardown failures on closed sockets.
      }
    }
  };

  const isVisible = () => typeof document === "undefined" || !document.hidden;
  const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

  const runRefresh = (forceEvenIfHidden = false): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (!forceEvenIfHidden && !isVisible()) return Promise.resolve();
    if (refreshInFlight) {
      refreshQueued = true;
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      try {
        await onRefresh();
        if (!disposed) setMode(wsHealthy ? "live" : "polling");
      } catch {
        if (!disposed) setMode("stale");
      } finally {
        refreshInFlight = null;
        if (refreshQueued && !disposed) {
          refreshQueued = false;
          void runRefresh(forceEvenIfHidden);
        }
      }
    })();
    return refreshInFlight;
  };

  const scheduleDebouncedRefresh = () => {
    if (disposed) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void runRefresh(true);
    }, debounceMs);
  };

  const startPolling = () => {
    clearHeartbeatTimer();
    if (pollTimer !== undefined) return;
    pollTimer = setInterval(() => {
      if (isVisible() && isOnline()) void runRefresh();
    }, pollIntervalMs);
  };

  const startHeartbeat = () => {
    clearPollTimer();
    if (heartbeatTimer !== undefined) return;
    heartbeatTimer = setInterval(() => {
      if (isVisible() && isOnline()) void runRefresh();
    }, heartbeatMs);
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== undefined) return;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (!disposed) trySubscribe(true);
    }, delay);
  };

  const degrade = (immediatePoll: boolean) => {
    if (disposed) return;
    wsHealthy = false;
    clearSubs();
    if (mode !== "stale") setMode("polling");
    startPolling();
    scheduleReconnect();
    if (immediatePoll && isOnline()) void runRefresh(true);
  };

  const trySubscribe = (reconcile: boolean) => {
    if (disposed) return;
    clearSubs();
    if (typeof connection.onAccountChange !== "function" || !isOnline()) {
      degrade(reconcile);
      return;
    }
    const nextIds: number[] = [];
    try {
      for (const pk of targets) {
        const id = connection.onAccountChange(pk, () => scheduleDebouncedRefresh(), "confirmed");
        nextIds.push(id);
      }
    } catch {
      for (const id of nextIds) {
        try {
          void Promise.resolve(connection.removeAccountChangeListener?.(id)).catch(() => {});
        } catch {
          // Ignore partial cleanup failure.
        }
      }
      degrade(reconcile);
      return;
    }
    subIds = nextIds;
    wsHealthy = true;
    reconnectAttempt = 0;
    clearReconnectTimer();
    startHeartbeat();
    if (mode !== "stale") setMode("live");
    if (reconcile) void runRefresh(true);
  };

  const detachFns: Array<() => void> = [];
  const ws = (connection as Connection & { _rpcWebSocket?: WsEventTarget })._rpcWebSocket;
  if (ws) {
    detachFns.push(
      attachWsListener(ws, "close", () => degrade(true)),
      attachWsListener(ws, "error", () => degrade(true)),
      attachWsListener(ws, "open", () => {
        if (!disposed && !wsHealthy) trySubscribe(true);
      })
    );
  }

  if (typeof window !== "undefined") {
    const onOffline = () => degrade(false);
    const onOnline = () => {
      if (!wsHealthy) trySubscribe(true);
      else void runRefresh(true);
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    detachFns.push(() => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    });
  }

  if (typeof document !== "undefined") {
    const onVis = () => {
      if (!document.hidden) {
        if (!wsHealthy) trySubscribe(true);
        else void runRefresh(true);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    detachFns.push(() => document.removeEventListener("visibilitychange", onVis));
  }

  trySubscribe(false);

  return () => {
    disposed = true;
    clearSubs();
    clearPollTimer();
    clearHeartbeatTimer();
    clearReconnectTimer();
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    for (const detach of detachFns) detach();
  };
}
