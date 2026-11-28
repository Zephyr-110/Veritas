import { readFileSync } from "fs";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { DEFAULT_COLLATERAL_MINT } from "@/lib/constants";
import { ataOf, fetchMintMeta, unpackAmount } from "@/lib/tokens";
import {
  acquireAddressLock,
  checkDailySolCap,
  checkIpLimit,
  extractClientIp,
  recordDailySol,
  recordIpClaim,
  releaseAddressLock,
} from "@/lib/sandbox-faucet-guard";
import { touchSandboxActiveSignal } from "@/lib/sandbox-active";
import {
  checkDailyCountCap,
  checkRateLimit,
  recordDailyCount,
  recordRateLimit,
  validateFaucetRequest,
} from "@/lib/server-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ATA_RENT_LAMPORTS = 2_039_280;
const FEE_BUFFER_LAMPORTS = 50_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BURST_WINDOW_MS = 60_000;
const BURST_LIMIT = 12;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadPayer(keypairPath: string): Keypair {
  const secret = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

function touchActiveSignal(): void {
  touchSandboxActiveSignal();
}

export async function POST(req: Request) {
  const keypairPath = (
    process.env.SANDBOX_FAUCET_KEYPAIR_PATH ||
    process.env.FAUCET_KEYPAIR_PATH ||
    ""
  ).trim();
  if (!keypairPath) {
    return Response.json({ error: "disabled" }, { status: 404 });
  }
  const guard = validateFaucetRequest(req);
  if (!guard.ok) {
    return Response.json({ error: guard.error }, { status: guard.status });
  }

  const ip = extractClientIp(req);
  if (!checkRateLimit("sandbox-faucet-burst", ip, BURST_LIMIT, BURST_WINDOW_MS)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  recordRateLimit("sandbox-faucet-burst", ip, BURST_WINDOW_MS);

  let recipient: PublicKey;
  try {
    const body = (await req.json()) as { address?: string };
    recipient = new PublicKey(String(body.address ?? "").trim());
  } catch {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }

  const address = recipient.toBase58();
  const addressDailyLimit = envNumber("SANDBOX_FAUCET_ADDRESS_DAILY_LIMIT", 5);
  if (!checkRateLimit("sandbox-faucet-addr-day", address, addressDailyLimit, DAY_MS)) {
    return Response.json({ error: "address_limit" }, { status: 429 });
  }
  const lockMs = envNumber("SANDBOX_FAUCET_LOCK_MS", 10_000);
  if (!acquireAddressLock(address, Date.now(), lockMs)) {
    return Response.json({ error: "locked" }, { status: 429 });
  }

  let keepCooldown = false;
  try {
    const rpc = (
      process.env.SANDBOX_FAUCET_RPC_URL ||
      process.env.FAUCET_RPC_URL ||
      process.env.NEXT_PUBLIC_SOLANA_RPC ||
      "https://api.devnet.solana.com"
    ).trim();
    const mintAddr = (
      process.env.SANDBOX_FAUCET_COLLATERAL_MINT ||
      DEFAULT_COLLATERAL_MINT
    ).trim();
    const targetSolLamports = Math.round(envNumber("SANDBOX_FAUCET_SOL_AMOUNT", 0.04) * 1e9);
    const targetUsdtUi = envNumber("SANDBOX_FAUCET_USDT_AMOUNT", 30);
    const ipDailyLimit = envNumber("SANDBOX_FAUCET_IP_DAILY_LIMIT", 5);
    const dailyClaimCap = envNumber("SANDBOX_FAUCET_DAILY_CLAIM_CAP", 100);
    const dailySolCapLamports = Math.round(
      envNumber("SANDBOX_FAUCET_DAILY_SOL_CAP", 2) * 1e9
    );

    const payer = loadPayer(keypairPath);
    const connection = new Connection(rpc, "confirmed");
    const mint = new PublicKey(mintAddr);
    const meta = await fetchMintMeta(connection, mint);
    const targetUsdtAtoms = BigInt(Math.round(targetUsdtUi * 10 ** meta.decimals));
    const destAta = ataOf(mint, recipient, meta.tokenProgram);
    const sourceAta = ataOf(mint, payer.publicKey, meta.tokenProgram);

    const inspectRecipient = async () => {
      const [lamports, destAtaInfo] = await Promise.all([
        connection.getBalance(recipient, "confirmed"),
        connection.getAccountInfo(destAta, "confirmed"),
      ]);
      const usdtAtoms = unpackAmount(destAta, destAtaInfo, meta.tokenProgram);
      const needSol = lamports < targetSolLamports ? targetSolLamports - lamports : 0;
      const needAta = !destAtaInfo;
      const needUsdt = usdtAtoms < targetUsdtAtoms ? targetUsdtAtoms - usdtAtoms : 0n;
      const solBudget = needSol + (needAta ? ATA_RENT_LAMPORTS : 0);
      return { lamports, usdtAtoms, needSol, needAta, needUsdt, solBudget };
    };

    const initial = await inspectRecipient();
    if (initial.needSol === 0 && !initial.needAta && initial.needUsdt === 0n) {
      touchActiveSignal();
      return Response.json({
        ok: true,
        skipped: true,
        signature: null,
        solLamports: initial.lamports,
        usdtAtoms: initial.usdtAtoms.toString(),
        usdtDecimals: meta.decimals,
      });
    }

    if (!checkIpLimit(ip, ipDailyLimit)) {
      return Response.json({ error: "ip_limit" }, { status: 429 });
    }
    if (!checkDailyCountCap("sandbox-faucet-daily-claims", dailyClaimCap)) {
      return Response.json({ error: "daily_cap" }, { status: 503 });
    }
    if (!checkDailySolCap(initial.solBudget, dailySolCapLamports)) {
      return Response.json({ error: "daily_sol_cap" }, { status: 503 });
    }

    const [payerLamports, sourceInfo] = await Promise.all([
      connection.getBalance(payer.publicKey, "confirmed"),
      initial.needUsdt > 0n
        ? connection.getAccountInfo(sourceAta, "confirmed")
        : Promise.resolve(null),
    ]);
    if (payerLamports < initial.solBudget + FEE_BUFFER_LAMPORTS) {
      return Response.json({ error: "empty" }, { status: 503 });
    }
    if (initial.needUsdt > 0n) {
      const sourceBalance = unpackAmount(sourceAta, sourceInfo, meta.tokenProgram);
      if (sourceBalance < initial.needUsdt) {
        return Response.json({ error: "empty" }, { status: 503 });
      }
    }

    let lastSig: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (attempt > 0 && lastSig) {
          const st = await connection.getSignatureStatus(lastSig, {
            searchTransactionHistory: true,
          });
          if (
            st.value &&
            st.value.err === null &&
            (st.value.confirmationStatus === "confirmed" ||
              st.value.confirmationStatus === "finalized")
          ) {
            const settled = await inspectRecipient();
            recordIpClaim(ip);
            recordRateLimit("sandbox-faucet-addr-day", address, DAY_MS);
            recordDailyCount("sandbox-faucet-daily-claims");
            recordDailySol(initial.solBudget);
            touchActiveSignal();
            return Response.json({
              ok: true,
              skipped: false,
              signature: lastSig,
              solLamports: settled.lamports,
              usdtAtoms: settled.usdtAtoms.toString(),
              usdtDecimals: meta.decimals,
            });
          }
        }

        const stateNow = attempt === 0 ? initial : await inspectRecipient();
        if (stateNow.needSol === 0 && !stateNow.needAta && stateNow.needUsdt === 0n) {
          recordIpClaim(ip);
          recordRateLimit("sandbox-faucet-addr-day", address, DAY_MS);
          recordDailyCount("sandbox-faucet-daily-claims");
          recordDailySol(initial.solBudget);
          touchActiveSignal();
          return Response.json({
            ok: true,
            skipped: false,
            signature: lastSig,
            solLamports: stateNow.lamports,
            usdtAtoms: stateNow.usdtAtoms.toString(),
            usdtDecimals: meta.decimals,
          });
        }

        const ixs: TransactionInstruction[] = [];
        if (stateNow.needSol > 0) {
          ixs.push(
            SystemProgram.transfer({
              fromPubkey: payer.publicKey,
              toPubkey: recipient,
              lamports: stateNow.needSol,
            })
          );
        }
        if (stateNow.needAta) {
          ixs.push(
            createAssociatedTokenAccountIdempotentInstruction(
              payer.publicKey,
              destAta,
              recipient,
              mint,
              meta.tokenProgram
            )
          );
        }
        if (stateNow.needUsdt > 0n) {
          ixs.push(
            createTransferInstruction(
              sourceAta,
              destAta,
              payer.publicKey,
              stateNow.needUsdt,
              [],
              meta.tokenProgram
            )
          );
        }

        keepCooldown = true;
        const latest = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction();
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = latest.blockhash;
        tx.add(...ixs);
        tx.sign(payer);

        lastSig = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 3,
        });
        const conf = await connection.confirmTransaction(
          {
            signature: lastSig,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed"
        );
        if (conf.value.err) {
          throw new Error("tx_failed");
        }

        recordIpClaim(ip);
        recordRateLimit("sandbox-faucet-addr-day", address, DAY_MS);
        recordDailyCount("sandbox-faucet-daily-claims");
        recordDailySol(stateNow.solBudget);
        touchActiveSignal();
        return Response.json({
          ok: true,
          skipped: false,
          signature: lastSig,
          solLamports: stateNow.lamports + stateNow.needSol,
          usdtAtoms: (stateNow.usdtAtoms + stateNow.needUsdt).toString(),
          usdtDecimals: meta.decimals,
        });
      } catch {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        return Response.json({ error: "failed" }, { status: 500 });
      }
    }

    return Response.json({ error: "failed" }, { status: 500 });
  } catch {
    return Response.json({ error: "failed" }, { status: 500 });
  } finally {
    releaseAddressLock(address, { keepCooldown, lockMs });
  }
}
