import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import type { PredictionMarket } from "@/idl/prediction_market";
import type { MarketView } from "./markets";
import { fetchResolveUpdate } from "./pyth";
import type { AnchorWalletLike } from "./program";

export async function postPythAndResolve(
  connection: Connection,
  wallet: AnchorWalletLike,
  program: Program<PredictionMarket>,
  market: MarketView
): Promise<string[]> {
  const update = await fetchResolveUpdate(market);
  if (!update.binary.length) throw new Error("errors.pythNoPrint");

  let PythSolanaReceiver: typeof import("@pythnetwork/pyth-solana-receiver").PythSolanaReceiver;
  try {
    ({ PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver"));
  } catch {
    throw new Error("errors.pythSdk");
  }

  const receiver = new PythSolanaReceiver({ connection, wallet: wallet as never });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates(update.binary);
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount: (feedId: string) => PublicKey) => {
    const priceUpdate = getPriceUpdateAccount(`0x${market.feedHex}`);
    const ix = await program.methods
      .resolveMarket()
      .accountsPartial({
        signer: wallet.publicKey,
        market: market.address,
        priceUpdate,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .instruction();
    return [{ instruction: ix, signers: [] }];
  });
  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
    tightComputeBudget: true,
  });
  const sigs = await receiver.provider.sendAll(
    txs.map((tx: { tx: unknown; signers?: unknown[] }) => ({
      tx: tx.tx as never,
      signers: (tx.signers ?? []) as never,
    })) as never
  );
  return sigs as string[];
}
