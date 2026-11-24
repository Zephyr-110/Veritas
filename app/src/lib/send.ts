import { ConfirmedTransactionError } from "./errors";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { AnchorWalletLike } from "./program";

async function simulateBeforeSign(connection: Connection, tx: Transaction): Promise<void> {
  if (typeof connection.simulateTransaction !== "function") return;
  let sim: Awaited<ReturnType<Connection["simulateTransaction"]>> | null = null;
  try {
    sim = await connection.simulateTransaction(tx);
  } catch {
    return;
  }
  const simErr = sim?.value?.err;
  if (!simErr) return;
  if (simErr === "AccountNotFound") {
    throw new Error("errors.noSol");
  }
  const err = new Error(typeof simErr === "string" ? simErr : JSON.stringify(simErr)) as Error & {
    logs?: string[];
  };
  err.logs = sim.value.logs ?? [];
  throw err;
}

export async function sendIxs(
  connection: Connection,
  wallet: AnchorWalletLike,
  ixs: TransactionInstruction[],
  extraSigners: never[] = []
): Promise<string> {
  void extraSigners;
  if (!ixs.length) throw new Error("errors.noIxs");
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.add(...ixs);
  await simulateBeforeSign(connection, tx);
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const res = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );
  if (res.value.err) throw new ConfirmedTransactionError();
  return sig;
}

export function mustWallet(wallet: AnchorWalletLike | null | undefined): AnchorWalletLike {
  if (!wallet?.publicKey || wallet.publicKey.equals(PublicKey.default)) {
    throw new Error("errors.connectWallet");
  }
  return wallet;
}
