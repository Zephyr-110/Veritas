"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { emptyQuotes, subscribeFeedQuotes } from "@/lib/pyth";
import type { FeedQuote, FeedKey } from "@/lib/types";

export function useFeeds() {
  const { connection } = useConnection();
  const [quotes, setQuotes] = useState<Record<FeedKey, FeedQuote>>(emptyQuotes);

  useEffect(() => {
    return subscribeFeedQuotes(connection, setQuotes);
  }, [connection]);

  return quotes;
}
