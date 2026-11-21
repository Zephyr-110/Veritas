"use client";

import { useEffect, useReducer } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { Connection } from "@solana/web3.js";
import { emptyQuotes, fetchFeedQuotes, subscribeFeedQuotes } from "@/lib/chainlink";
import { parseTxError } from "@/lib/errors";
import type { FeedQuote, FeedKey } from "@/lib/types";

const POLL_MS = 6000;

type QuotesState = {
  quotes: Record<FeedKey, FeedQuote>;
  ready: boolean;
  error: string | null;
  lastUpdated: number | null;
};

let state: QuotesState = {
  quotes: emptyQuotes(),
  ready: false,
  error: null,
  lastUpdated: null,
};
const listeners = new Set<() => void>();
let pumpEndpoint: string | null = null;
let activeConnection: Connection | null = null;
let stopPump: (() => void) | null = null;

function notify() {
  listeners.forEach((fn) => fn());
}

function emitQuotes(next: Record<FeedKey, FeedQuote>) {
  state = {
    quotes: next,
    ready: true,
    error: null,
    lastUpdated: Math.floor(Date.now() / 1000),
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

async function pollOnce() {
  if (!activeConnection) return;
  try {
    const next = await fetchFeedQuotes(activeConnection);
    emitQuotes(next);
  } catch (err) {
    emitError(err);
  }
}

function ensurePump(connection: Connection) {
  activeConnection = connection;
  if (pumpEndpoint === connection.rpcEndpoint) return;
  stopPump?.();
  pumpEndpoint = connection.rpcEndpoint;
  state = {
    quotes: emptyQuotes(),
    ready: false,
    error: null,
    lastUpdated: null,
  };

  const unsub = subscribeFeedQuotes(connection, emitQuotes, emitError);
  const id = window.setInterval(() => {
    if (!document.hidden) void pollOnce();
  }, POLL_MS);
  const onVis = () => {
    if (!document.hidden) void pollOnce();
  };
  document.addEventListener("visibilitychange", onVis);

  stopPump = () => {
    unsub();
    window.clearInterval(id);
    document.removeEventListener("visibilitychange", onVis);
  };
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
    ensurePump(connection);
    bump();
    return () => {
      listeners.delete(bump);
    };
  }, [connection, bump]);

  return {
    ...state,
    retry: pollOnce,
  };
}
