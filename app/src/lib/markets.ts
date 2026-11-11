import { Program, utils } from "@coral-xyz/anchor";
import { Buffer } from "buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import type { PredictionMarket } from "@/idl/prediction_market";
import { computePending, decodeLpPosition, decodeMarket, i80f48ToAmount, type DecodedMarket } from "./codec";
import { MARKET_DISCRIMINATOR, RESOLVE_WINDOW } from "./constants";
import { decodePrediction } from "./format";
import { feedByHex } from "./feeds";
import { findLpPosition, findMarketPdas } from "./pdas";
import { impliedYesPrice, reserveAmount } from "./quote";
import { ataOf, getMultiple, tokenProgramOf, unpackAmount, unpackDecimals } from "./tokens";
import type { MarketPdas, MarketStatusName, Side } from "./types";

const TOKENKNG = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export type MarketView = {
  address: PublicKey;
  pdas: MarketPdas;
  title: string;
  id: number[];
  creator: PublicKey;
  collateralMint: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  status: MarketStatusName;
  winner: Side;
  expiry: number;
  endTs: number;
  bump: number;
  yesPool: bigint;
  noPool: bigint;
  vault: bigint;
  decimals: number;
  tokenProgram: PublicKey;
  yesPrice: number;
  noPrice: number;
  reserveYes: bigint;
  reserveNo: bigint;
  totalLpShares: bigint;
  feedId: number[];
  feedHex: string;
  feedSymbol: string;
  threshold: bigint;
  exponent: number;
  settleAbove: boolean;
  settledPrice: bigint;
  settledPublishTime: number;
  feeBps: number;
  lastAccrualTs: number;
  cumYesPerShare: bigint;
  cumNoPerShare: bigint;
};

export type UserPosition = {
  collateral: bigint;
  yes: bigint;
  no: bigint;
  lpShares: bigint;
  pendingYes: bigint;
  pendingNo: bigint;
};

export const EMPTY_POSITION: UserPosition = {
  collateral: 0n,
  yes: 0n,
  no: 0n,
  lpShares: 0n,
  pendingYes: 0n,
  pendingNo: 0n,
};

export function marketPhase(market: { status: MarketStatusName; expiry: number }, now = Math.floor(Date.now() / 1000)) {
  const expired = now >= market.expiry;
  const inWindow = expired && now <= market.expiry + RESOLVE_WINDOW;
  const afterWindow = now > market.expiry + RESOLVE_WINDOW;
  return {
    live: market.status === "open" && !expired,
    expired,
    inWindow,
    afterWindow,
  };
}

function buildView(
  programId: PublicKey,
  address: PublicKey,
  account: DecodedMarket,
  extras: {
    yesPool: bigint;
    noPool: bigint;
    vault: bigint;
    decimals: number;
    tokenProgram: PublicKey;
  }
): MarketView {
  const pdas = findMarketPdas(programId, account.id);
  const reserveYes = reserveAmount(account.reserveYes);
  const reserveNo = reserveAmount(account.reserveNo);
  const yesPrice = impliedYesPrice(reserveYes, reserveNo);
  const hex = Buffer.from(account.feedId).toString("hex");
  const preset = feedByHex(hex);
  return {
    address,
    pdas,
    title: decodePrediction(account.prediction),
    id: account.id,
    creator: account.creator,
    collateralMint: account.collateralMint,
    yesMint: account.yesMint,
    noMint: account.noMint,
    status: account.status,
    winner: account.winner,
    expiry: Number(account.expiry),
    endTs: Number(account.endTs),
    bump: account.bump,
    yesPool: extras.yesPool,
    noPool: extras.noPool,
    vault: extras.vault,
    decimals: extras.decimals,
    tokenProgram: extras.tokenProgram,
    yesPrice,
    noPrice: 1 - yesPrice,
    reserveYes,
    reserveNo,
    totalLpShares: i80f48ToAmount(account.totalLpShares),
    feedId: account.feedId,
    feedHex: hex,
    feedSymbol: preset?.symbol ?? hex.slice(0, 8),
    threshold: account.threshold,
    exponent: account.exponent,
    settleAbove: account.settleAbove,
    settledPrice: account.settledPrice,
    settledPublishTime: Number(account.settledPublishTime),
    feeBps: account.feeBps,
    lastAccrualTs: Number(account.lastAccrualTs),
    cumYesPerShare: account.cumYesPerShare,
    cumNoPerShare: account.cumNoPerShare,
  };
}

