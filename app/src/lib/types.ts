import { PublicKey } from "@solana/web3.js";

export type Side = "yes" | "no";
export type MarketStatusName = "upcoming" | "open" | "resolved" | "burn";
export type ClusterName = "localnet" | "devnet" | "testnet" | "mainnet-beta";
export type FeedKey = "btc" | "sol" | "xau";

export type MarketPdas = {
  market: PublicKey;
  marketBump: number;
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
};

export type FeedQuote = {
  key: FeedKey;
  price: number | null;
  expo: number | null;
  publishTime: number | null;
  conf: number | null;
  available: boolean;
};
