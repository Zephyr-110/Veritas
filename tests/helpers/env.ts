import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { PredictionMarket } from "../../target/types/prediction_market";

export type TestEnv = {
  provider: anchor.AnchorProvider;
  connection: Connection;
  program: Program<PredictionMarket>;
  payer: Keypair;
  payerPubkey: PublicKey;
};

let cached: TestEnv | null = null;

export function getTestEnv(): TestEnv {
  if (cached) {
    return cached;
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const workspace = anchor.workspace as Record<string, Program<PredictionMarket>>;
  const program = (workspace.predictionMarket ||
    workspace.PredictionMarket ||
    workspace.prediction_market) as Program<PredictionMarket>;
  if (!program) {
    throw new Error("找不到 PredictionMarket program，请用 anchor test 跑");
  }

  const payer = (provider.wallet as anchor.Wallet).payer;
  cached = {
    provider,
    connection: provider.connection,
    program,
    payer,
    payerPubkey: provider.wallet.publicKey,
  };
  return cached;
}
