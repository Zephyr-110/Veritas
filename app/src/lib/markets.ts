import { Program, utils } from "@coral-xyz/anchor";
import { unpackAccount } from "@solana/spl-token";
import { Buffer } from "buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import type { PredictionMarket } from "@/idl/prediction_market";
import {
  computePending,
  decodeLpPosition,
  decodeMarket,
  decodeMarketSnapshot,
  i80f48ToAmount,
  type DecodedMarket,
  type DecodedMarketSnapshot,
} from "./codec";
import {
  CLAIM_WINDOW,
  LP_POSITION_DISCRIMINATOR,
  MARKET_DISCRIMINATOR,
  RESOLVE_WINDOW,
  SNAPSHOT_WINDOW,
} from "./constants";
import { feedByState } from "./feeds";
import { decodePrediction } from "./format";
import { findLpPosition, findMarketPdas } from "./pdas";
import { impliedYesPrice, pmAmmLeff, reserveAmount } from "./quote";
import { ataOf, getMultiple, tokenProgramOf, unpackAmount, unpackDecimals } from "./tokens";
import type { FeedKey, MarketPdas, MarketStatusName, Side } from "./types";

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
  winner: Side | null;
  expiry: number;
  startTs?: number;
  endTs: number;
  finishTs: number;
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
  ocr2State: PublicKey;
  feedKey: FeedKey | null;
  feedSymbol: string;
  priceDecimals: number;
  threshold: bigint;
  settleAbove: boolean;
  settledPrice: bigint;
  settledPublishTime: number;
  feeBps: number;
  lZero?: bigint;
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

export function isVoidedStatus(status: MarketStatusName): boolean {
  return status === "windowBurn" || status === "staleBurn";
}

export function isFinalizedStatus(status: MarketStatusName): boolean {
  return status === "resolved" || isVoidedStatus(status);
}

/**
 * Single source of truth for redeemable collateral atoms matching on-chain
 * `get_collateral.rs`: winner redeems 1:1; voided markets redeem each mint
 * independently at `floor(amount / 2)` (`yes / 2n + no / 2n`).
 */
export function claimableOf(
  market: Pick<MarketView, "status" | "winner">,
  position: Pick<UserPosition, "yes" | "no">
): bigint {
  if (market.status === "resolved") {
    return market.winner === "yes" ? position.yes : market.winner === "no" ? position.no : 0n;
  }
  if (isVoidedStatus(market.status)) {
    return position.yes / 2n + position.no / 2n;
  }
  return 0n;
}

export function pendingValueOf(
  market: Pick<MarketView, "status" | "winner">,
  position: Pick<UserPosition, "pendingYes" | "pendingNo">
): bigint {
  if (market.status === "resolved") {
    return market.winner === "yes" ? position.pendingYes : market.winner === "no" ? position.pendingNo : 0n;
  }
  if (isVoidedStatus(market.status)) {
    return position.pendingYes / 2n + position.pendingNo / 2n;
  }
  return position.pendingYes + position.pendingNo;
}

