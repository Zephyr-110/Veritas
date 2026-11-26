import { readFileSync, writeFileSync } from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";
import { DEFAULT_COLLATERAL_MINT } from "@/lib/constants";
import {
  acquireAddressLock,
  extractClientIp,
  releaseAddressLock,
} from "@/lib/sandbox-faucet-guard";
import {
  checkRateLimit,
  recordRateLimit,
  validateFaucetRequest,
} from "@/lib/server-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAIM_AMOUNT = 100n;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BURST_WINDOW_MS = 60_000;
const BURST_LIMIT = 10;
const DAILY_CAP = 200;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

type ClaimState = Record<string, number>;

function loadState(path: string): ClaimState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ClaimState;
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  const keypairPath = process.env.FAUCET_KEYPAIR_PATH;
  if (!keypairPath) {
    return Response.json({ error: "disabled" }, { status: 404 });
  }
  const guard = validateFaucetRequest(req);
  if (!guard.ok) {
    return Response.json({ error: guard.error }, { status: guard.status });
  }

  const ip = extractClientIp(req);
  if (!checkRateLimit("faucet-burst", ip, BURST_LIMIT, BURST_WINDOW_MS)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  recordRateLimit("faucet-burst", ip, BURST_WINDOW_MS);

  let address: string;
  try {
    const body = (await req.json()) as { address?: string };
    address = new PublicKey(String(body.address ?? "").trim()).toBase58();
  } catch {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }

  const ipDailyLimit = envPositiveInt("FAUCET_IP_DAILY_LIMIT", 5);
  if (!checkRateLimit("faucet-ip-day", ip, ipDailyLimit, COOLDOWN_MS)) {
    return Response.json({ error: "ip_limit" }, { status: 429 });
  }

  if (!acquireAddressLock(address)) {
    return Response.json({ error: "locked" }, { status: 429 });
  }
  let keepCooldown = false;
  try {
    const res = await claim(address, keypairPath, ip, ipDailyLimit);
    if (res.ok) keepCooldown = true;
    return res;
  } finally {
    releaseAddressLock(address, { keepCooldown });
  }
}

async function claim(address: string, keypairPath: string, ip: string, ipDailyLimit: number) {
  const statePath = process.env.FAUCET_STATE_PATH ?? "/tmp/veritas-faucet.json";
  const state = loadState(statePath);
  const now = Date.now();
  const last = state[address] ?? 0;
  if (now - last < COOLDOWN_MS) {
    return Response.json({ error: "cooldown" }, { status: 429 });
  }
  const dailyCap = envPositiveInt("FAUCET_DAILY_CAP", DAILY_CAP);
  const claimedToday = Object.values(state).filter((ts) => now - ts < COOLDOWN_MS).length;
  if (claimedToday >= dailyCap) {
    return Response.json({ error: "daily_cap" }, { status: 429 });
  }
  if (!checkRateLimit("faucet-ip-day", ip, ipDailyLimit, COOLDOWN_MS, now)) {
    return Response.json({ error: "ip_limit" }, { status: 429 });
  }

  const secret = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")) as number[]);
  const payer = Keypair.fromSecretKey(secret);
  const rpc = (
    process.env.FAUCET_RPC_URL ||
    process.env.SOLANA_RPC ||
    process.env.NEXT_PUBLIC_SOLANA_RPC ||
    "https://api.devnet.solana.com"
  ).trim();
  const connection = new Connection(rpc, "confirmed");
  const mint = new PublicKey(DEFAULT_COLLATERAL_MINT);
  const recipient = new PublicKey(address);

  // The public devnet RPC rate-limits this box's IP in bursts; retry the
  // whole flow once. Before the retry, check the destination balance: if a
  // transfer already landed despite the error, do not send twice.
  let baseline: bigint | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const mintInfo = await getMint(connection, mint);
      const amount = CLAIM_AMOUNT * 10n ** BigInt(mintInfo.decimals);
      const source = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
      const sourceInfo = await getAccount(connection, source.address);
      if (sourceInfo.amount < amount) {
        return Response.json({ error: "empty" }, { status: 503 });
      }
      const dest = await getOrCreateAssociatedTokenAccount(connection, payer, mint, recipient);
      let already = 0n;
      try {
        already = (await getAccount(connection, dest.address)).amount;
      } catch {
        already = 0n;
      }
      if (baseline === null) baseline = already;
      if (attempt > 0 && already >= baseline + amount) {
        // previous attempt's transfer landed; fall through to success
      } else {
        await transfer(connection, payer, source.address, dest.address, payer.publicKey, amount);
      }
      const updated = loadState(statePath);
      updated[address] = Date.now();
      recordRateLimit("faucet-ip-day", ip, COOLDOWN_MS);
      try {
        writeFileSync(statePath, JSON.stringify(updated));
      } catch {
        // state persistence is best-effort; the transfer already happened
      }
      return Response.json({ ok: true });
    } catch {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        continue;
      }
      return Response.json({ error: "failed" }, { status: 500 });
    }
  }
  return Response.json({ error: "failed" }, { status: 500 });
}
