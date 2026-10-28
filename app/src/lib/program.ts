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
    throw new Error("Connect a wallet first");
  },
  signAllTransactions: async () => {
    throw new Error("Connect a wallet first");
  },
};

export function makeProgram(
  connection: Connection,
  wallet: AnchorWalletLike | null | undefined,
  programId = DEFAULT_PROGRAM_ID
): Program<PredictionMarket> {
  const provider = new AnchorProvider(connection, (wallet ?? readOnlyWallet) as never, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = { ...IDL, address: programId } as PredictionMarket;
  return new Program(idl, provider);
}