export function marketPhase(
  market: { status: MarketStatusName; expiry: number; endTs?: number; finishTs?: number },
  now = Math.floor(Date.now() / 1000)
) {
  const endTs = market.endTs ?? market.expiry;
  const expired = now >= market.expiry;
  const inWindow = expired && now <= market.expiry + RESOLVE_WINDOW;
  const afterWindow = now > market.expiry + RESOLVE_WINDOW;
  const inSnapshotWindow =
    market.status === "open" && now > endTs - SNAPSHOT_WINDOW && now < endTs + SNAPSHOT_WINDOW;
  const finishTs = market.finishTs ?? 0;
  const canBurn =
    isFinalizedStatus(market.status) && finishTs > 0 && now > finishTs + CLAIM_WINDOW;
  return {
    live: market.status === "open" && !expired,
    expired,
    inWindow,
    afterWindow,
    inSnapshotWindow,
    canBurn,
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
  const lEff =
    account.lZero > 0n && account.endTs > account.lastAccrualTs
      ? pmAmmLeff(account.lZero, Number(account.endTs - account.lastAccrualTs))
      : 0;
  const yesPrice = impliedYesPrice(reserveYes, reserveNo, lEff > 0 ? lEff : undefined);
  const preset = feedByState(account.ocr2State);
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
    startTs: account.startTs > 0n ? Number(account.startTs) : undefined,
    endTs: Number(account.endTs),
    finishTs: Number(account.finishTs),
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
    ocr2State: account.ocr2State,
    feedKey: preset?.key ?? null,
    feedSymbol: preset?.symbol ?? account.ocr2State.toBase58().slice(0, 8),
    priceDecimals: account.priceDecimals,
    threshold: account.threshold,
    settleAbove: account.settleAbove,
    settledPrice: account.settledPrice,
    settledPublishTime: Number(account.settledPublishTime),
    feeBps: account.feeBps,
    lZero: account.lZero,
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
    filters: [
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(disc) } },
    ],
  });
  const decoded: { address: PublicKey; account: DecodedMarket }[] = [];
  for (const row of rows) {
    try {
      decoded.push({ address: row.pubkey, account: decodeMarket(Buffer.from(row.account.data)) });
    } catch {
      // skip legacy or undecodable layouts
    }
  }
  if (!decoded.length) return [];

  const open = decoded.filter(({ account }) => account.status === "open");
  const pdas = open.map(({ account }) => findMarketPdas(program.programId, account.id));
  const openIndex = new Map(open.map((row, i) => [row, i]));
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
    .map((row) => {
      const index = openIndex.get(row);
      const pda = index === undefined ? undefined : pdas[index];
      const base = (index ?? 0) * 3;
      const collateralInfo = mintInfo.get(row.account.collateralMint.toBase58()) ?? null;
      const tokenProgram = collateralInfo ? tokenProgramOf(collateralInfo.owner) : TOKENKNG;
      return buildView(program.programId, row.address, row.account, {
        yesPool: pda ? unpackAmount(pda.yesPool, infos[base], tokenProgram) : 0n,
        noPool: pda ? unpackAmount(pda.noPool, infos[base + 1], tokenProgram) : 0n,
        vault: pda ? unpackAmount(pda.collateralVault, infos[base + 2], tokenProgram) : 0n,
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
  const account = decodeMarket(Buffer.from(info.data));
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

export async function fetchMarketSnapshot(
  connection: Connection,
  snapshotPda: PublicKey
): Promise<DecodedMarketSnapshot | null> {
  const info = await connection.getAccountInfo(snapshotPda, "confirmed");
  if (!info) return null;
  try {
    return decodeMarketSnapshot(Buffer.from(info.data));
  } catch {
    return null;
  }
}

function lpBalances(market: MarketView, lpInfo?: Awaited<ReturnType<Connection["getAccountInfo"]>>) {
  let lpShares = 0n;
  let pendingYes = 0n;
  let pendingNo = 0n;
  if (lpInfo) {
    try {
      const pos = decodeLpPosition(Buffer.from(lpInfo.data));
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
  return { lpShares, pendingYes, pendingNo };
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
  return {
    collateral: unpackAmount(keys[0], infos[0], tokenProgram),
    yes: unpackAmount(keys[1], infos[1], tokenProgram),
    no: unpackAmount(keys[2], infos[2], tokenProgram),
    ...lpBalances(market, infos[3]),
  };
}

export async function fetchPositionsBatch(
  connection: Connection,
  programId: PublicKey,
  markets: MarketView[],
  owner: PublicKey
): Promise<Array<{ market: MarketView; position: UserPosition }>> {
  if (!markets.length) return [];
  const programs = new Set(markets.map((market) => market.tokenProgram.toBase58()));
  const [tokenGroups, lpRows] = await Promise.all([
    Promise.all([...programs].map((id) =>
      connection.getTokenAccountsByOwner(owner, { programId: new PublicKey(id) }, "confirmed")
    )),
    connection.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(Buffer.from(LP_POSITION_DISCRIMINATOR)) } },
        { memcmp: { offset: 8, bytes: owner.toBase58() } },
      ],
    }),
  ]);
  const balances = new Map<string, bigint>();
  for (const group of tokenGroups) {
    for (const { pubkey, account } of group.value) {
      const token = unpackAccount(pubkey, account, account.owner);
      const mint = token.mint.toBase58();
      balances.set(mint, (balances.get(mint) ?? 0n) + token.amount);
    }
  }
  const lpByAddress = new Map(lpRows.map((row) => [row.pubkey.toBase58(), row.account]));
  return markets.flatMap((market) => {
    const yes = balances.get(market.yesMint.toBase58()) ?? 0n;
    const no = balances.get(market.noMint.toBase58()) ?? 0n;
    const lpInfo = lpByAddress.size
      ? lpByAddress.get(findLpPosition(programId, market.address, owner)[0].toBase58())
      : undefined;
    if (!yes && !no && !lpInfo) return [];
    return [{ market, position: {
      collateral: balances.get(market.collateralMint.toBase58()) ?? 0n,
      yes, no, ...lpBalances(market, lpInfo),
    } }];
  });
}
