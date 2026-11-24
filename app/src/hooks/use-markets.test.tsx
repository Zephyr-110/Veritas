import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { it, expect, vi } from "vitest";
import type { MarketView } from "@/lib/markets";
import { useVisibleVaults } from "./use-markets";

const connection = vi.hoisted(() => ({ rpcEndpoint: "test", getMultipleAccountsInfo: vi.fn() }));
vi.mock("@solana/wallet-adapter-react", () => ({ useConnection: () => ({ connection }) }));
vi.mock("@/lib/tokens", async (original) => ({
  ...await original<typeof import("@/lib/tokens")>(),
  unpackAmount: (_key: PublicKey, info: { amount: bigint }) => info.amount,
}));

it("keeps the first page of vault balances visible while loading more history", async () => {
  const markets = Array.from({ length: 31 }, (_, i) => {
    const key = new PublicKey(new Uint8Array(32).fill(i + 1));
    return { address: key, status: "resolved", pdas: { collateralVault: key } } as MarketView;
  });
  connection.getMultipleAccountsInfo.mockImplementation(async (keys: PublicKey[]) =>
    keys.map((key) => ({ amount: BigInt(key.toBytes()[0]) }))
  );
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000 } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, rerender, unmount } = renderHook(
    ({ limit }) => useVisibleVaults(markets.slice(0, limit)),
    { wrapper, initialProps: { limit: 30 } }
  );
  await waitFor(() => expect(result.current(markets[29])).toBe(30n));
  rerender({ limit: 60 });
  expect(result.current(markets[0])).toBe(1n);
  await waitFor(() => expect(result.current(markets[30])).toBe(31n));
  expect(connection.getMultipleAccountsInfo.mock.calls.map(([keys]) => keys.length)).toEqual([30, 1]);
  unmount();
  client.clear();
});
