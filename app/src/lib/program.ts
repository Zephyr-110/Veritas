import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { PredictionMarket } from "@/idl/prediction_market";
import rawIdl from "@/idl/prediction_market.json";
import { DEFAULT_PROGRAM_ID } from "./constants";

const IDL = rawIdl as unknown as PredictionMarket;

export type AnchorWalletLike = {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends Transaction>(txs: T[]) => Promise<T[]>;
};

const readOnlyWallet: AnchorWalletLike = {
  publicKey: PublicKey.default,
  signTransaction: async () => {
    throw new Error("errors.connectWallet");
  },
  signAllTransactions: async () => {
    throw new Error("errors.connectWallet");
  },
};

export function parsePubkey(value: string | null | undefined): PublicKey | null {
  if (!value) return null;
  try {
    return new PublicKey(value.trim());
  } catch {
    return null;
  }
}

export function makeProgram(
  connection: Connection,
  wallet: AnchorWalletLike | null | undefined,
  programId = DEFAULT_PROGRAM_ID
): Program<PredictionMarket> {
  const pk = parsePubkey(programId);
  if (!pk) throw new Error("errors.badAddress");
  const provider = new AnchorProvider(connection, (wallet ?? readOnlyWallet) as never, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = { ...IDL, address: pk.toBase58() } as PredictionMarket;
  return new Program(idl, provider);
}
