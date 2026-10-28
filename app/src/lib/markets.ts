import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { PredictionMarket } from "@/idl/prediction_market";
import { RESOLVE_WINDOW } from "./constants";
import { asBigInt, decodePrediction, parseSide, parseStatus } from "./format";
import { findMarketPdas } from "./pdas";
import { impliedYesPrice } from "./quote";
import type { MarketPdas, MarketStatusName, Side } from "./types";
import {
  ataOf,
  getMultiple,
  tokenProgramOf,
  unpackAmount,
  unpackDecimals,
  unpackSupply,
} from "./tokens";

export type MarketView = {
  address: PublicKey;
  pdas: MarketPdas;
  title: string;
  id: number[];
  creator: PublicKey;
  oracle: PublicKey;
  collateralMint: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  status: MarketStatusName;
  winner: Side;
  expiry: number;
  bump: number;
  yesPool: bigint;
  noPool: bigint;
  vault: bigint;
  lpSupply: bigint;
  decimals: number;
  tokenProgram: PublicKey;
  yesPrice: number;
  noPrice: number;
};

export type UserPosition = {
  collateral: bigint;
  yes: bigint;
  no: bigint;
  lp: bigint;
};

export function marketPhase(
  market: MarketView,
  now: number
): {
  live: boolean;
  expired: boolean;
  inWindow: boolean;
  afterWindow: boolean;
} {
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
  account: Awaited<ReturnType<Program<PredictionMarket>["account"]["market"]["fetch"]>>,
  extras: {
    yesPool: bigint;
    noPool: bigint;
    vault: bigint;
    lpSupply: bigint;
    decimals: number;
    tokenProgram: PublicKey;
  }
): MarketView {
  const id = Array.from(account.id as number[] | Uint8Array);
  const pdas = findMarketPdas(programId, id);
  const yesPrice = impliedYesPrice(extras.yesPool, extras.noPool);
  return {
    address,
    pdas,
    title: decodePrediction(account.prediction as number[]),
    id,
    creator: account.creator,
    oracle: account.oracle,
    collateralMint: account.collateralMint,
    yesMint: account.yesMint,
    noMint: account.noMint,
    status: parseStatus(account.status),
    winner: parseSide(account.winner),
    expiry: Number(asBigInt(account.expiry)),
    bump: account.bump,
    yesPool: extras.yesPool,
    noPool: extras.noPool,
    vault: extras.vault,
    lpSupply: extras.lpSupply,
    decimals: extras.decimals,
    tokenProgram: extras.tokenProgram,
    yesPrice,
    noPrice: 1 - yesPrice,
  };
}

const TOKENKNG = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export async function fetchMarkets(
  connection: Connection,
  program: Program<PredictionMarket>
): Promise<MarketView[]> {
  const rows = await program.account.market.all();
  if (!rows.length) return [];

  const pdas = rows.map((row) =>
    findMarketPdas(program.programId, Array.from(row.account.id))
  );
  const mintKeys = Array.from(
    new Set(rows.map((row) => row.account.collateralMint.toBase58()))
  ).map((s) => new PublicKey(s));

  const keys: PublicKey[] = [];
  for (const pda of pdas) {
    keys.push(pda.yesPool, pda.noPool, pda.collateralVault, pda.lpMint);
  }
  keys.push(...mintKeys);

  const infos = await getMultiple(connection, keys);
  const mintInfo = new Map<string, (typeof infos)[number]>();
  mintKeys.forEach((mint, i) => {
    mintInfo.set(mint.toBase58(), infos[pdas.length * 4 + i] ?? null);
  });

  return rows
    .map((row, i) => {
      const pda = pdas[i];
      const base = i * 4;
      const collateralInfo = mintInfo.get(row.account.collateralMint.toBase58()) ?? null;
      const tokenProgram = collateralInfo
        ? tokenProgramOf(collateralInfo.owner)
        : TOKENKNG;
      return buildView(program.programId, row.publicKey, row.account, {
        yesPool: unpackAmount(pda.yesPool, infos[base], tokenProgram),
        noPool: unpackAmount(pda.noPool, infos[base + 1], tokenProgram),
        vault: unpackAmount(pda.collateralVault, infos[base + 2], tokenProgram),
        lpSupply: unpackSupply(pda.lpMint, infos[base + 3], tokenProgram),
        decimals: unpackDecimals(
          row.account.collateralMint,
          collateralInfo,
          tokenProgram
        ),
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
  const account = await program.account.market.fetch(address);
  const pdas = findMarketPdas(program.programId, Array.from(account.id));
  const keys = [
    pdas.yesPool,
    pdas.noPool,
    pdas.collateralVault,
    pdas.lpMint,
    account.collateralMint,
  ];
  const infos = await getMultiple(connection, keys);
  const collateralInfo = infos[4];
  if (!collateralInfo) throw new Error("Collateral mint not found");
  const tokenProgram = tokenProgramOf(collateralInfo.owner);
  return buildView(program.programId, address, account, {
    yesPool: unpackAmount(pdas.yesPool, infos[0], tokenProgram),
    noPool: unpackAmount(pdas.noPool, infos[1], tokenProgram),
    vault: unpackAmount(pdas.collateralVault, infos[2], tokenProgram),
    lpSupply: unpackSupply(pdas.lpMint, infos[3], tokenProgram),
    decimals: unpackDecimals(account.collateralMint, collateralInfo, tokenProgram),
    tokenProgram,
  });
}

export async function fetchPosition(
  connection: Connection,
  market: MarketView,
  owner: PublicKey
): Promise<UserPosition> {
  const { tokenProgram, pdas, collateralMint } = market;
  const keys = [
    ataOf(collateralMint, owner, tokenProgram),
    ataOf(pdas.yesMint, owner, tokenProgram),
    ataOf(pdas.noMint, owner, tokenProgram),
    ataOf(pdas.lpMint, owner, tokenProgram),
  ];
  const infos = await getMultiple(connection, keys);
  return {
    collateral: unpackAmount(keys[0], infos[0], tokenProgram),
    yes: unpackAmount(keys[1], infos[1], tokenProgram),
    no: unpackAmount(keys[2], infos[2], tokenProgram),
    lp: unpackAmount(keys[3], infos[3], tokenProgram),
  };
}
