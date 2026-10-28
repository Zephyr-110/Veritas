export const PROGRAM_ID_DEFAULT = "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER";
export const ADMIN_PUBKEY = "DEPaDBPZeXhi8TfLpk4D5Niab6tnb8eF1e2hNUSSKKr8";
export const USDT_PUBKEY = "CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG";
export const SERVICE_FEE_BPS = 30n;
export const FEE_DENOMINATOR = 10000n;
export const RESOLVE_WINDOW = 100_000;
export const PREDICTION_BYTES = 64;
export const MARKET_ID_BYTES = 16;
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%
export const STORAGE_KEY = "pankou.settings.v2";

export const DEFAULT_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
export const DEFAULT_CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";
export const DEFAULT_PROGRAM_ID =
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? PROGRAM_ID_DEFAULT;
export const DEFAULT_COLLATERAL_MINT =
  process.env.NEXT_PUBLIC_COLLATERAL_MINT ?? USDT_PUBKEY;
