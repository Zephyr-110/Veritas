import { PublicKey } from "@solana/web3.js";
import { areReportsAdjacent } from "./chainlink";
import { SERVICE_FEE_BPS } from "./constants";
import type { DurationFilter } from "./display";
import { bytesFromHex } from "./format";
import { findMarketPdas } from "./pdas";
import { currentMarketFeeBps } from "./quote";
import type { MarketView, UserPosition } from "./markets";
import type { FeedKey, MarketPdas, MarketStatusName, Side } from "./types";

export type ListSectionFilter = "live" | "unsettled" | "ended" | "all";

export type SerializedMarket = {
  address: string;
  programId: string;
  idHex: string;
  bump: number;
  creator: string;
  title: string;
  feedKey: FeedKey | null;
  feedSymbol: string;
  ocr2State: string;
  collateralMint: string;
  tokenProgram: string;
  decimals: number;
  yesMint: string;
  noMint: string;
  openedAt: number | null;
  startTs?: number | null;
  expiry: number;
  endTs: number;
  finishTs: number;
  durationSec: number | null;
  durationBucket: Exclude<DurationFilter, "all"> | null;
  status: MarketStatusName;
  winner: Side | null;
  threshold: string;
  priceDecimals: number;
  settleAbove: boolean;
  settledPrice: string;
  settledPublishTime: number;
  feeBps: number;
  lZero: string;
  lastAccrualTs: number;
  cumYesPerShare: string;
  cumNoPerShare: string;
  reserveYes: string;
  reserveNo: string;
  totalLpShares: string;
  yesPool: string;
  noPool: string;
  vault: string;
  yesPrice: number;
  noPrice: number;
  updatedAt: number;
};

