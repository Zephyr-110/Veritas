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

export const CONFIRM_POLL_INTERVAL_MS = 750;

export async function confirmSignatureWithPolling(
  connection: Connection,
  params: {
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
  },
  opts?: { pollIntervalMs?: number }
): Promise<void> {
  const pollIntervalMs = Math.max(50, opts?.pollIntervalMs ?? CONFIRM_POLL_INTERVAL_MS);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const wsPromise = connection.confirmTransaction(params, "confirmed").then((res) => {
    if (res?.value?.err) {
      throw new ConfirmedTransactionError();
    }
  });

  const canPollStatuses = typeof connection.getSignatureStatuses === "function";
  const canPollSingle = typeof connection.getSignatureStatus === "function";
  if (!canPollStatuses && !canPollSingle) {
    return wsPromise;
  }

  const pollPromise = new Promise<void>((resolve, reject) => {
    const check = async () => {
      if (settled) return;
      try {
        let status: { err: unknown; confirmationStatus?: string | null } | null = null;
        if (canPollStatuses) {
          const res = await connection.getSignatureStatuses([params.signature], {
            searchTransactionHistory: true,
          });
          status = res?.value?.[0] ?? null;
        } else if (canPollSingle) {
          const res = await connection.getSignatureStatus(params.signature, {
            searchTransactionHistory: true,
          });
          status = res?.value ?? null;
        }
        if (settled) return;
        if (status) {
          if (status.err !== null && status.err !== undefined) {
            reject(new ConfirmedTransactionError());
            return;
          }
          if (
            status.confirmationStatus === "confirmed" ||
            status.confirmationStatus === "finalized"
          ) {
            resolve();
            return;
          }
        }
        if (typeof connection.getBlockHeight === "function") {
          try {
            const blockHeight = await connection.getBlockHeight("confirmed");
            if (settled) return;
            if (blockHeight > params.lastValidBlockHeight) {
              reject(new Error("TransactionExpiredBlockheightExceededError: block height exceeded"));
              return;
            }
          } catch {
            // transient RPC error; keep polling
          }
        }
      } catch {
        // transient RPC error; keep polling
      }
      if (!settled) {
        timer = setTimeout(() => void check(), pollIntervalMs);
      }
    };

    timer = setTimeout(() => void check(), pollIntervalMs);
  });

  wsPromise.catch(() => {});
  pollPromise.catch(() => {});

  try {
    await Promise.race([wsPromise, pollPromise]);
  } finally {
    cleanup();
  }
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
  await confirmSignatureWithPolling(connection, {
    signature: sig,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  return sig;
}

export function mustWallet(wallet: AnchorWalletLike | null | undefined): AnchorWalletLike {
  if (!wallet?.publicKey || wallet.publicKey.equals(PublicKey.default)) {
    throw new Error("errors.connectWallet");
  }
  return wallet;
}
