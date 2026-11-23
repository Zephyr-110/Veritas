import { Buffer } from "buffer";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { decodeMarket } from "./codec";
import { decodePrediction } from "./format";
import { fetchTxBatch } from "./resolve";
import { instructionGroups } from "./transaction-history";

const REDEEM = Buffer.from([44, 121, 236, 104, 224, 169, 223, 129]);
const CREATE = Buffer.from([103, 226, 97, 235, 200, 188, 251, 254]);

export type RedemptionRow = {
  id: string;
  signature: string;
  when: number | null;
  market: PublicKey;
  title?: string;
  side?: "YES" | "NO";
  mint: PublicKey;
  payout?: { atoms: bigint; decimals: number };
};

export function redemptionRows(tx: VersionedTransactionResponse, signature: string, owner: PublicKey, program: PublicKey) {
  const rows: RedemptionRow[] = [];
  for (const [outer, group] of instructionGroups(tx).entries()) {
    for (const [index, ix] of group.entries()) {
      if (!ix.program.equals(program) || !ix.data.subarray(0, 8).equals(REDEEM) || !ix.accounts[0]?.equals(owner)) continue;
      const [, market, burnedMint, , mint, vault, recipient, tokenProgram] = ix.accounts;
      if (!tokenProgram) continue;
      const row: RedemptionRow = { id: signature + "/" + outer + "/" + index, signature, market, mint, when: tx.blockTime ?? null };
      for (const side of ["YES", "NO"] as const) {
        const [pda] = PublicKey.findProgramAddressSync([Buffer.from(side.toLowerCase() + "_mint"), market.toBuffer()], program);
        if (pda.equals(burnedMint)) row.side = side;
      }
      // Read the actual TransferChecked payout. Voided redemptions burn twice
      // the amount paid out, and a single transaction may contain both sides.
      for (const inner of group.slice(index + 1)) {
        if (inner.program.equals(program)) break;
        if (inner.program.equals(tokenProgram) && inner.data.length === 10 && inner.data[0] === 12 &&
          inner.accounts[0]?.equals(vault) && inner.accounts[1]?.equals(mint) &&
          inner.accounts[2]?.equals(recipient) && inner.accounts[3]?.equals(market)) {
          row.payout = { atoms: inner.data.readBigUInt64LE(1), decimals: inner.data[9] };
          break;
        }
      }
      rows.push(row);
    }
  }
  return rows;
}

async function historicalTitle(connection: Connection, program: PublicKey, row: RedemptionRow) {
  let before = row.signature;
  for (;;) {
    const page = await connection.getSignaturesForAddress(row.market, { before, limit: 64 }, "confirmed");
    const valid = page.filter(s => !s.err);
    for (let i = 0; i < valid.length; i += 4) {
      const txs = await fetchTxBatch(connection, valid.slice(i, i + 4).map(s => s.signature));
      for (const tx of txs) {
        if (!tx) continue;
        for (const ix of instructionGroups(tx).flat()) {
          if (ix.program.equals(program) && ix.accounts[1]?.equals(row.market) && ix.data.length >= 96 &&
            ix.data.subarray(0, 8).equals(CREATE)) return decodePrediction(ix.data.subarray(32, 96));
        }
      }
    }
    if (page.length < 64) return;
    before = page[page.length - 1].signature;
  }
}

export async function fetchRedemptions(connection: Connection, owner: PublicKey, program: PublicKey) {
  const sigs = (await connection.getSignaturesForAddress(owner, { limit: 25 }, "confirmed")).filter(s => !s.err);
  const rows: RedemptionRow[] = [];
  for (let i = 0; i < sigs.length; i += 4) {
    const chunk = sigs.slice(i, i + 4);
    const txs = await fetchTxBatch(connection, chunk.map(s => s.signature));
    txs.forEach((tx, j) => {
      if (tx) rows.push(...redemptionRows(tx, chunk[j].signature, owner, program));
    });
  }
  const markets = Array.from(new Map(rows.map(r => [r.market.toBase58(), r])).values());
  if (!markets.length) return rows;
  const infos = await connection.getMultipleAccountsInfo(markets.map(r => r.market), "confirmed");
  const titles = new Map<string, string | undefined>();
  for (const [i, row] of markets.entries()) {
    const info = infos[i];
    const title = info?.owner.equals(program) ? decodePrediction(decodeMarket(info.data).prediction) :
      await historicalTitle(connection, program, row).catch(() => undefined);
    titles.set(row.market.toBase58(), title);
  }
  return rows.map(r => ({ ...r, title: titles.get(r.market.toBase58()) }));
}
