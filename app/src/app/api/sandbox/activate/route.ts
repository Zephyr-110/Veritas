import { extractClientIp } from "@/lib/sandbox-faucet-guard";
import { touchSandboxActiveSignal } from "@/lib/sandbox-active";
import {
  checkRateLimit,
  recordRateLimit,
  validateFaucetRequest,
} from "@/lib/server-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BURST_WINDOW_MS = 60_000;
const BURST_LIMIT = 30;

export async function POST(req: Request) {
  const guard = validateFaucetRequest(req);
  if (!guard.ok) {
    return Response.json({ error: guard.error }, { status: guard.status });
  }

  const ip = extractClientIp(req);
  if (!checkRateLimit("sandbox-activate-burst", ip, BURST_LIMIT, BURST_WINDOW_MS)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  recordRateLimit("sandbox-activate-burst", ip, BURST_WINDOW_MS);

  const result = touchSandboxActiveSignal();
  return Response.json(
    {
      ok: true,
      touched: result.touched,
      ...(result.lastActiveTs !== undefined ? { lastActiveTs: result.lastActiveTs } : {}),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
