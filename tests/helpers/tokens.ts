import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { TestEnv } from "./env";
import { LiveMarket } from "./market_type";

export const COLLATERAL_DECIMALS = 6;

export function toBn(n: bigint | number | string): anchor.BN {
  return new anchor.BN(n.toString());
}

export function tokens(amount: number, decimals = COLLATERAL_DECIMALS): bigint {
  return BigInt(amount) * 10n ** BigInt(decimals);
}

export function ataOf(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
}

export async function createCollateralMint(
  env: TestEnv,
  decimals = COLLATERAL_DECIMALS
): Promise<PublicKey> {
  return createMint(
    env.connection,
    env.payer,
    env.payerPubkey,
    null,
    decimals,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
}

export async function openTokenAccount(
  env: TestEnv,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = await getOrCreateAssociatedTokenAccount(
    env.connection,
    env.payer,
    mint,
    owner,
    false,
    "confirmed",
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  return ata.address;
}

export async function mintToUser(
  env: TestEnv,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint
): Promise<PublicKey> {
  const ata = await openTokenAccount(env, mint, owner);
  if (amount > 0n) {
    await mintTo(
      env.connection,
      env.payer,
      mint,
      ata,
      env.payer,
      amount,
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );
  }
  return ata;
}

function isAccountMissing(err: unknown): boolean {
  return (err as { name?: string })?.name === "TokenAccountNotFoundError";
}

export async function tokenAmount(
  env: TestEnv,
  ata: PublicKey
): Promise<bigint> {
  try {
    const account = await getAccount(
      env.connection,
      ata,
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    return account.amount;
  } catch (err) {
    if (isAccountMissing(err)) {
      return 0n;
    }
    throw err;
  }
}

export async function mintSupply(
  env: TestEnv,
  mint: PublicKey
): Promise<bigint> {
  try {
    const account = await getMint(
      env.connection,
      mint,
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    return account.supply;
  } catch (err) {
    if (isAccountMissing(err)) {
      return 0n;
    }
    throw err;
  }
}

export async function fetchMint(env: TestEnv, mint: PublicKey) {
  return getMint(env.connection, mint, "confirmed", TOKEN_PROGRAM_ID);
}

export async function fetchTokenAccount(env: TestEnv, ata: PublicKey) {
  return getAccount(env.connection, ata, "confirmed", TOKEN_PROGRAM_ID);
}

export type Position = {
  collateral: bigint;
  yes: bigint;
  no: bigint;
  lp: bigint;
  vault: bigint;
  yesPool: bigint;
  noPool: bigint;
  lpSupply: bigint;
};

export async function readPosition(
  env: TestEnv,
  market: LiveMarket,
  owner: PublicKey
): Promise<Position> {
  return {
    collateral: await tokenAmount(env, ataOf(market.collateralMint, owner)),
    yes: await tokenAmount(env, ataOf(market.yesMint, owner)),
    no: await tokenAmount(env, ataOf(market.noMint, owner)),
    lp: await tokenAmount(env, ataOf(market.lpMint, owner)),
    vault: await tokenAmount(env, market.collateralVault),
    yesPool: await tokenAmount(env, market.yesPool),
    noPool: await tokenAmount(env, market.noPool),
    lpSupply: await mintSupply(env, market.lpMint),
  };
}

export function eqAmount(
  actual: bigint | number | string | anchor.BN,
  expected: bigint | number | string | anchor.BN,
  message: string
) {
  const left = actual.toString();
  const right = expected.toString();
  if (left !== right) {
    throw new Error(`${message}\nactual: ${left}\nexpected: ${right}`);
  }
}
