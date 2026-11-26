import { Buffer } from "buffer";
import { utils, type Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import type { PredictionMarket } from "@/idl/prediction_market";
import {
  areReportsAdjacent,
  parseOcr2State,
  parseOcr2Transmit,
  type Ocr2TransmitReport,
} from "./chainlink";
import { snapshotMatches, type DecodedMarketSnapshot } from "./codec";
import { CHAINLINK_OCR2_PROGRAM_ID } from "./constants";
import { ixResolveMarket } from "./instructions";
import { fetchMarketSnapshot, type MarketView } from "./markets";
import type { AnchorWalletLike } from "./program";
import { sendIxs } from "./send";

const OCR2_PROGRAM_KEY = new PublicKey(CHAINLINK_OCR2_PROGRAM_ID);
const MAX_SIGNATURE_PAGES = 20;
const SIGNATURES_PER_PAGE = 500;
export const TX_BATCH_SIZE = 8;

export type StraddlingReports = {
  pre: Ocr2TransmitReport;
  post: Ocr2TransmitReport;
  adjacent: boolean;
  certified: boolean;
  hasSnapshot: boolean;
};

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeIxData(raw: Uint8Array | string): Buffer {
  if (typeof raw === "string") {
    return Buffer.from(utils.bytes.bs58.decode(raw));
  }
  return Buffer.from(raw);
}

export function extractOcr2Instructions(
  tx: Awaited<ReturnType<Connection["getTransaction"]>>
): Buffer[] {
  if (!tx) return [];
  const message = tx.transaction.message;
  const accountKeys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined,
  });
  const out: Buffer[] = [];
  for (const ix of message.compiledInstructions) {
    const pid = accountKeys.get(ix.programIdIndex);
    if (pid && pid.equals(OCR2_PROGRAM_KEY)) {
      out.push(decodeIxData(ix.data));
    }
  }
  if (tx.meta?.innerInstructions) {
    for (const group of tx.meta.innerInstructions) {
      for (const ix of group.instructions) {
        const pid = accountKeys.get(ix.programIdIndex);
        if (pid && pid.equals(OCR2_PROGRAM_KEY)) {
          out.push(decodeIxData(ix.data));
        }
      }
    }
  }
  return out;
}

export async function fetchTxBatch(
  connection: Connection,
  signatures: string[],
  opts?: { strict?: boolean }
): Promise<Array<Awaited<ReturnType<Connection["getTransaction"]>>>> {
  if (!signatures.length) return [];
  try {
    return await connection.getTransactions(signatures, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (batchErr) {
    const out: Array<Awaited<ReturnType<Connection["getTransaction"]>>> = [];
    for (const sig of signatures) {
      try {
        out.push(
          await connection.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
        );
      } catch (err) {
        if (opts?.strict) throw err ?? batchErr;
        out.push(null);
      }
      await pause(120);
    }
    return out;
  }
}

async function collectSignaturesAround(
  connection: Connection,
  ocr2State: PublicKey,
  minTime: number
): Promise<ConfirmedSignatureInfo[]> {
  const all: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;

  for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
    const batch = await connection.getSignaturesForAddress(
      ocr2State,
      { limit: SIGNATURES_PER_PAGE, before },
      "confirmed"
    );
    if (!batch.length) break;
    all.push(...batch);
    const oldest = batch[batch.length - 1];
    if (oldest.blockTime != null && oldest.blockTime < minTime) break;
    if (batch.length < SIGNATURES_PER_PAGE) break;
    before = oldest.signature;
    await pause(80);
  }
  return all;
}

function pickStraddlingPair(
  reports: Ocr2TransmitReport[],
  endTs: number,
  rMax: number,
  snapshot: DecodedMarketSnapshot | null
): StraddlingReports | null {
  if (!reports.length) return null;
  const sorted = [...reports].sort((a, b) => {
    if (a.epoch !== b.epoch) return a.epoch - b.epoch;
    if (a.round !== b.round) return a.round - b.round;
    return a.observationsTimestamp - b.observationsTimestamp;
  });

  // Primary: find consecutive reports in our sorted list straddling endTs
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const pre = sorted[i];
    const post = sorted[i + 1];
    if (pre.observationsTimestamp < endTs && post.observationsTimestamp >= endTs) {
      const adjacent = areReportsAdjacent(pre, post, rMax);
      const certified = snapshot ? snapshotMatches(snapshot, pre, post) : false;
      if (adjacent || certified) {
        return {
          pre,
          post,
          adjacent,
          certified,
          hasSnapshot: Boolean(snapshot),
        };
      }
    }
  }
  return null;
}

