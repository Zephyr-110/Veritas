import { Buffer } from "buffer";
import { utils } from "@coral-xyz/anchor";
import type { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";

export type HistoryInstruction = {
  program: PublicKey;
  accounts: PublicKey[];
  data: Buffer;
};

// Keep each CPI with its outer instruction. A transaction can redeem several markets.
export function instructionGroups(tx: VersionedTransactionResponse): HistoryInstruction[][] {
  if (!tx.meta || tx.meta.err) return [];
  const message = tx.transaction.message;
  const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const decode = (programIndex: number, indices: number[] | Uint8Array, data: string | Uint8Array) => ({
    program: keys.get(programIndex)!,
    accounts: Array.from(indices, i => keys.get(i)!),
    data: Buffer.from(typeof data === "string" ? utils.bytes.bs58.decode(data) : data),
  });
  return message.compiledInstructions.map((ix, i) => [
    decode(ix.programIdIndex, ix.accountKeyIndexes, ix.data),
    ...(tx.meta?.innerInstructions?.find(group => group.index === i)?.instructions ?? [])
      .map(inner => decode(inner.programIdIndex, inner.accounts, inner.data)),
  ]);
}
