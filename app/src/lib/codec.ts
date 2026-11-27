import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import {
  LP_POSITION_DISCRIMINATOR,
  MARKET_ACCOUNT_SIZE,
  MARKET_ACCOUNT_SIZE_V2,
  MARKET_DISCRIMINATOR,
  MARKET_SNAPSHOT_DISCRIMINATOR,
} from "./constants";
import type { MarketStatusName, Side } from "./types";

const I80F48_SCALE = 2n ** 48n;

export type DecodedMarket = {
  expiry: bigint;
  creator: PublicKey;
  id: number[];
  bump: number;
  yesMint: PublicKey;
  noMint: PublicKey;
  status: MarketStatusName;
  collateralMint: PublicKey;
  winner: Side | null;
  marketCollateralBump: number;
  prediction: number[];
  finishTs: bigint;
  lZero: bigint;
  lastAccrualTs: bigint;
  cumYesPerShare: bigint;
  cumNoPerShare: bigint;
  feeBps: number;
  reserveYes: bigint;
  reserveNo: bigint;
  totalLpShares: bigint;
  startTs: bigint;
  endTs: bigint;
  ocr2State: PublicKey;
  threshold: bigint;
  priceDecimals: number;
  settleAbove: boolean;
  settledPrice: bigint;
  settledPublishTime: bigint;
};

export type DecodedLpPosition = {
  owner: PublicKey;
  shares: bigint;
  checkpointYes: bigint;
  checkpointNo: bigint;
  bump: number;
};

export type DecodedSnapshotEntry = {
  epoch: number;
  round: number;
  counter: number;
  price: bigint;
  ts: bigint;
};

export type DecodedMarketSnapshot = {
  entries: DecodedSnapshotEntry[];
  bump: number;
};

class Cursor {
  constructor(private buf: Buffer, private offset = 0) {}
  rest(): number {
    return this.buf.length - this.offset;
  }
  take(n: number): Buffer {
    if (this.offset + n > this.buf.length) throw new Error("errors.decode");
    const slice = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
  u8(): number {
    return this.take(1)[0];
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    return this.take(2).readUInt16LE(0);
  }
  u32(): number {
    return this.take(4).readUInt32LE(0);
  }
  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }
  i64(): bigint {
    return this.take(8).readBigInt64LE(0);
  }
  i128(): bigint {
    const lo = this.take(8).readBigUInt64LE(0);
    const hi = this.take(8).readBigInt64LE(0);
    return (hi << 64n) + lo;
  }
  pubkey(): PublicKey {
    return new PublicKey(this.take(32));
  }
  bytes(n: number): number[] {
    return Array.from(this.take(n));
  }
}

function sameDisc(actual: Buffer, expected: readonly number[]): boolean {
  if (actual.length < 8) return false;
  for (let i = 0; i < 8; i += 1) if (actual[i] !== expected[i]) return false;
  return true;
}

function statusFromU8(value: number): MarketStatusName {
  if (value === 0) return "open";
  if (value === 1) return "resolved";
  if (value === 2) return "windowBurn";
  if (value === 3) return "staleBurn";
  throw new Error("errors.decode");
}

function sideFromU8(value: number): Side {
  if (value === 0) return "yes";
  if (value === 1) return "no";
  throw new Error("errors.decode");
}

function optionSide(c: Cursor): Side | null {
  const tag = c.u8();
  if (tag === 0) return null;
  if (tag === 1) return sideFromU8(c.u8());
  throw new Error("errors.decode");
}