export async function fetchMarkets(
  connection: Connection,
  program: Program<PredictionMarket>
): Promise<MarketView[]> {
  const disc = Buffer.from(MARKET_DISCRIMINATOR);
  const rows = await connection.getProgramAccounts(program.programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(disc) } }],
  });
  const decoded: { address: PublicKey; account: DecodedMarket }[] = [];
  for (const row of rows) {
    try {
      decoded.push({ address: row.pubkey, account: decodeMarket(row.account.data) });
    } catch {
      // skip legacy or undecodable layouts
    }
  }
  if (!decoded.length) return [];

  const pdas = decoded.map((row) => findMarketPdas(program.programId, row.account.id));
  const mintKeys = Array.from(
    new Set(decoded.map((row) => row.account.collateralMint.toBase58()))
  ).map((s) => new PublicKey(s));

  const keys: PublicKey[] = [];
  for (const pda of pdas) keys.push(pda.yesPool, pda.noPool, pda.collateralVault);
  keys.push(...mintKeys);

  const infos = await getMultiple(connection, keys);
  const mintInfo = new Map<string, (typeof infos)[number]>();
  mintKeys.forEach((mint, i) => {
    mintInfo.set(mint.toBase58(), infos[pdas.length * 3 + i] ?? null);
  });

  return decoded
    .map((row, i) => {
      const pda = pdas[i];
      const base = i * 3;
      const collateralInfo = mintInfo.get(row.account.collateralMint.toBase58()) ?? null;
      const tokenProgram = collateralInfo ? tokenProgramOf(collateralInfo.owner) : TOKENKNG;
      return buildView(program.programId, row.address, row.account, {
        yesPool: unpackAmount(pda.yesPool, infos[base], tokenProgram),
        noPool: unpackAmount(pda.noPool, infos[base + 1], tokenProgram),
        vault: unpackAmount(pda.collateralVault, infos[base + 2], tokenProgram),
        decimals: unpackDecimals(row.account.collateralMint, collateralInfo, tokenProgram),
        tokenProgram,
      });
    })
    .sort((a, b) => b.expiry - a.expiry);
}

export async function fetchMarket(
  connection: Connection,
  program: Program<PredictionMarket>,
  address: PublicKey
): Promise<MarketView> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new Error("errors.accountMissing");
  const account = decodeMarket(info.data);
  const pdas = findMarketPdas(program.programId, account.id);
  const keys = [pdas.yesPool, pdas.noPool, pdas.collateralVault, account.collateralMint];
  const infos = await getMultiple(connection, keys);
  const collateralInfo = infos[3];
  if (!collateralInfo) throw new Error("errors.mintNotFound");
  const tokenProgram = tokenProgramOf(collateralInfo.owner);
  return buildView(program.programId, address, account, {
    yesPool: unpackAmount(pdas.yesPool, infos[0], tokenProgram),
    noPool: unpackAmount(pdas.noPool, infos[1], tokenProgram),
    vault: unpackAmount(pdas.collateralVault, infos[2], tokenProgram),
    decimals: unpackDecimals(account.collateralMint, collateralInfo, tokenProgram),
    tokenProgram,
  });
}

export async function fetchPosition(
  connection: Connection,
  programId: PublicKey,
  market: MarketView,
  owner: PublicKey
): Promise<UserPosition> {
  const { tokenProgram, pdas, collateralMint } = market;
  const [lpPda] = findLpPosition(programId, market.address, owner);
  const keys = [
    ataOf(collateralMint, owner, tokenProgram),
    ataOf(pdas.yesMint, owner, tokenProgram),
    ataOf(pdas.noMint, owner, tokenProgram),
    lpPda,
  ];
  const infos = await getMultiple(connection, keys);
  let lpShares = 0n;
  let pendingYes = 0n;
  let pendingNo = 0n;
  const lpInfo = infos[3];
  if (lpInfo) {
    try {
      const pos = decodeLpPosition(lpInfo.data);
      lpShares = i80f48ToAmount(pos.shares);
      const pending = computePending(
        pos.shares,
        pos.checkpointYes,
        pos.checkpointNo,
        market.cumYesPerShare,
        market.cumNoPerShare
      );
      pendingYes = pending.yes;
      pendingNo = pending.no;
    } catch {
      lpShares = 0n;
    }
  }
  return {
    collateral: unpackAmount(keys[0], infos[0], tokenProgram),
    yes: unpackAmount(keys[1], infos[1], tokenProgram),
    no: unpackAmount(keys[2], infos[2], tokenProgram),
    lpShares,
    pendingYes,
    pendingNo,
  };
}


