export const PROGRAM_ID_DEFAULT = "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER";
export const USDT_PUBKEY = "CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG";
export const COLLATERAL_SYMBOL = "USDT";
export const SERVICE_FEE_BPS = 30n;
export const FEE_DENOMINATOR = 10000n;
export const RESOLVE_WINDOW = 172_800;
export const MAX_SETTLE_DELAY = 10;
export const MIN_CREATE_COLLATERAL = 1_000_001n;
export const PREDICTION_BYTES = 64;
export const MARKET_ID_BYTES = 16;
export const DEFAULT_SLIPPAGE_BPS = 300;
export const STORAGE_KEY = "veritas.settings.v3";

export const DEFAULT_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
export const DEFAULT_CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";
export const DEFAULT_PROGRAM_ID =
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? PROGRAM_ID_DEFAULT;
export const DEFAULT_COLLATERAL_MINT =
  process.env.NEXT_PUBLIC_COLLATERAL_MINT ?? USDT_PUBKEY;

export const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export const PYTH_PUSH_ORACLE = "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT";
export const PYTH_SHARD = 0;
export const HERMES_URL = "https://hermes.pyth.network";
export const GITHUB_REPO = "https://github.com/Zephyr-110/Veritas";

export const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154] as const;
export const LP_POSITION_DISCRIMINATOR = [105, 241, 37, 200, 224, 2, 252, 90] as const;
