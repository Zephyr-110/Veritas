export const PROGRAM_ID_DEFAULT = "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER";
export const USDT_PUBKEY = "CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG";
export const COLLATERAL_SYMBOL = "USDT";
export const SERVICE_FEE_BPS = 30n;
export const DYNAMIC_FEE_BASE_BPS = 50;
export const DYNAMIC_FEE_RAMP_BPS = 250;
export const DYNAMIC_FEE_ANCHOR_SEC = 900;
export const FEE_DENOMINATOR = 10000n;
export const RESOLVE_WINDOW = 172_800;
export const MAX_SETTLE_DELAY = 10;
export const CLAIM_WINDOW = 2_592_000;
export const SNAPSHOT_WINDOW = 10;
export const SNAPSHOT_MAX_ENTRIES = 16;
export const MIN_CREATE_COLLATERAL = 1_000_001n;
export const MIN_CREATE_SOL_LAMPORTS = 20_000_000;
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

export const CHAINLINK_OCR2_PROGRAM_ID = "cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ";
export const CHAINLINK_STORE_PROGRAM_ID = "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny";
export const OCR2_STATE_DISCRIMINATOR = [216, 146, 107, 94, 104, 75, 182, 177] as const;

export const GITHUB_REPO = "https://github.com/Zephyr-110/Veritas";
export const ORACLE_CENSUS_URL = `${GITHUB_REPO}/blob/master/docs/oracle-census-2026-11-22.md`;
export const DEMO_VIDEO_URL = (process.env.NEXT_PUBLIC_DEMO_VIDEO_URL ?? "").trim();

export const MARKET_ACCOUNT_SIZE = 409;
export const MARKET_ACCOUNT_SIZE_V2 = 415;
export const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154] as const;
export const LP_POSITION_DISCRIMINATOR = [105, 241, 37, 200, 224, 2, 252, 90] as const;
export const MARKET_SNAPSHOT_DISCRIMINATOR = [107, 32, 221, 188, 130, 114, 104, 28] as const;
