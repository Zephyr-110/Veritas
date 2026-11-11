"use client";

import { MarketTable } from "./market-table";
import type { MarketView } from "@/lib/markets";

export function MarketCard({ market }: { market: MarketView }) {
  return <MarketTable markets={[market]} />;
}
