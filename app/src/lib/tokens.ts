import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export function toBn(n: bigint | number | string): BN {
  return new BN(n.toString());
}

export function tokenProgramOf(owner: PublicKey): PublicKey {
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

export function ataOf(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey
): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}

export function unpackAmount(
  address: PublicKey,
  info: { data: Buffer; owner: PublicKey } | null,
  tokenProgram: PublicKey
): bigint {
  if (!info) return 0n;
  try {
    return unpackAccount(address, info, tokenProgram).amount;
  } catch {
    return 0n;
  }
}

export function unpackSupply(
  address: PublicKey,
  info: { data: Buffer; owner: PublicKey } | null,
  tokenProgram: PublicKey
): bigint {
  if (!info) return 0n;
  try {
    return unpackMint(address, info, tokenProgram).supply;
  } catch {
    return 0n;
  }
}

export function unpackDecimals(
  address: PublicKey,
  info: { data: Buffer; owner: PublicKey } | null,
  tokenProgram: PublicKey
): number {
  if (!info) return 6;
  try {
    return unpackMint(address, info, tokenProgram).decimals;
  } catch {
    return 6;
  }
}

export async function getMultiple(
  connection: Connection,
  keys: PublicKey[]
): Promise<(Awaited<ReturnType<Connection["getAccountInfo"]>> | null)[]> {
  const out: (Awaited<ReturnType<Connection["getAccountInfo"]>> | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed");
    out.push(...chunk);
  }
  return out;
}

export function ensureAtaIx(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  payer: PublicKey
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ataOf(mint, owner, tokenProgram),
    owner,
    mint,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

export async function fetchMintMeta(
  connection: Connection,
  mint: PublicKey
): Promise<{ tokenProgram: PublicKey; decimals: number }> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error("Collateral mint not found. Check the address in Settings.");
  const tokenProgram = tokenProgramOf(info.owner);
  return { tokenProgram, decimals: unpackDecimals(mint, info, tokenProgram) };
}
