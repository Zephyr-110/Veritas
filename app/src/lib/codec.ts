import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { LP_POSITION_DISCRIMINATOR, MARKET_DISCRIMINATOR } from "./constants";
import { parseSide, parseStatus } from "./format";
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
  winner: Side;
  marketCollateralBump: number;
  prediction: number[];
  lZero: bigint;
  lastAccrualTs: bigint;
  cumYesPerShare: bigint;
  cumNoPerShare: bigint;
  feeBps: number;
  reserveYes: bigint;
  reserveNo: bigint;
  totalLpShares: bigint;
  endTs: bigint;
  feedId: number[];
  threshold: bigint;
  exponent: number;
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
  i32(): number {
    return this.take(4).readInt32LE(0);
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
  if (value === 0) return "upcoming";
  if (value === 1) return "open";
  if (value === 2) return "resolved";
  if (value === 3) return "burn";
  return parseStatus(value);
}

function sideFromU8(value: number): Side {
  if (value === 0) return "yes";
  if (value === 1) return "no";
  return parseSide(value);
}

export function decodeMarket(data: Buffer): DecodedMarket {
  if (!sameDisc(data, MARKET_DISCRIMINATOR)) throw new Error("errors.decode");
  const c = new Cursor(data, 8);
  return {
    expiry: c.u64(),
    creator: c.pubkey(),
    id: c.bytes(16),
    bump: c.u8(),
    yesMint: c.pubkey(),
    noMint: c.pubkey(),
    status: statusFromU8(c.u8()),
    collateralMint: c.pubkey(),
    winner: sideFromU8(c.u8()),
    marketCollateralBump: c.u8(),
    prediction: c.bytes(64),
    lZero: c.i128(),
    lastAccrualTs: c.i64(),
    cumYesPerShare: c.i128(),
    cumNoPerShare: c.i128(),
    feeBps: c.u16(),
    reserveYes: c.i128(),
    reserveNo: c.i128(),
    totalLpShares: c.i128(),
    endTs: c.i64(),
    feedId: c.bytes(32),
    threshold: c.i64(),
    exponent: c.i32(),
    settleAbove: c.bool(),
    settledPrice: c.i64(),
    settledPublishTime: c.i64(),
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

export function i80f48ToNumber(bits: bigint): number {
  return Number(bits) / Number(I80F48_SCALE);
}

export function i80f48ToAmount(bits: bigint): bigint {
  if (bits >= 0n) return bits / I80F48_SCALE;
  return -((-bits) / I80F48_SCALE);
}

export function amountToI80f48(amount: bigint): bigint {
  return amount * I80F48_SCALE;
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

export type PythPrint = {
  feedId: Uint8Array;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  prevPublishTime: bigint;
};

export function decodePythPrint(data: Buffer, expectedFeed?: Uint8Array): PythPrint | null {
  if (data.length < 80) return null;
  const needle = expectedFeed ? Buffer.from(expectedFeed) : null;
  let offset = -1;
  if (needle) {
    offset = data.indexOf(needle);
  }
  if (offset < 0) {
    // PriceUpdateV2: disc(8) + write_authority(32) + verification
    let cursor = 8 + 32;
    if (data.length <= cursor) return null;
    const level = data[cursor];
    cursor += level === 0 ? 2 : 1;
    offset = cursor;
  }
  if (offset < 0 || offset + 76 > data.length) return null;
  const feedId = data.subarray(offset, offset + 32);
  const price = data.readBigInt64LE(offset + 32);
  const conf = data.readBigUInt64LE(offset + 40);
  const exponent = data.readInt32LE(offset + 48);
  const publishTime = data.readBigInt64LE(offset + 52);
  const prevPublishTime = data.readBigInt64LE(offset + 60);
  return { feedId, price, conf, exponent, publishTime, prevPublishTime };
}

export function pythToNumber(price: bigint, exponent: number): number {
  return Number(price) * 10 ** exponent;
}
