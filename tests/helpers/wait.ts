import { Connection, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chainUnixTime(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!info) {
    throw new Error("读不到 Clock 账户");
  }
  return Number(info.data.readBigInt64LE(32));
}

export async function waitUntilChainTime(
  connection: Connection,
  unix: number
): Promise<void> {
  while ((await chainUnixTime(connection)) < unix) {
    await sleep(400);
  }
}
