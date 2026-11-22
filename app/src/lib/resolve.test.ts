// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Buffer as Buf } from "buffer";
import { utils, type Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import type { PredictionMarket } from "@/idl/prediction_market";
import {
  CHAINLINK_OCR2_PROGRAM_ID,
  MARKET_SNAPSHOT_DISCRIMINATOR,
} from "@/lib/constants";
import type { DecodedMarketSnapshot } from "@/lib/codec";
import type { MarketView } from "@/lib/markets";
import { findMarketPdas } from "@/lib/pdas";
import {
  findStraddlingReports,
  resolveMarketWithChainlink,
} from "@/lib/resolve";

const FIXTURES = path.resolve(
  process.cwd(),
  "../programs/prediction_market/tests/fixtures"
);

function fixture(name: string): Buffer {
  return Buf.from(readFileSync(path.join(FIXTURES, name)));
}

const OCR2_PROGRAM_KEY = new PublicKey(CHAINLINK_OCR2_PROGRAM_ID);
const OTHER_PROGRAM_KEY = new PublicKey(Buf.alloc(32, 9));
const OCR2_STATE_KEY = new PublicKey(Buf.alloc(32, 4));
const PROGRAM_ID = new PublicKey("CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER");

type TxSpec = {
  sig: string;
  blockTime: number | null;
  err?: unknown;
  ixs?: Array<{ programId: PublicKey; data: Uint8Array | string }>;
  innerIxs?: Array<{ programId: PublicKey; data: Uint8Array | string }>;
};

function makeFakeTx(spec: TxSpec) {
  const keys: PublicKey[] = [];
  const indexOf = (pk: PublicKey) => {
    const found = keys.findIndex((k) => k.equals(pk));
    if (found >= 0) return found;
    keys.push(pk);
    return keys.length - 1;
  };
  const compiledInstructions = (spec.ixs ?? []).map((ix) => ({
    programIdIndex: indexOf(ix.programId),
    data: ix.data,
  }));
  const innerInstructions = spec.innerIxs?.length
    ? [
        {
          index: 0,
          instructions: spec.innerIxs.map((ix) => ({
            programIdIndex: indexOf(ix.programId),
            data: ix.data,
          })),
        },
      ]
    : undefined;

  return {
    blockTime: spec.blockTime,
    meta: {
      err: spec.err ?? null,
      loadedAddresses: undefined,
      innerInstructions,
    },
    transaction: {
      message: {
        getAccountKeys: () => ({
          get: (idx: number) => keys[idx],
        }),
        compiledInstructions,
      },
    },
  };
}

function makeMockConnection(opts: {
  stateData?: Buffer | null;
  snapshotData?: Buffer | null;
  snapshotPda?: PublicKey;
  txs?: TxSpec[];
  failBatch?: boolean;
}) {
  const txs = opts.txs ?? [];
  const sigInfos = txs.map((t, idx) => ({
    signature: t.sig,
    slot: 100 + idx,
    err: t.err ?? null,
    memo: null,
    blockTime: t.blockTime,
  }));
  const txMap = new Map(txs.map((t) => [t.sig, makeFakeTx(t)]));

  const conn = {
    getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
      if (opts.snapshotPda && pubkey.equals(opts.snapshotPda)) {
        return opts.snapshotData ? { data: opts.snapshotData } : null;
      }
      if (pubkey.equals(OCR2_STATE_KEY)) {
        return opts.stateData ? { data: opts.stateData } : null;
      }
      return null;
    }),
    getSignaturesForAddress: vi.fn(async () => sigInfos),
    getTransactions: vi.fn(async (sigs: string[]) => {
      if (opts.failBatch) throw new Error("batch unsupported");
      return sigs.map((s) => txMap.get(s) ?? null);
    }),
    getTransaction: vi.fn(async (sig: string) => txMap.get(sig) ?? null),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 999,
    })),
    sendRawTransaction: vi.fn(async () => "mock-resolve-sig"),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
  };
  return conn as unknown as Connection & typeof conn;
}

