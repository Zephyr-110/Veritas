import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@/lib/constants";
import { healSettlementEvidenceOnDemand } from "@/lib/server-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ address: string }> }
) {
  const { address } = await context.params;
  const { searchParams } = new URL(req.url);
  const programIdRaw = (searchParams.get("programId") || DEFAULT_PROGRAM_ID).trim();
  const clusterParam = (searchParams.get("cluster") || "").trim();
  const rpcParam = (searchParams.get("rpcUrl") || "").trim();

  let marketAddress: string;
  try {
    marketAddress = new PublicKey(address.trim()).toBase58();
    new PublicKey(programIdRaw);
  } catch {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }

  const rpcUrl = /^https?:\/\//i.test(rpcParam) ? rpcParam : undefined;
  const cluster = clusterParam || undefined;
  const payload = await healSettlementEvidenceOnDemand({
    marketAddress,
    programId: programIdRaw,
    rpcUrl,
    cluster,
  });

  return Response.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