export function decodeMarket(data: Buffer): DecodedMarket {
  const isV2 = data.length === MARKET_ACCOUNT_SIZE_V2;
  const isLegacy = data.length === MARKET_ACCOUNT_SIZE;
  if ((!isLegacy && !isV2) || !sameDisc(data, MARKET_DISCRIMINATOR)) {
    throw new Error("errors.decode");
  }
  const c = new Cursor(data, 8);
  const expiry = c.u64();
  const creator = c.pubkey();
  const id = c.bytes(16);
  const bump = c.u8();
  const yesMint = c.pubkey();
  const noMint = c.pubkey();
  const status = statusFromU8(c.u8());
  const collateralMint = c.pubkey();
  const winner = optionSide(c);
  const marketCollateralBump = c.u8();
  const prediction = c.bytes(64);
  const finishTs = c.u64();
  const lZero = c.i128();
  const lastAccrualTs = c.i64();
  const cumYesPerShare = c.i128();
  const cumNoPerShare = c.i128();
  const feeBps = isLegacy ? c.u16() : 0;
  const reserveYes = c.i128();
  const reserveNo = c.i128();
  const totalLpShares = c.i128();
  const startTs = isV2 ? c.i64() : 0n;
  const endTs = c.i64();
  const ocr2State = c.pubkey();
  const threshold = c.i64();
  const priceDecimals = c.u8();
  const settleAbove = c.bool();
  const settledPrice = c.i64();
  const settledPublishTime = c.i64();

  if (priceDecimals !== 8) throw new Error("errors.unsupportedDecimals");

  return {
    expiry,
    creator,
    id,
    bump,
    yesMint,
    noMint,
    status,
    collateralMint,
    winner,
    marketCollateralBump,
    prediction,
    finishTs,
    lZero,
    lastAccrualTs,
    cumYesPerShare,
    cumNoPerShare,
    feeBps,
    reserveYes,
    reserveNo,
    totalLpShares,
    startTs,
    endTs,
    ocr2State,
    threshold,
    priceDecimals,
    settleAbove,
    settledPrice,
    settledPublishTime,
  };
}

export function decodeLpPosition(data: Buffer): DecodedLpPosition {
  if (!sameDisc(data, LP_POSITION_DISCRIMINATOR)) throw new Error("errors.decode");
  const c = new Cursor(data, 8);
  return {
    owner: c.pubkey(),
    shares: c.i128(),
    checkpointYes: c.i128(),
    checkpointNo: c.i128(),
    bump: c.u8(),
  };
}

export function decodeMarketSnapshot(data: Buffer): DecodedMarketSnapshot {
  if (!sameDisc(data, MARKET_SNAPSHOT_DISCRIMINATOR)) throw new Error("errors.decode");
  const c = new Cursor(data, 8);
  const len = c.u32();
  if (len > 16) throw new Error("errors.decode");
  const entries: DecodedSnapshotEntry[] = [];
  for (let i = 0; i < len; i += 1) {
    const epoch = c.u32();
    const round = c.u8();
    const counter = c.u32();
    const price = c.i128();
    const ts = c.i64();
    entries.push({ epoch, round, counter, price, ts });
  }
  const bump = c.u8();
  return { entries, bump };
}

export function snapshotMatches(
  snapshot: DecodedMarketSnapshot,
  pre: { epoch: number; round: number },
  post: { epoch: number; round: number }
): boolean {
  for (let i = 0; i < snapshot.entries.length; i += 1) {
    const x = snapshot.entries[i];
    if (x.epoch !== pre.epoch || x.round !== pre.round) continue;
    const next = snapshot.entries[i + 1];
    if (!next) return false;
    return (
      next.counter === x.counter + 1 &&
      next.round === post.round &&
      next.epoch === post.epoch
    );
  }
  return false;
}

export function i80f48ToNumber(bits: bigint): number {
  return Number(bits) / Number(I80F48_SCALE);
}

export function i80f48ToAmount(bits: bigint): bigint {
  if (bits >= 0n) return bits / I80F48_SCALE;
  return -((-bits) / I80F48_SCALE);
}

export function computePending(
  sharesBits: bigint,
  checkpointYes: bigint,
  checkpointNo: bigint,
  cumYes: bigint,
  cumNo: bigint
): { yes: bigint; no: bigint } {
  const shares = i80f48ToNumber(sharesBits);
  if (shares <= 0) return { yes: 0n, no: 0n };
  const dy = Math.max(0, i80f48ToNumber(cumYes - checkpointYes) * shares);
  const dn = Math.max(0, i80f48ToNumber(cumNo - checkpointNo) * shares);
  return { yes: BigInt(Math.floor(dy)), no: BigInt(Math.floor(dn)) };
}