function encodeSnapshot(
  entries: Array<{ epoch: number; round: number; counter: number; price?: bigint; ts?: bigint }>,
  bump = 255
): Buffer {
  const entrySize = 4 + 1 + 4 + 16 + 8;
  const headerSize = 8 + 4;
  const buf = Buf.alloc(headerSize + entries.length * entrySize + 1);
  buf.set(MARKET_SNAPSHOT_DISCRIMINATOR as unknown as number[], 0);
  buf.writeUInt32LE(entries.length, 8);
  entries.forEach((e, i) => {
    const off = headerSize + i * entrySize;
    buf.writeUInt32LE(e.epoch, off);
    buf.writeUInt8(e.round, off + 4);
    buf.writeUInt32LE(e.counter, off + 5);
    const price = e.price ?? 0n;
    buf.writeBigUInt64LE(BigInt.asUintN(64, price), off + 9);
    buf.writeBigInt64LE(price >> 64n, off + 17);
    buf.writeBigInt64LE(e.ts ?? 0n, off + 25);
  });
  buf.writeUInt8(bump, buf.length - 1);
  return buf;
}

function makeMarket(endTs: number): MarketView {
  const id = Array.from({ length: 16 }, (_, i) => i + 1);
  const pdas = findMarketPdas(PROGRAM_ID, id);
  const key = PublicKey.default;
  return {
    address: pdas.market,
    pdas,
    title: "BTC/USD >= 60,000",
    id,
    creator: key,
    collateralMint: key,
    yesMint: pdas.yesMint,
    noMint: pdas.noMint,
    status: "open",
    winner: null,
    expiry: endTs,
    endTs,
    finishTs: 0,
    bump: pdas.marketBump,
    yesPool: 0n,
    noPool: 0n,
    vault: 0n,
    decimals: 6,
    tokenProgram: key,
    yesPrice: 0.5,
    noPrice: 0.5,
    reserveYes: 100n,
    reserveNo: 100n,
    totalLpShares: 100n,
    ocr2State: OCR2_STATE_KEY,
    feedKey: "btc",
    feedSymbol: "BTC/USD",
    priceDecimals: 8,
    threshold: 60_000n * 10n ** 8n,
    settleAbove: true,
    settledPrice: 0n,
    settledPublishTime: 0,
    feeBps: 30,
    lastAccrualTs: 0,
    cumYesPerShare: 0n,
    cumNoPerShare: 0n,
  };
}

