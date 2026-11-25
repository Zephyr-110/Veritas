import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@/lib/constants";
import { extractClientIp } from "@/lib/sandbox-faucet-guard";
import { queryWalletPositionsPage, syncWalletPositionsOnDemand } from "@/lib/server-db";
import { checkRateLimit, parseStrictPositiveInt, recordRateLimit } from "@/lib/server-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFRESH_BURST_LIMIT = 6;
const REFRESH_WINDOW_MS = 60_000;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const walletRaw = (searchParams.get("wallet") || "").trim();
  const programIdRaw = (searchParams.get("programId") || DEFAULT_PROGRAM_ID).trim();
  const parsedPage = parseStrictPositiveInt(searchParams.get("page"), {
    defaultValue: 1,
    min: 1,
    max: 10_000,
  });
  if (!parsedPage.ok) {
    return Response.json({ error: "bad_page" }, { status: 400 });
  }
  const parsedPageSize = parseStrictPositiveInt(searchParams.get("pageSize"), {
    defaultValue: 30,
    min: 1,
    max: 10_000,
  });
  if (!parsedPageSize.ok) {
    return Response.json({ error: "bad_page_size" }, { status: 400 });
  }
  const refreshRaw = searchParams.get("refresh");
  const forceRefresh = refreshRaw === "1" || refreshRaw === "true";

  let wallet: string;
  try {
    wallet = new PublicKey(walletRaw).toBase58();
    new PublicKey(programIdRaw);
  } catch {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }

  if (forceRefresh) {
    const ip = extractClientIp(req);
    if (!checkRateLimit("positions-refresh", ip, REFRESH_BURST_LIMIT, REFRESH_WINDOW_MS)) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
    }
    recordRateLimit("positions-refresh", ip, REFRESH_WINDOW_MS);
  }

  await syncWalletPositionsOnDemand({
    wallet,
    programId: programIdRaw,
    forceRefresh,
  });

  const payload = queryWalletPositionsPage({
    wallet,
    programId: programIdRaw,
    page: parsedPage.value,
    pageSize: Math.min(50, parsedPageSize.value),
  });

  return Response.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
