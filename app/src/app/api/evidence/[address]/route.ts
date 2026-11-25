import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@/lib/constants";
import { querySettlementEvidence } from "@/lib/server-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ address: string }> }
) {
  const { address } = await context.params;
  const { searchParams } = new URL(req.url);
  const programIdRaw = (searchParams.get("programId") || DEFAULT_PROGRAM_ID).trim();

  let marketAddress: string;
  try {
    marketAddress = new PublicKey(address.trim()).toBase58();
    new PublicKey(programIdRaw);
  } catch {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }

  const evidence = querySettlementEvidence(marketAddress, programIdRaw);
  return Response.json(
    { found: Boolean(evidence), evidence },
    { headers: { "Cache-Control": "no-store" } }
  );
}
