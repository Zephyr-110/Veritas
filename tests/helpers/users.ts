import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TestEnv } from "./env";
import { mintToUser } from "./tokens";

export type User = {
  name: string;
  keypair: Keypair;
  pubkey: PublicKey;
};

export function extraSigners(
  env: TestEnv,
  ...users: Array<User | undefined | null>
): Keypair[] {
  const seen = new Set<string>();
  const signers: Keypair[] = [];
  for (const user of users) {
    if (!user) continue;
    if (user.pubkey.equals(env.payerPubkey)) continue;
    const id = user.pubkey.toBase58();
    if (seen.has(id)) continue;
    seen.add(id);
    signers.push(user.keypair);
  }
  return signers;
}

export function getHouse(env: TestEnv): User {
  return {
    name: "house",
    keypair: env.payer,
    pubkey: env.payerPubkey,
  };
}

export async function airdropSol(
  env: TestEnv,
  to: PublicKey,
  sol = 2
): Promise<void> {
  const lamports = sol * anchor.web3.LAMPORTS_PER_SOL;
  let lastError: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const signature = await env.connection.requestAirdrop(to, lamports);
      const latest = await env.connection.getLatestBlockhash("confirmed");
      await env.connection.confirmTransaction(
        { signature, ...latest },
        "confirmed"
      );
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export async function newUser(env: TestEnv, name: string): Promise<User> {
  const keypair = Keypair.generate();
  await airdropSol(env, keypair.publicKey, 2);
  return {
    name,
    keypair,
    pubkey: keypair.publicKey,
  };
}

export async function newFundedUser(
  env: TestEnv,
  name: string,
  collateralMint: PublicKey,
  amount: bigint
): Promise<User> {
  const user = await newUser(env, name);
  await mintToUser(env, collateralMint, user.pubkey, amount);
  return user;
}
