import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@/lib/constants";
import { queryWalletPositionsPage, syncWalletPositionsOnDemand } from "@/lib/server-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const walletRaw = (searchParams.get("wallet") || "").trim();
  const programIdRaw = (searchParams.get("programId") || DEFAULT_PROGRAM_ID).trim();
  const rpcParam = (searchParams.get("rpcUrl") || "").trim();
  const pageRaw = Number(searchParams.get("page") || "1");
  const pageSizeRaw = Number(searchParams.get("pageSize") || "30");
  const refreshRaw = searchParams.get("refresh");
  const forceRefresh = refreshRaw === "1" || refreshRaw === "true";

  let wallet: string;
  try {
    wallet = new PublicKey(walletRaw).toBase58();
    new PublicKey(programIdRaw);
  } catch {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }

  const rpcUrl = /^https?:\/\//i.test(rpcParam) ? rpcParam : undefined;
  await syncWalletPositionsOnDemand({
    wallet,
    programId: programIdRaw,
    rpcUrl,
    forceRefresh,
  });

  const payload = queryWalletPositionsPage({
    wallet,
    programId: programIdRaw,
    page: Number.isFinite(pageRaw) ? pageRaw : 1,
    pageSize: Number.isFinite(pageSizeRaw) ? pageSizeRaw : 30,
  });

  return Response.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
