import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetServerSecurityForTests } from "@/lib/server-security";
import { POST } from "./route";

function makeReq(headers: Record<string, string> = {}) {
  return new Request("https://veritas.example/api/sandbox/activate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://veritas.example",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: "{}",
  });
}

describe("POST /api/sandbox/activate", () => {
  const originalActiveFile = process.env.SANDBOX_ACTIVE_FILE;
  const originalKeypair = process.env.SANDBOX_FAUCET_KEYPAIR_PATH;
  let tempDir: string | null = null;

  beforeEach(() => {
    resetServerSecurityForTests();
    delete process.env.SANDBOX_ACTIVE_FILE;
    delete process.env.SANDBOX_FAUCET_KEYPAIR_PATH;
  });

  afterEach(() => {
    if (originalActiveFile === undefined) delete process.env.SANDBOX_ACTIVE_FILE;
    else process.env.SANDBOX_ACTIVE_FILE = originalActiveFile;
    if (originalKeypair === undefined) delete process.env.SANDBOX_FAUCET_KEYPAIR_PATH;
    else process.env.SANDBOX_FAUCET_KEYPAIR_PATH = originalKeypair;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("writes { lastActiveTs } to SANDBOX_ACTIVE_FILE without requiring faucet config", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "veritas-sandbox-active-"));
    const activePath = join(tempDir, "active.json");
    process.env.SANDBOX_ACTIVE_FILE = activePath;

    const before = Math.floor(Date.now() / 1000);
    const res = await POST(makeReq());
    const after = Math.floor(Date.now() / 1000);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; touched: boolean; lastActiveTs: number };
    expect(json.ok).toBe(true);
    expect(json.touched).toBe(true);
    expect(json.lastActiveTs).toBeGreaterThanOrEqual(before);
    expect(json.lastActiveTs).toBeLessThanOrEqual(after);

    const written = JSON.parse(readFileSync(activePath, "utf8")) as { lastActiveTs: number };
    expect(written).toEqual({ lastActiveTs: json.lastActiveTs });
  });

  it("returns ok with touched=false when SANDBOX_ACTIVE_FILE is unset", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; touched: boolean };
    expect(json).toEqual({ ok: true, touched: false });
  });

  it("rejects cross-origin requests", async () => {
    const res = await POST(
      makeReq({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })
    );
    expect(res.status).toBe(403);
  });
});
