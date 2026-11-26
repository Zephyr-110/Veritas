"use client";

import { useEffect, useReducer } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { Connection } from "@solana/web3.js";
import { emptyQuotes, fetchFeedQuotes, QUOTE_STALE_MS, subscribeFeedQuotes } from "@/lib/chainlink";
import { parseTxError } from "@/lib/errors";
import type { FeedQuote, FeedKey } from "@/lib/types";

export { QUOTE_STALE_MS };
export const POLL_MS = 6_000;
export const WATCHDOG_CHECK_MS = 5_000;
const ERROR_RECOVER_COOLDOWN_MS = 2_000;

type QuotesState = {
  quotes: Record<FeedKey, FeedQuote>;
  ready: boolean;
  error: string | null;
  lastUpdated: number | null;
  lastReceivedAt: number | null;
};

function initialState(): QuotesState {
  return {
    quotes: emptyQuotes(),
    ready: false,
    error: null,
    lastUpdated: null,
    lastReceivedAt: null,
  };
}

let state: QuotesState = initialState();
const listeners = new Set<() => void>();
let pumpEndpoint: string | null = null;
let activeConnection: Connection | null = null;
let stopPump: (() => void) | null = null;
let stopTransport: (() => void) | null = null;
let pumpStartedAtMs = 0;
let recovering = false;
let lastRebuildAtMs = 0;
let lastErrorRecoverAtMs = 0;

function notify() {
  listeners.forEach((fn) => fn());
}

function emitQuotes(next: Record<FeedKey, FeedQuote>) {
  const nowMs = Date.now();
  const merged = { ...state.quotes };
  let receivedAny = false;
  (Object.keys(next) as FeedKey[]).forEach((k) => {
    const incoming = next[k];
    if (incoming?.available && incoming.price != null) {
      const prev = merged[k];
      const nextTs = Math.max(prev?.receivedAt ?? 0, incoming.receivedAt ?? nowMs);
      merged[k] = { ...incoming, receivedAt: nextTs };
      receivedAny = true;
    }
  });
  if (!receivedAny) {
    if (!state.ready) {
      state = { ...state, ready: true };
      notify();
    }
    return;
  }
  state = {
    quotes: merged,
    ready: true,
    error: null,
    lastUpdated: Math.floor(nowMs / 1000),
    lastReceivedAt: nowMs,
  };
  notify();
}

function emitError(err: unknown) {
  state = {
    ...state,
    ready: true,
    error: parseTxError(err),
  };
  notify();
}

async function pollOnce(): Promise<boolean> {
  if (!activeConnection) return false;
  const conn = activeConnection;
  try {
    const next = await fetchFeedQuotes(conn);
    const before = state.lastReceivedAt;
    emitQuotes(next);
    return state.lastReceivedAt !== null && state.lastReceivedAt >= (before ?? 0);
  } catch (err) {
    emitError(err);
    return false;
  }
}

function startTransport(connection: Connection) {
  stopTransport?.();
  const unsub = subscribeFeedQuotes(connection, emitQuotes, (err) => {
    void onTransportError(err);
  });
  const pollId = window.setInterval(() => {
    if (!document.hidden) void pollOnce();
  }, POLL_MS);

  stopTransport = () => {
    unsub();
    window.clearInterval(pollId);
  };
}

function rebuildTransport() {
  if (!activeConnection) return;
  lastRebuildAtMs = Date.now();
  startTransport(activeConnection);
}

async function runWatchdogRecovery(forceRebuild = false) {
  if (recovering || !activeConnection) return;
  recovering = true;
  try {
    const prevReceivedAt = state.lastReceivedAt ?? 0;
    await pollOnce();
    const freshAfterPoll =
      state.lastReceivedAt !== null &&
      state.lastReceivedAt > prevReceivedAt &&
      Date.now() - state.lastReceivedAt <= QUOTE_STALE_MS;
    if ((!freshAfterPoll || forceRebuild) && Date.now() - lastRebuildAtMs >= WATCHDOG_CHECK_MS) {
      rebuildTransport();
    }
  } finally {
    recovering = false;
  }
}

async function onTransportError(err: unknown) {
  emitError(err);
  const nowMs = Date.now();
  if (nowMs - lastErrorRecoverAtMs < ERROR_RECOVER_COOLDOWN_MS) return;
  lastErrorRecoverAtMs = nowMs;
  if (recovering || !activeConnection) return;
  recovering = true;
  try {
    await pollOnce();
    rebuildTransport();
  } finally {
    recovering = false;
  }
}

function watchdogTick() {
  if (typeof document !== "undefined" && document.hidden) return;
  const anchorMs = state.lastReceivedAt ?? pumpStartedAtMs;
  if (anchorMs <= 0) return;
  if (Date.now() - anchorMs <= QUOTE_STALE_MS) return;
  notify();
  void runWatchdogRecovery(false);
}

function ensurePump(connection: Connection): boolean {
  activeConnection = connection;
  if (pumpEndpoint === connection.rpcEndpoint) return false;
  stopPump?.();
  pumpEndpoint = connection.rpcEndpoint;
  pumpStartedAtMs = Date.now();
  lastRebuildAtMs = pumpStartedAtMs;
  lastErrorRecoverAtMs = 0;
  recovering = false;
  state = initialState();

  startTransport(connection);

  const watchdogId = window.setInterval(watchdogTick, WATCHDOG_CHECK_MS);
  const onVis = () => {
    if (document.hidden) return;
    const anchorMs = state.lastReceivedAt ?? pumpStartedAtMs;
    if (anchorMs > 0 && Date.now() - anchorMs > QUOTE_STALE_MS) {
      void runWatchdogRecovery(false);
    } else {
      void pollOnce();
    }
  };
  document.addEventListener("visibilitychange", onVis);

  stopPump = () => {
    stopTransport?.();
    stopTransport = null;
    window.clearInterval(watchdogId);
    document.removeEventListener("visibilitychange", onVis);
  };
  return true;
}

export function resetFeedsForTests() {
  stopPump?.();
  stopPump = null;
  stopTransport = null;
  pumpEndpoint = null;
  activeConnection = null;
  pumpStartedAtMs = 0;
  recovering = false;
  lastRebuildAtMs = 0;
  lastErrorRecoverAtMs = 0;
  state = initialState();
  listeners.clear();
}

export function useFeeds(): QuotesState & { retry: () => Promise<void> } {
  const { connection } = useConnection();
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    try {
      window.localStorage.removeItem("veritas.quotes.v1");
    } catch {
      // storage blocked
    }
    listeners.add(bump);
    if (ensurePump(connection)) bump();
    return () => {
      listeners.delete(bump);
    };
  }, [connection, bump]);

  return {
    ...state,
    retry: async () => {
      await pollOnce();
    },
  };
}
