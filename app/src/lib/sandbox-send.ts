import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export type SandboxTxStage =
  | { stage: "signing" }
  | { stage: "broadcasted"; signature: string }
  | { stage: "confirmed"; signature: string };

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

function errorText(err: unknown): string {
  if (!err || typeof err !== "object") return String(err ?? "");
  const anyErr = err as { name?: string; message?: string };
  return `${anyErr.name ?? ""} ${anyErr.message ?? ""} ${String(err)}`;
}

function isBlockhashOrTimeoutError(err: unknown): boolean {
  const msg = errorText(err);
  return /TransactionExpiredBlockheightExceededError|TransactionExpiredTimeoutError|block height exceeded|Blockhash not found|was not confirmed|timed out|timeout/i.test(
    msg
  );
}

export async function sendSandboxIxs(
  connection: Connection,
  keypair: Keypair,
  ixs: TransactionInstruction[],
  opts?: {
    onStage?: (stage: SandboxTxStage) => void;
    maxBlockhashRetries?: number;
  }
): Promise<string> {
  if (!ixs.length) throw new Error("errors.noIxs");
  const maxRetries = Math.max(0, opts?.maxBlockhashRetries ?? 1);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    opts?.onStage?.({ stage: "signing" });
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.feePayer = keypair.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.add(...ixs);

    await simulateBeforeSign(connection, tx);
    tx.sign(keypair);

    let sig: string;
    try {
      sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });
    } catch (sendErr) {
      if (isBlockhashOrTimeoutError(sendErr) && attempt < maxRetries) {
        continue;
      }
      throw sendErr;
    }

    opts?.onStage?.({ stage: "broadcasted", signature: sig });

    try {
      const res = await connection.confirmTransaction(
        {
          signature: sig,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
      );
      if (res.value.err) throw new Error("errors.txFailed");
      opts?.onStage?.({ stage: "confirmed", signature: sig });
      return sig;
    } catch (confirmErr) {
      if (!isBlockhashOrTimeoutError(confirmErr)) {
        throw confirmErr;
      }
      try {
        if (typeof connection.getSignatureStatus === "function") {
          const st = await connection.getSignatureStatus(sig, {
            searchTransactionHistory: true,
          });
          if (st?.value) {
            if (st.value.err !== null) {
              throw new Error("errors.txFailed");
            }
            if (
              st.value.confirmationStatus === "confirmed" ||
              st.value.confirmationStatus === "finalized"
            ) {
              opts?.onStage?.({ stage: "confirmed", signature: sig });
              return sig;
            }
          }
        }
      } catch (statusErr) {
        if (statusErr instanceof Error && statusErr.message === "errors.txFailed") {
          throw statusErr;
        }
      }

      if (attempt < maxRetries) {
        continue;
      }
      throw new Error("errors.blockhash");
    }
  }

  throw new Error("errors.blockhash");
}
