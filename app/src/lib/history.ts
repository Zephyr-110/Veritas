import { Buffer } from "buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import { t } from "@/i18n/store";

const GET_COLLATERAL_DISC = Buffer.from([44, 121, 236, 104, 224, 169, 223, 129]);

export type RedemptionRow = {
  signature: string;
  slot: number;
  when: number | null;
  label: string;
};

function includesDisc(data: Buffer, disc: Buffer): boolean {
  if (data.length < disc.length) return false;
  for (let i = 0; i < disc.length; i += 1) if (data[i] !== disc[i]) return false;
  return true;
}

export async function fetchRedemptions(
  connection: Connection,
  owner: PublicKey,
  programId: PublicKey
): Promise<RedemptionRow[]> {
  const sigs = await connection.getSignaturesForAddress(owner, { limit: 25 }, "confirmed");
  if (!sigs.length) return [];
  const txs = await connection.getTransactions(
    sigs.map((s) => s.signature),
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
  );
  const rows: RedemptionRow[] = [];
  txs.forEach((tx, i) => {
    if (!tx) return;
    const message = tx.transaction.message;
    const keys =
      "staticAccountKeys" in message
        ? message.staticAccountKeys
        : (message as { accountKeys: PublicKey[] }).accountKeys;
    const compiled =
      "compiledInstructions" in message
        ? message.compiledInstructions
        : (message as { instructions: Array<{ programIdIndex: number; data: Uint8Array }> }).instructions;
    const hit = compiled.some((ix) => {
      const program = keys[ix.programIdIndex];
      if (!program || !program.equals(programId)) return false;
      const data = Buffer.from(ix.data);
      return includesDisc(data, GET_COLLATERAL_DISC);
    });
    if (!hit) return;
    rows.push({
      signature: sigs[i].signature,
      slot: sigs[i].slot,
      when: tx.blockTime ?? sigs[i].blockTime ?? null,
      label: t("me.redeemTx"),
    });
  });
  return rows;
}


