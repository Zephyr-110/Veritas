"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { emptyQuotes, fetchFeedQuotes, subscribeFeedQuotes } from "@/lib/pyth";
import type { FeedQuote, FeedKey } from "@/lib/types";

const POLL_MS = 5000;

export function useFeeds() {
  const { connection } = useConnection();
  const [quotes, setQuotes] = useState<Record<FeedKey, FeedQuote>>(emptyQuotes);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = subscribeFeedQuotes(connection, (next) => {
      setQuotes(next);
      setReady(true);
    });
    const id = window.setInterval(() => {
      void fetchFeedQuotes(connection).then((next) => {
        setQuotes(next);
        setReady(true);
      });
    }, POLL_MS);
    return () => {
      unsub();
      window.clearInterval(id);
    };
  }, [connection]);

  return { quotes, ready };
}
