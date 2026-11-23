// @vitest-environment node
import { expect, it } from "vitest";
import { utils } from "@coral-xyz/anchor";
import { PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { redemptionRows } from "./history";

it("keeps both sides of a void redemption and accounts for each actual payout separately", () => {
  const key = (b: number) => new PublicKey(Buffer.alloc(32, b));
  const [owner, market, program, mint, vault, dest, tp] = Array.from({ length: 7 }, (_, i) => key(i + 1));
  const keys = [owner, market, program, mint, vault, dest, tp, ...["yes_mint", "no_mint"].map(s =>
    PublicKey.findProgramAddressSync([Buffer.from(s), market.toBuffer()], program)[0])];
  const disc = Buffer.from([44, 121, 236, 104, 224, 169, 223, 129]);
  const amounts = [10n, 18n];
  const message = {
    getAccountKeys: () => ({ get: (i: number) => keys[i] }),
    compiledInstructions: amounts.map((n, i) => {
      const data = Buffer.alloc(16);
      disc.copy(data);
      data.writeBigUInt64LE(n, 8);
      return { programIdIndex: 2, accountKeyIndexes: [0, 1, 7 + i, 5, 3, 4, 5, 6], data };
    }),
  };
  const meta = { err: null, innerInstructions: amounts.map((n, index) => {
    const data = Buffer.alloc(10);
    data[0] = 12; data.writeBigUInt64LE(n / 2n, 1); data[9] = 6;
    return { index, instructions: [{ programIdIndex: 6, accounts: [4, 3, 5, 1], data: utils.bytes.bs58.encode(data) }] };
  }) };
  const tx = { transaction: { message }, meta } as unknown as VersionedTransactionResponse;
  const rows = redemptionRows(tx, "sig", owner, program);
  expect(rows.map(r => [r.side, r.payout?.atoms])).toEqual([["YES", 5n], ["NO", 9n]]);
  expect(rows[0].id).not.toBe(rows[1].id);
  expect(redemptionRows(tx, "sig", key(42), program)).toEqual([]);
  expect(redemptionRows({ ...tx, meta: null }, "sig", owner, program)).toEqual([]);
});
