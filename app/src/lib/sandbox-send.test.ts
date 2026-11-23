// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { sendSandboxIxs, type SandboxTxStage } from "./sandbox-send";

function makeDummyIx(pk: PublicKey) {
  return SystemProgram.transfer({
    fromPubkey: pk,
    toPubkey: pk,
    lamports: 1,
  });
}

describe("sendSandboxIxs", () => {
  it("reports signing -> broadcasted -> confirmed stages and passes blockhash + lastValidBlockHeight", async () => {
    const kp = Keypair.generate();
    const stages: SandboxTxStage[] = [];
    const confirmTransaction = vi.fn().mockResolvedValue({ value: { err: null } });
    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 12345,
      }),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
      sendRawTransaction: vi.fn().mockResolvedValue("sig-ok-1"),
      confirmTransaction,
    } as unknown as Connection;

    const sig = await sendSandboxIxs(connection, kp, [makeDummyIx(kp.publicKey)], {
      onStage: (s) => stages.push(s),
    });

    expect(sig).toBe("sig-ok-1");
    expect(stages).toEqual([
      { stage: "signing" },
      { stage: "broadcasted", signature: "sig-ok-1" },
      { stage: "confirmed", signature: "sig-ok-1" },
    ]);
    expect(confirmTransaction).toHaveBeenCalledWith(
      {
        signature: "sig-ok-1",
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 12345,
      },
      "confirmed"
    );
  });

  it("retries once with a fresh blockhash on confirmation timeout", async () => {
    const kp = Keypair.generate();
    const stages: SandboxTxStage[] = [];
    const getLatestBlockhash = vi
      .fn()
      .mockResolvedValueOnce({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 100,
      })
      .mockResolvedValueOnce({
        blockhash: "11111111111111111111111111111112",
        lastValidBlockHeight: 200,
      });
    const sendRawTransaction = vi
      .fn()
      .mockResolvedValueOnce("sig-timeout-1")
      .mockResolvedValueOnce("sig-retry-2");
    const confirmTransaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("TransactionExpiredBlockheightExceededError: block height exceeded"))
      .mockResolvedValueOnce({ value: { err: null } });
    const getSignatureStatus = vi.fn().mockResolvedValue({ value: null });

    const connection = {
      getLatestBlockhash,
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
      sendRawTransaction,
      confirmTransaction,
      getSignatureStatus,
    } as unknown as Connection;

    const sig = await sendSandboxIxs(connection, kp, [makeDummyIx(kp.publicKey)], {
      onStage: (s) => stages.push(s),
      maxBlockhashRetries: 1,
    });

    expect(sig).toBe("sig-retry-2");
    expect(getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(stages[stages.length - 1]).toEqual({ stage: "confirmed", signature: "sig-retry-2" });
  });

  it("recovers without double-sending if confirmation times out after landing on-chain", async () => {
    const kp = Keypair.generate();
    const sendRawTransaction = vi.fn().mockResolvedValue("sig-landed-1");
    const confirmTransaction = vi
      .fn()
      .mockRejectedValue(new Error("TransactionExpiredTimeoutError: timed out"));
    const getSignatureStatus = vi.fn().mockResolvedValue({
      value: { err: null, confirmationStatus: "confirmed" },
    });

    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 100,
      }),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
      sendRawTransaction,
      confirmTransaction,
      getSignatureStatus,
    } as unknown as Connection;

    const sig = await sendSandboxIxs(connection, kp, [makeDummyIx(kp.publicKey)]);
    expect(sig).toBe("sig-landed-1");
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("throws errors.noIxs when instruction list is empty", async () => {
    const kp = Keypair.generate();
    const connection = {} as Connection;
    await expect(sendSandboxIxs(connection, kp, [])).rejects.toThrow("errors.noIxs");
  });
});