export type MarketsPageResponse = {
  items: SerializedMarket[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  indexedAt: number | null;
  source: "sqlite";
};

export type SettlementEvidenceDto = {
  marketAddress: string;
  programId: string;
  feedAddress: string | null;
  snapshotAddress: string;
  resolveSignature: string;
  resolveTxUrl: string | null;
  settledPrice: string;
  priceDecimals: number;
  winner: Side | null;
  status: MarketStatusName;
  preEpoch: number;
  preRound: number;
  preCounter: number | null;
  prePrice: string;
  preTimestamp: number;
  prePushSignature: string | null;
  prePushTxUrl: string | null;
  postEpoch: number;
  postRound: number;
  postCounter: number | null;
  postPrice: string;
  postTimestamp: number;
  postPushSignature: string | null;
  postPushTxUrl: string | null;
  missingCount: number | null;
  createdAt: number;
};

export type EvidenceResponse = {
  found: boolean;
  complete?: boolean;
  healed?: boolean;
  healError?: boolean;
  evidence: SettlementEvidenceDto | null;
};

export const DEFAULT_OCR2_R_MAX = 6;

export function isAdjacentEvidence(
  ev: Pick<SettlementEvidenceDto, "status" | "preEpoch" | "preRound" | "postEpoch" | "postRound">,
  rMax = DEFAULT_OCR2_R_MAX
): boolean {
  return (
    ev.status === "resolved" &&
    areReportsAdjacent(
      { epoch: ev.preEpoch, round: ev.preRound },
      { epoch: ev.postEpoch, round: ev.postRound },
      rMax
    )
  );
}

export function isEvidenceComplete(
  ev: SettlementEvidenceDto | null | undefined,
  rMax = DEFAULT_OCR2_R_MAX
): boolean {
  if (!ev) return false;
  if (!ev.resolveSignature || !ev.prePushSignature || !ev.postPushSignature) return false;
  const hasCounters =
    ev.preCounter != null && ev.postCounter != null && ev.missingCount != null;
  return hasCounters || isAdjacentEvidence(ev, rMax);
}

export type WalletPositionItemDto = {
  market: SerializedMarket;
  yes: string;
  no: string;
  lpShares: string;
  pendingYes: string;
  pendingNo: string;
  claimableAmount: string;
  canClaim: boolean;
  collateral: string;
  updatedAt: number;
};

export type WalletPositionsSummaryDto = {
  totalMarkets: number;
  sumYes: number;
  sumNo: number;
  sumPending: number;
  claimCount: number;
  claimTotal: number;
  lpUnclaimed: boolean;
};

export type WalletPositionsPageResponse = {
  items: WalletPositionItemDto[];
  summary: WalletPositionsSummaryDto;
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  syncedAt: number | null;
  source: "sqlite";
};

function safePdas(
  programId: PublicKey,
  marketId: number[],
  address: PublicKey,
  bump: number,
  yesMint: PublicKey,
  noMint: PublicKey
): MarketPdas {
  try {
    return findMarketPdas(programId, marketId);
  } catch {
    return {
      market: address,
      marketBump: bump,
      snapshot: address,
      yesMint,
      noMint,
      collateralVault: address,
      yesPool: address,
      noPool: address,
    };
  }
}

export function deserializeMarket(dto: SerializedMarket): MarketView {
  const address = new PublicKey(dto.address);
  const programId = new PublicKey(dto.programId);
  const id = dto.idHex ? bytesFromHex(dto.idHex) : new Array<number>(16).fill(0);
  const yesMint = new PublicKey(dto.yesMint);
  const noMint = new PublicKey(dto.noMint);
  const startTs =
    dto.startTs != null && dto.startTs > 0 && dto.endTs > dto.startTs
      ? dto.startTs
      : undefined;
  const feeBps =
    startTs != null
      ? currentMarketFeeBps({ startTs, endTs: dto.endTs })
      : dto.feeBps > 0
        ? dto.feeBps
        : Number(SERVICE_FEE_BPS);

  return {
    address,
    pdas: safePdas(programId, id, address, dto.bump, yesMint, noMint),
    title: dto.title,
    id,
    creator: new PublicKey(dto.creator),
    collateralMint: new PublicKey(dto.collateralMint),
    yesMint,
    noMint,
    status: dto.status,
    winner: dto.winner,
    expiry: dto.expiry,
    startTs,
    endTs: dto.endTs,
    finishTs: dto.finishTs,
    bump: dto.bump,
    yesPool: BigInt(dto.yesPool),
    noPool: BigInt(dto.noPool),
    vault: BigInt(dto.vault),
    decimals: dto.decimals,
    tokenProgram: new PublicKey(dto.tokenProgram),
    yesPrice: dto.yesPrice,
    noPrice: dto.noPrice,
    reserveYes: BigInt(dto.reserveYes),
    reserveNo: BigInt(dto.reserveNo),
    totalLpShares: BigInt(dto.totalLpShares),
    ocr2State: new PublicKey(dto.ocr2State),
    feedKey: dto.feedKey,
    feedSymbol: dto.feedSymbol,
    priceDecimals: dto.priceDecimals,
    threshold: BigInt(dto.threshold),
    settleAbove: dto.settleAbove,
    settledPrice: BigInt(dto.settledPrice),
    settledPublishTime: dto.settledPublishTime,
    feeBps,
    lZero: BigInt(dto.lZero),
    lastAccrualTs: dto.lastAccrualTs,
    cumYesPerShare: BigInt(dto.cumYesPerShare),
    cumNoPerShare: BigInt(dto.cumNoPerShare),
  };
}

export function deserializePositionItem(dto: WalletPositionItemDto): {
  market: MarketView;
  position: UserPosition;
} {
  return {
    market: deserializeMarket(dto.market),
    position: {
      collateral: BigInt(dto.collateral),
      yes: BigInt(dto.yes),
      no: BigInt(dto.no),
      lpShares: BigInt(dto.lpShares),
      pendingYes: BigInt(dto.pendingYes),
      pendingNo: BigInt(dto.pendingNo),
    },
  };
}
