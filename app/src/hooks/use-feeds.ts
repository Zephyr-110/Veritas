"use client";

import { useEffect, useReducer } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { emptyQuotes, fetchFeedQuotes, subscribeFeedQuotes } from "@/lib/pyth";
import type { FeedQuote, FeedKey } from "@/lib/types";

const POLL_MS = 5000;

/**
 * Feed quotes live in one module-level store shared by every consumer
 * (header tape, homepage panel, market table, create and detail pages).
 * Previously each useFeeds() call site ran its own subscription + poll
 * and started from empty, so every mount flashed skeletons / "—" until
 * its private first fetch landed, and the same accounts were subscribed
 * five times over. Now the first consumer starts a single pump; later
 * mounts in the same session read the store instantly.
 *
 * Deliberately NOT persisted across reloads: a minutes-old price shown
 * without a staleness label would read as a live price. Standing rule
 * for this site — stale data never renders as if it were current;
 * either it carries a visible "as of" label or it does not render.
 */
type QuotesState = { quotes: Record<FeedKey, FeedQuote>; ready: boolean };

let state: QuotesState = { quotes: emptyQuotes(), ready: false };
const listeners = new Set<() => void>();
let pumpEndpoint: string | null = null;
let stopPump: (() => void) | null = null;

function emit(next: Record<FeedKey, FeedQuote>) {
  state = { quotes: next, ready: true };
  listeners.forEach((fn) => fn());
}

function ensurePump(connection: Parameters<typeof subscribeFeedQuotes>[0]) {
  if (pumpEndpoint === connection.rpcEndpoint) return;
  stopPump?.();
  pumpEndpoint = connection.rpcEndpoint;
  const unsub = subscribeFeedQuotes(connection, emit);
  const id = window.setInterval(() => {
    void fetchFeedQuotes(connection).then(emit).catch(() => undefined);
  }, POLL_MS);
  stopPump = () => {
    unsub();
    window.clearInterval(id);
  };
}

export function useFeeds(): QuotesState {
  const { connection } = useConnection();
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    // Drop any warm-start payload an earlier build may have left behind.
    try {
      window.localStorage.removeItem("veritas.quotes.v1");
    } catch {
      // storage blocked — nothing to clean
    }
    listeners.add(bump);
    ensurePump(connection);
    bump();
    return () => {
      listeners.delete(bump);
    };
  }, [connection, bump]);

  return state;
}
