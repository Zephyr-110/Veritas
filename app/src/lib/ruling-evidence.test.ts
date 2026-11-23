// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeMarket, decodeMarketSnapshot } from "./codec";
import { feedByState } from "./feeds";
import { PROGRAM_ID_DEFAULT } from "./constants";
import { findMarketSnapshot } from "./pdas";
import { decodeResolveReports, fetchRuling, findPushSignatures, witnessCounts } from "./ruling-evidence";
import { redemptionRows } from "./history";
import { toUi } from "./format";

const raw = (name: string) => readFileSync("../programs/prediction_market/tests/fixtures/" + name + ".bin");

describe("ruling evidence", () => {
  it("decodes both signed vectors across an epoch boundary and only displays witnessed counters", () => {
    const disc = Buffer.from([155, 23, 80, 173, 46, 74, 23, 239]);
    const length = Buffer.from([32, 1, 0, 0]); // 288 bytes
    const ix = Buffer.concat([disc, length, raw("e7190799_r6"), length, raw("e7190800_r1")]);
    const { pre, post } = decodeResolveReports(ix)!;
    expect([pre.epoch, pre.round, post.epoch, post.round]).toEqual([7190799, 6, 7190800, 1]);
    expect(post.median).toBe(5794784359869n);
    expect(decodeResolveReports(ix.subarray(0, -1))).toBeNull();
    expect(witnessCounts(null, pre, post)).toBeNull();
    const entries = [pre, post].map((r, i) => ({
      epoch: r.epoch, round: r.round, price: r.median, ts: BigInt(r.observationsTimestamp), counter: 500 + i,
    }));
    expect(witnessCounts({ entries, bump: 1 }, pre, post)).toEqual([500, 501]);
    entries[1].price++;
    expect(witnessCounts({ entries, bump: 1 }, pre, post)).toBeNull();
  });
});

// Explicit opt-in for the read-only devnet acceptance run.
describe.skipIf(!process.env.VERITAS_DEVNET_ACCEPTANCE)("devnet receipts", () => {
  const c = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.devnet.solana.com", "confirmed");
  const program = new PublicKey(PROGRAM_ID_DEFAULT);
  it.each([
    ["5fQX6eDjLWmfp2FMf2zrRmPTARPvLRLc3Xo8izo7rNFr", false],
    ["9xEutbZJhoDmiZZGqD3cQ2kGj4Ls6d3Ez7vwrZquk3VG", false],
    ["4PZbweYWwK312bwexHLSxKeoraqA9K2pgyoB7N6ycuQ2", true],
  ] as const)("checks both feed transmissions and counters for %s", async (key, witnessed) => {
    const address = new PublicKey(key);
    const m = decodeMarket((await c.getAccountInfo(address))!.data);
    const ruling = await fetchRuling(c, program, { address, ocr2State: m.ocr2State, finishTs: Number(m.finishTs),
      endTs: Number(m.endTs), settledPublishTime: Number(m.settledPublishTime), settledPrice: m.settledPrice });
    expect(ruling).toBeTruthy();
    const pushes = await findPushSignatures(c, new PublicKey(feedByState(m.ocr2State)!.feed), ruling!);
    const [snapshot] = findMarketSnapshot(program, address);
    const snap = await c.getAccountInfo(snapshot);
    const counts = witnessCounts(snap && decodeMarketSnapshot(snap.data), ruling!.pre, ruling!.post);
    console.log(JSON.stringify({ market: key, resolve: ruling!.signature, snapshot: snapshot.toBase58(), counts,
      delay: Number(m.finishTs - m.endTs), ...Object.fromEntries((["pre", "post"] as const).map(side => {
        const r = ruling![side];
        return [side, [r.epoch, r.round, r.observationsTimestamp, toUi(r.median, m.priceDecimals, m.priceDecimals), pushes[side]]];
      })) }));
    expect(pushes.pre && pushes.post).toBeTruthy();
    expect(counts != null).toBe(witnessed);
    if (counts) expect(counts[1] - counts[0]).toBe(1);
  }, 180_000);
  it("reads the acceptance wallet's actual collateral transfer", async () => {
    const sig = "3jyJs7wr9JUn8dx9im8ijo93grp6Th8cNjoVNaidhY4XvscJQNbMWRMSvpeRS7oxDhXWMSwohg3tceRDQZ2LX8cY";
    const tx = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    const [row] = redemptionRows(tx!, sig, tx!.transaction.message.staticAccountKeys[0], program);
    expect(row.market.toBase58()).toBe("5fQX6eDjLWmfp2FMf2zrRmPTARPvLRLc3Xo8izo7rNFr");
    expect(row.payout).toEqual({ atoms: 2049999n, decimals: 6 });
    console.log("redeemed", row.side, row.payout, sig);
  }, 60_000);
});
