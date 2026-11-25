import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@/lib/constants";
import { healSettlementEvidenceOnDemand } from "@/lib/server-db";
import { validateClusterParam } from "@/lib/server-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ address: string }> }
) {
  const { address } = await context.params;
  const { searchParams } = new URL(req.url);
  const programIdRaw = (searchParams.get("programId") || DEFAULT_PROGRAM_ID).trim();
  const cluster = validateClusterParam(searchParams.get("cluster"));

  let marketAddress: string;
  try {
    marketAddress = new PublicKey(address.trim()).toBase58();
    new PublicKey(programIdRaw);
  } catch {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }

  const payload = await healSettlementEvidenceOnDemand({
    marketAddress,
    programId: programIdRaw,
    cluster,
  });

  return Response.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