describe("findStraddlingReports", () => {
  const btcState = fixture("btc_state.bin");
  // e7190799_r6 (ts=1795254230) -> e7190800_r1 (ts=1795254233) -> r2 (1795254236) -> r3 (1795254239)
  const rPrevEpoch6 = fixture("e7190799_r6.bin");
  const r1 = fixture("e7190800_r1.bin");
  const r3 = fixture("e7190800_r3.bin");

  it("相邻轮次跨越 endTs（含跨 epoch 回卷 7190799_r6 -> 7190800_r1）返回 adjacent=true", async () => {
    const endTs = 1795254233; // 恰好等于 r1 的 observationsTimestamp (pre < endTs && post >= endTs)
    const conn = makeMockConnection({
      stateData: btcState,
      txs: [
        {
          sig: "sig-r1",
          blockTime: endTs,
          ixs: [{ programId: OCR2_PROGRAM_KEY, data: r1 }],
        },
        {
          sig: "sig-r6",
          blockTime: endTs - 3,
          ixs: [{ programId: OCR2_PROGRAM_KEY, data: rPrevEpoch6 }],
        },
      ],
    });

    const found = await findStraddlingReports(conn, OCR2_STATE_KEY, endTs, null);
    expect(found.pre.epoch).toBe(7190799);
    expect(found.pre.round).toBe(6);
    expect(found.post.epoch).toBe(7190800);
    expect(found.post.round).toBe(1);
    expect(found.adjacent).toBe(true);
    expect(found.certified).toBe(false);
    expect(found.hasSnapshot).toBe(false);
  });

  it("跳轮（r1 -> r3）且无快照时抛出 errors.unableCompleteCheckout", async () => {
    const endTs = 1795254235;
    const conn = makeMockConnection({
      stateData: btcState,
      txs: [
        {
          sig: "sig-r1",
          blockTime: endTs - 2,
          ixs: [{ programId: OCR2_PROGRAM_KEY, data: r1 }],
        },
        {
          sig: "sig-r3",
          blockTime: endTs + 4,
          ixs: [{ programId: OCR2_PROGRAM_KEY, data: r3 }],
        },
      ],
    });

    await expect(findStraddlingReports(conn, OCR2_STATE_KEY, endTs, null)).rejects.toThrow(
      "errors.unableCompleteCheckout"
    );
  });

  it("跳轮（r1 -> r3）但快照 counter 连续递增时通过 certified=true", async () => {
    const endTs = 1795254235;
    const snapshot: DecodedMarketSnapshot = {
      bump: 255,
      entries: [
        { epoch: 7190800, round: 1, counter: 10, price: 0n, ts: 0n },
        { epoch: 7190800, round: 3, counter: 11, price: 0n, ts: 0n },
      ],
    };
    const conn = makeMockConnection({
      stateData: btcState,
      txs: [
        {
          sig: "sig-r1",
          blockTime: endTs - 2,
          ixs: [{ programId: OCR2_PROGRAM_KEY, data: r1 }],
        },
        {
          sig: "sig-r3",
          blockTime: endTs + 4,
          ixs: [{ programId: OCR2_PROGRAM_KEY, data: r3 }],
        },
      ],
    });

    const found = await findStraddlingReports(conn, OCR2_STATE_KEY, endTs, snapshot);
    expect(found.pre.round).toBe(1);
    expect(found.post.round).toBe(3);
    expect(found.adjacent).toBe(false);
    expect(found.certified).toBe(true);
    expect(found.hasSnapshot).toBe(true);
  });

  it("Pass 2 宽窗口回退：post 签名 blockTime 落在 +300s 仍可找到", async () => {
    const endTs = 1795254232;
    const conn = makeMockConnection({
      stateData: btcState,
      txs: [
        // 仅 rPrevEpoch6 在 ±120s 紧凑窗口内
        {
          sig: "sig-pre",
          blockTime: endTs - 5,
          ixs: [{ programId: OCR2_PROGRAM_KEY, data: rPrevEpoch6 }],
        },
        // post 签名的 blockTime 超出 +120s，但在 +3600s 宽窗口内
        {
          sig: "sig-post-wide",
          blockTime: endTs + 300,
          ixs: [{ programId: OCR2_PROGRAM_KEY, data: r1 }],
        },
      ],
    });

    const found = await findStraddlingReports(conn, OCR2_STATE_KEY, endTs, null);
    expect(found.pre.round).toBe(6);
    expect(found.post.round).toBe(1);
    expect(conn.getTransactions).toHaveBeenCalledTimes(2);
  });

  it("批量 getTransactions 失败时降级到 getTransaction，并解析 innerInstructions + base58", async () => {
    const endTs = 1795254232;
    const conn = makeMockConnection({
      stateData: btcState,
      failBatch: true,
      txs: [
        {
          sig: "sig-pre",
          blockTime: endTs - 2,
          // 非 OCR2 程序指令应被忽略，从 innerInstructions 取出 base58 编码的 OCR2 指令
          ixs: [{ programId: OTHER_PROGRAM_KEY, data: Buf.from([1, 2, 3]) }],
          innerIxs: [
            { programId: OCR2_PROGRAM_KEY, data: utils.bytes.bs58.encode(rPrevEpoch6) },
          ],
        },
        {
          sig: "sig-post",
          blockTime: endTs + 1,
          innerIxs: [
            { programId: OCR2_PROGRAM_KEY, data: utils.bytes.bs58.encode(r1) },
          ],
        },
      ],
    });

    const found = await findStraddlingReports(conn, OCR2_STATE_KEY, endTs, null);
    expect(found.adjacent).toBe(true);
    expect(conn.getTransaction).toHaveBeenCalledTimes(2);
  });

  it("失败的预言机推送交易（tx.meta.err 非空）只要包含有效签名报告也会被提取结算", async () => {
    const endTs = 1795254233;
    const conn = makeMockConnection({
      stateData: btcState,
      txs: [
        {
          sig: "sig-pre-ok",
          blockTime: endTs - 3,
          ixs: [{ programId: OCR2_PROGRAM_KEY, data: rPrevEpoch6 }],
        },
        {
          sig: "sig-post-failed-tx",
          blockTime: endTs,
          err: { InstructionError: [0, { Custom: 1 }] },
          ixs: [{ programId: OCR2_PROGRAM_KEY, data: r1 }],
        },
      ],
    });

    const found = await findStraddlingReports(conn, OCR2_STATE_KEY, endTs, null);
    expect(found.pre.round).toBe(6);
    expect(found.post.round).toBe(1);
    expect(found.adjacent).toBe(true);
  });

  it("错误分类：缺失 state / 空历史 / 缺 post / 缺 pre", async () => {
    const endTs = 1795254232;

    await expect(
      findStraddlingReports(makeMockConnection({ stateData: null }), OCR2_STATE_KEY, endTs, null)
    ).rejects.toThrow("errors.wrongOracleState");

    await expect(
      findStraddlingReports(
        makeMockConnection({ stateData: btcState, txs: [] }),
        OCR2_STATE_KEY,
        endTs,
        null
      )
    ).rejects.toThrow("errors.ocr2HistoryRange");

    await expect(
      findStraddlingReports(
        makeMockConnection({
          stateData: btcState,
          txs: [
            {
              sig: "only-pre",
              blockTime: endTs - 2,
              ixs: [{ programId: OCR2_PROGRAM_KEY, data: rPrevEpoch6 }],
            },
          ],
        }),
        OCR2_STATE_KEY,
        endTs,
        null
      )
    ).rejects.toThrow("errors.ocr2NoPostReport");

    await expect(
      findStraddlingReports(
        makeMockConnection({
          stateData: btcState,
          txs: [
            {
              sig: "only-post",
              blockTime: endTs + 1,
              ixs: [{ programId: OCR2_PROGRAM_KEY, data: r1 }],
            },
          ],
        }),
        OCR2_STATE_KEY,
        endTs,
        null
      )
    ).rejects.toThrow("errors.ocr2NoPreReport");
  });
});

