import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { FEEDS } from "@/lib/feeds";
import type { MarketView } from "@/lib/markets";
import { LocaleProvider } from "@/i18n/provider";

const fetchRuling = vi.hoisted(() => vi.fn());
const findPushSignatures = vi.hoisted(() => vi.fn());
const fetchMarketSnapshot = vi.hoisted(() => vi.fn());

vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: { rpcEndpoint: "https://api.devnet.solana.com" } }),
}));

vi.mock("@/components/providers", () => ({
  useSettings: () => ({
    settings: {
      cluster: "devnet",
      programId: "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER",
    },
  }),
}));

vi.mock("@/lib/ruling-evidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ruling-evidence")>();
  return {
    ...actual,
    fetchRuling,
    findPushSignatures,
  };
});

vi.mock("@/lib/markets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/markets")>();
  return {
    ...actual,
    fetchMarketSnapshot,
  };
});

const { RulingEvidence } = await import("@/components/ruling-evidence");

function makeResolvedMarket(): MarketView {
  const key = new PublicKey(Buffer.alloc(32, 8));
  return {
    address: key,
    pdas: {
      market: key,
      marketBump: 255,
      snapshot: new PublicKey(Buffer.alloc(32, 9)),
      yesMint: key,
      noMint: key,
      collateralVault: key,
      yesPool: key,
      noPool: key,
    },
    title: "BTC/USD at or above opening price in 15 min?",
    id: Array.from({ length: 16 }, () => 1),
    creator: key,
    collateralMint: key,
    yesMint: key,
    noMint: key,
    status: "resolved",
    winner: "yes",
    expiry: 1_795_447_823,
    endTs: 1_795_447_823,
    finishTs: 1_795_447_837,
    bump: 255,
    yesPool: 100n,
    noPool: 100n,
    vault: 100n,
    decimals: 6,
    tokenProgram: key,
    yesPrice: 1,
    noPrice: 0,
    reserveYes: 100n,
    reserveNo: 100n,
    totalLpShares: 100n,
    ocr2State: new PublicKey(FEEDS[0].state),
    feedKey: "btc",
    feedSymbol: "BTC/USD",
    priceDecimals: 8,
    threshold: 63_390_00000000n,
    settleAbove: true,
    settledPrice: 63_402_22800000n,
    settledPublishTime: 1_795_447_824,
    feeBps: 30,
    lastAccrualTs: 0,
    cumYesPerShare: 0n,
    cumNoPerShare: 0n,
  };
}

