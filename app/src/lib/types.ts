import { PublicKey } from "@solana/web3.js";

export type Side = "yes" | "no";
export type MarketStatusName = "open" | "resolved" | "windowBurn" | "staleBurn";
export type ClusterName = "localnet" | "devnet" | "testnet" | "mainnet-beta";
export type FeedKey = "btc" | "eth" | "sol" | "link" | "usdc" | "usdt";

export type MarketPdas = {
  market: PublicKey;
  marketBump: number;
  snapshot: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  collateralVault: PublicKey;
  yesPool: PublicKey;
  noPool: PublicKey;
};

export type AppSettings = {
  rpcUrl: string;
  cluster: ClusterName;
  programId: string;
  collateralMint: string;
};

export type ToastKind = "info" | "ok" | "err";

export type ToastItem = {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  href?: string;
  marketAddress?: string;
  action?: string;
};

export type FeedQuote = {
  key: FeedKey;
  price: number | null;
  decimals: number;
  publishTime: number | null;
  counter: number | null;
  available: boolean;
  receivedAt?: number | null;
};
