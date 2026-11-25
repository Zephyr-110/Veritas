import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@/lib/constants";
import type { DurationFilter } from "@/lib/display";
import type { ListSectionFilter } from "@/lib/market-dto";
import { queryMarketsPage } from "@/lib/server-db";
import { parseStrictPositiveInt } from "@/lib/server-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_SECTIONS = new Set<ListSectionFilter>(["live", "ended", "all"]);
const VALID_DURATIONS = new Set<DurationFilter>(["all", "2m", "15m", "24h"]);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const programIdRaw = (searchParams.get("programId") || DEFAULT_PROGRAM_ID).trim();
  const sectionRaw = (searchParams.get("section") || "all").trim() as ListSectionFilter;
  const durationRaw = (searchParams.get("duration") || "all").trim() as DurationFilter;
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

  try {
    new PublicKey(programIdRaw);
  } catch {
    return Response.json({ error: "bad_program_id" }, { status: 400 });
  }

  const section: ListSectionFilter = VALID_SECTIONS.has(sectionRaw) ? sectionRaw : "all";
  const duration: DurationFilter = VALID_DURATIONS.has(durationRaw) ? durationRaw : "all";
  const page = parsedPage.value;
  const pageSize = Math.min(50, parsedPageSize.value);

  const payload = queryMarketsPage({
    programId: programIdRaw,
    section,
    duration,
    page,
    pageSize,
  });

  return Response.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