describe("resolveMarketWithChainlink", () => {
  it("读取快照并把 straddling 报告透传给 resolveMarket 指令与 sendIxs", async () => {
    const endTs = 1795254235;
    const market = makeMarket(endTs);
    const r1 = fixture("e7190800_r1.bin");
    const r3 = fixture("e7190800_r3.bin");
    const snapshotData = encodeSnapshot([
      { epoch: 7190800, round: 1, counter: 5 },
      { epoch: 7190800, round: 3, counter: 6 },
    ]);

    const conn = makeMockConnection({
      stateData: fixture("btc_state.bin"),
      snapshotData,
      snapshotPda: market.pdas.snapshot,
      txs: [
        { sig: "s1", blockTime: endTs - 2, ixs: [{ programId: OCR2_PROGRAM_KEY, data: r1 }] },
        { sig: "s3", blockTime: endTs + 4, ixs: [{ programId: OCR2_PROGRAM_KEY, data: r3 }] },
      ],
    });

    const resolveCalls: Array<{
      args: { rawPre: Buffer; rawPost: Buffer };
      accounts: Record<string, PublicKey | null>;
    }> = [];
    const program = {
      programId: PROGRAM_ID,
      methods: {
        resolveMarket: (args: { rawPre: Buffer; rawPost: Buffer }) => ({
          accountsPartial: (accounts: Record<string, PublicKey | null>) => {
            resolveCalls.push({ args, accounts });
            return {
              instruction: async () =>
                new TransactionInstruction({
                  programId: PROGRAM_ID,
                  keys: [],
                  data: Buf.alloc(0),
                }),
            };
          },
        }),
      },
    } as unknown as Program<PredictionMarket>;

    const signerKey = new PublicKey(Buf.alloc(32, 8));
    const wallet = {
      publicKey: signerKey,
      signTransaction: vi.fn(async () => ({ serialize: () => Buf.from([1, 2, 3]) })),
      signAllTransactions: vi.fn(async (txs) => txs),
    };

    const sig = await resolveMarketWithChainlink(
      conn,
      wallet as unknown as Parameters<typeof resolveMarketWithChainlink>[1],
      program,
      market
    );

    expect(sig).toBe("mock-resolve-sig");
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].args.rawPre.equals(r1)).toBe(true);
    expect(resolveCalls[0].args.rawPost.equals(r3)).toBe(true);
    expect(resolveCalls[0].accounts.snapshot?.equals(market.pdas.snapshot)).toBe(true);
    expect(resolveCalls[0].accounts.signer?.equals(signerKey)).toBe(true);
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