export async function findStraddlingReports(
  connection: Connection,
  ocr2State: PublicKey,
  endTs: number,
  snapshot: DecodedMarketSnapshot | null
): Promise<StraddlingReports> {
  const stateInfo = await connection.getAccountInfo(ocr2State, "confirmed");
  if (!stateInfo) throw new Error("errors.wrongOracleState");
  const state = parseOcr2State(Buffer.from(stateInfo.data));

  const lookbackStart = endTs - 900;
  const sigs = await collectSignaturesAround(connection, ocr2State, lookbackStart);
  if (!sigs.length) throw new Error("errors.ocr2HistoryRange");

  const sigToReport = new Map<string, Ocr2TransmitReport>();
  const seenKey = new Set<string>();
  const collected: Ocr2TransmitReport[] = [];

  const absorbTxs = async (list: ConfirmedSignatureInfo[]) => {
    for (let i = 0; i < list.length; i += TX_BATCH_SIZE) {
      const chunk = list.slice(i, i + TX_BATCH_SIZE).filter((s) => !sigToReport.has(s.signature));
      if (!chunk.length) continue;
      const txs = await fetchTxBatch(
        connection,
        chunk.map((c) => c.signature)
      );
      txs.forEach((tx, idx) => {
        const sig = chunk[idx].signature;
        for (const ixData of extractOcr2Instructions(tx)) {
          const parsed = parseOcr2Transmit(ixData, state.latestConfigDigest, state.f);
          if (!parsed) continue;
          sigToReport.set(sig, parsed);
          const id = `${parsed.epoch}:${parsed.round}`;
          if (!seenKey.has(id)) {
            seenKey.add(id);
            collected.push(parsed);
          }
        }
      });
      const hit = pickStraddlingPair(collected, endTs, state.rMax, snapshot);
      if (hit) return hit;
      if (i + TX_BATCH_SIZE < list.length) await pause(90);
    }
    return null;
  };

  // Pass 1: focused window around endTs sorted by proximity
  const tight = sigs
    .filter((s) => s.blockTime == null || (s.blockTime >= endTs - 120 && s.blockTime <= endTs + 120))
    .sort((a, b) => Math.abs((a.blockTime ?? endTs) - endTs) - Math.abs((b.blockTime ?? endTs) - endTs));

  const hitTight = await absorbTxs(tight);
  if (hitTight) return hitTight;

  // Pass 2: wider window if Chainlink had a pause around endTs
  const tightSet = new Set(tight.map((s) => s.signature));
  const wide = sigs
    .filter(
      (s) =>
        !tightSet.has(s.signature) &&
        (s.blockTime == null || (s.blockTime >= endTs - 900 && s.blockTime <= endTs + 3600))
    )
    .sort((a, b) => Math.abs((a.blockTime ?? endTs) - endTs) - Math.abs((b.blockTime ?? endTs) - endTs))
    .slice(0, 64);

  const hitWide = await absorbTxs(wide);
  if (hitWide) return hitWide;

  const hasPre = collected.some((r) => r.observationsTimestamp < endTs);
  const hasPost = collected.some((r) => r.observationsTimestamp >= endTs);
  if (!hasPost) throw new Error("errors.ocr2NoPostReport");
  if (!hasPre) throw new Error("errors.ocr2NoPreReport");
  throw new Error("errors.unableCompleteCheckout");
}

export async function resolveMarketWithChainlink(
  connection: Connection,
  wallet: AnchorWalletLike,
  program: Program<PredictionMarket>,
  market: MarketView,
  prepared?: StraddlingReports
): Promise<string> {
  const found = prepared ?? await findStraddlingReports(
    connection, market.ocr2State, market.endTs, await fetchMarketSnapshot(connection, market.pdas.snapshot)
  );
  const ixs = await ixResolveMarket(program, market, wallet.publicKey, {
    rawPre: found.pre.raw,
    rawPost: found.post.raw,
    hasSnapshot: found.hasSnapshot,
  });
  return sendIxs(connection, wallet, ixs);
}