function renderWithQuery(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <LocaleProvider>{ui}</LocaleProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchRuling.mockReset();
  findPushSignatures.mockReset();
  fetchMarketSnapshot.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RulingEvidence component", () => {
  it("renders witnessed pre/post evidence lines, bold ruling price, Solscan push links, and zero missing count", async () => {
    const digest = Buffer.alloc(32, 1);
    const makeReport = (epoch: number, round: number, ts: number, median: bigint) => ({
      configDigest: digest,
      epoch,
      round,
      observationsTimestamp: ts,
      median,
      raw: Buffer.alloc(288),
    });
    const pre = makeReport(7201555, 2, 1795447821, 6338055208989n);
    const post = makeReport(7201555, 3, 1795447824, 6340222800000n);

    fetchRuling.mockResolvedValue({ pre, post, signature: "resolve-sig-1" });
    findPushSignatures.mockResolvedValue({ pre: "push-pre-sig", post: "push-post-sig" });
    fetchMarketSnapshot.mockResolvedValue({
      bump: 1,
      entries: [
        { epoch: 7201555, round: 2, counter: 41922063, price: pre.median, ts: BigInt(pre.observationsTimestamp) },
        { epoch: 7201555, round: 3, counter: 41922064, price: post.median, ts: BigInt(post.observationsTimestamp) },
      ],
    });

    renderWithQuery(<RulingEvidence market={makeResolvedMarket()} />);

    await waitFor(() => expect(screen.getByText("Missing reports: 0")).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Transmission" })).toHaveLength(2));
    const preId = screen.getByText(/7201555\/2/);
    const postId = screen.getByText(/7201555\/3/);
    const preCounter = screen.getByText(/41922063/);
    const postCounter = screen.getByText(/41922064/);
    expect(preId.closest("a")).toBeNull();
    expect(postId.closest("a")).toBeNull();
    expect(preCounter.closest("a")).toBeNull();
    expect(postCounter.closest("a")).toBeNull();

    const postPriceEl = screen.getByText("63402.228");
    expect(postPriceEl.tagName).toBe("STRONG");
    expect(postPriceEl.closest("a")).toBeNull();

    const transmissionLinks = screen.getAllByRole("link", { name: "Transmission" });
    expect(transmissionLinks[0]).toHaveAttribute("href", "https://solscan.io/tx/push-pre-sig?cluster=devnet");
    expect(transmissionLinks[1]).toHaveAttribute("href", "https://solscan.io/tx/push-post-sig?cluster=devnet");
    expect(preId.closest("p")?.querySelectorAll("a")).toHaveLength(1);
    expect(postId.closest("p")?.querySelectorAll("a")).toHaveLength(1);

    expect(
      screen.getByText(
        /Snapshot counters establish whether any reports are missing\. Oracle signatures authenticate the report contents\./i
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Resolve transaction" })).toHaveAttribute(
      "href",
      "https://solscan.io/tx/resolve-sig-1?cluster=devnet"
    );
    expect(screen.getAllByRole("link", { name: "Transmission" })).toHaveLength(2);
  });

  it("omits counters and avoids fabricating missing-report count when snapshot has no witness pair", async () => {
    const digest = Buffer.alloc(32, 1);
    const makeReport = (epoch: number, round: number, ts: number, median: bigint) => ({
      configDigest: digest,
      epoch,
      round,
      observationsTimestamp: ts,
      median,
      raw: Buffer.alloc(288),
    });
    fetchRuling.mockResolvedValue({
      pre: makeReport(7201493, 5, 1795446714, 6298262652904n),
      post: makeReport(7201493, 6, 1795446717, 6298637809946n),
      signature: "resolve-sig-2",
    });
    findPushSignatures.mockResolvedValue({ pre: "push-pre-2", post: "push-post-2" });
    fetchMarketSnapshot.mockResolvedValue(null);

    renderWithQuery(<RulingEvidence market={makeResolvedMarket()} />);

    await waitFor(() => expect(screen.getByText("No witnessed counters")).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Transmission" })).toHaveLength(2));
    expect(screen.getByText(/7201493\/5/).closest("a")).toBeNull();
    expect(screen.getByText(/7201493\/6/).closest("a")).toBeNull();
    expect(screen.queryByText(/Missing reports/i)).toBeNull();
  });

  it("serves cached settlement evidence from SQLite API without calling on-chain RPC queries", async () => {
    const market = makeResolvedMarket();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          found: true,
          evidence: {
            marketAddress: market.address.toBase58(),
            programId: "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER",
            feedAddress: FEEDS[0].feed,
            snapshotAddress: market.pdas.snapshot.toBase58(),
            resolveSignature: "db-resolve-sig",
            resolveTxUrl: "https://solscan.io/tx/db-resolve-sig?cluster=devnet",
            settledPrice: "6340222800000",
            priceDecimals: 8,
            winner: "yes",
            status: "resolved",
            preEpoch: 7201555,
            preRound: 2,
            preCounter: 41922063,
            prePrice: "6338055208989",
            preTimestamp: 1795447821,
            prePushSignature: "db-push-pre",
            prePushTxUrl: "https://solscan.io/tx/db-push-pre?cluster=devnet",
            postEpoch: 7201555,
            postRound: 3,
            postCounter: 41922064,
            postPrice: "6340222800000",
            postTimestamp: 1795447824,
            postPushSignature: "db-push-post",
            postPushTxUrl: "https://solscan.io/tx/db-push-post?cluster=devnet",
            missingCount: 0,
            createdAt: 1795447838,
          },
        }),
      })
    );

    renderWithQuery(<RulingEvidence market={market} />);

    await waitFor(() => expect(screen.getByText("Missing reports: 0")).toBeInTheDocument());
    expect(screen.getByText("63402.228").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "Resolve transaction" })).toHaveAttribute(
      "href",
      "https://solscan.io/tx/db-resolve-sig?cluster=devnet"
    );
    expect(fetchRuling).not.toHaveBeenCalled();
    expect(fetchMarketSnapshot).not.toHaveBeenCalled();
    expect(findPushSignatures).not.toHaveBeenCalled();
  });
});
