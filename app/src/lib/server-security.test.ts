import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID, DEFAULT_RPC } from "./constants";
import { closeServerDb, getServerDb, clearEvidenceHealStateForTests, syncWalletPositionsOnDemand } from "./server-db";
import {
  checkDailyCountCap,
  parseStrictPositiveInt,
  recordDailyCount,
  resetServerSecurityForTests,
  resolveServerRpcUrl,
  validateClusterParam,
  validateFaucetRequest,
} from "./server-security";
import { resetSandboxFaucetGuardForTests } from "./sandbox-faucet-guard";
import { GET as getMarketsApi } from "@/app/api/markets/route";
import { GET as getPositionsApi } from "@/app/api/positions/route";
import { GET as getEvidenceApi } from "@/app/api/evidence/[address]/route";
import { POST as postFaucetApi } from "@/app/api/faucet/route";
import { POST as postSandboxFaucetApi } from "@/app/api/faucet/sandbox/route";

let tmpDir: string;
let dbPath: string;
const prevDbEnv = process.env.VERITAS_DB_PATH;
const prevSyncDisable = process.env.VERITAS_DISABLE_ON_DEMAND_SYNC;
const prevFaucetKey = process.env.FAUCET_KEYPAIR_PATH;
const prevSandboxFaucetKey = process.env.SANDBOX_FAUCET_KEYPAIR_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veritas-sec-"));
  dbPath = path.join(tmpDir, "veritas.db");
  process.env.VERITAS_DB_PATH = dbPath;
  process.env.VERITAS_DISABLE_ON_DEMAND_SYNC = "1";
  getServerDb(dbPath);
  clearEvidenceHealStateForTests();
  resetServerSecurityForTests();
  resetSandboxFaucetGuardForTests();
});

afterEach(() => {
  closeServerDb();
  if (prevDbEnv === undefined) delete process.env.VERITAS_DB_PATH;
  else process.env.VERITAS_DB_PATH = prevDbEnv;
  if (prevSyncDisable === undefined) delete process.env.VERITAS_DISABLE_ON_DEMAND_SYNC;
  else process.env.VERITAS_DISABLE_ON_DEMAND_SYNC = prevSyncDisable;
  if (prevFaucetKey === undefined) delete process.env.FAUCET_KEYPAIR_PATH;
  else process.env.FAUCET_KEYPAIR_PATH = prevFaucetKey;
  if (prevSandboxFaucetKey === undefined) delete process.env.SANDBOX_FAUCET_KEYPAIR_PATH;
  else process.env.SANDBOX_FAUCET_KEYPAIR_PATH = prevSandboxFaucetKey;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("server-security helpers & route hardening", () => {
  it("validates strict positive integers and rejects scientific/negative/float/overflow inputs", () => {
    expect(parseStrictPositiveInt(null, { defaultValue: 1, max: 10_000 })).toEqual({ ok: true, value: 1 });
    expect(parseStrictPositiveInt("42", { defaultValue: 1, max: 10_000 })).toEqual({ ok: true, value: 42 });
    for (const bad of ["1e99", "0", "-1", "1.5", "abc", "Infinity", "NaN", "10001"]) {
      expect(parseStrictPositiveInt(bad, { defaultValue: 1, max: 10_000 })).toEqual({ ok: false });
    }
    expect(validateClusterParam("devnet")).toBe("devnet");
    expect(validateClusterParam("evil")).toBeUndefined();
    expect(resolveServerRpcUrl()).toBeTruthy();
    expect(DEFAULT_RPC).toContain("devnet");
  });

  it("rejects invalid pagination params on /api/markets with 400 JSON and clamps pageSize to 50", async () => {
    for (const q of [
      "page=1e99",
      "page=0",
      "page=-3",
      "page=1.5",
      "page=abc",
      "pageSize=1e99",
      "pageSize=0",
    ]) {
      const res = await getMarketsApi(new Request(`http://localhost/api/markets?${q}`));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/^bad_page/);
    }

    const okRes = await getMarketsApi(
      new Request(`http://localhost/api/markets?programId=${DEFAULT_PROGRAM_ID}&page=1&pageSize=100`)
    );
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { pageSize: number };
    expect(okBody.pageSize).toBe(50);
  });

  it("hardens /api/positions pagination, refresh burst rate limit, and ignores client rpcUrl", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const badPage = await getPositionsApi(
      new Request(`http://localhost/api/positions?wallet=${wallet}&page=1e99`)
    );
    expect(badPage.status).toBe(400);

    // 6 forced refreshes per 60s succeed, 7th is rate-limited
    for (let i = 0; i < 6; i += 1) {
      const r = await getPositionsApi(
        new Request(
          `http://localhost/api/positions?wallet=${wallet}&refresh=1&rpcUrl=http://169.254.169.254/`,
          { headers: { "x-real-ip": "203.0.113.9" } }
        )
      );
      expect(r.status).toBe(200);
    }
    const throttled = await getPositionsApi(
      new Request(`http://localhost/api/positions?wallet=${wallet}&refresh=1`, {
        headers: { "x-real-ip": "203.0.113.9" },
      })
    );
    expect(throttled.status).toBe(429);

    // Per-wallet forceRefresh cooldown prevents repeated RPC calls within 10s
    const getTokenAccountsByOwner = vi.fn(async () => ({ value: [] }));
    const getProgramAccounts = vi.fn(async () => []);
    const fakeConn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getTokenAccountsByOwner,
      getProgramAccounts,
    } as unknown as Connection;

    await syncWalletPositionsOnDemand({
      wallet,
      programId: DEFAULT_PROGRAM_ID,
      forceRefresh: true,
      forceCooldownSec: 10,
      dbPath,
      connectionOverride: fakeConn,
    });
    await syncWalletPositionsOnDemand({
      wallet,
      programId: DEFAULT_PROGRAM_ID,
      forceRefresh: true,
      forceCooldownSec: 10,
      dbPath,
      connectionOverride: fakeConn,
    });
    expect(getProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it("ignores client rpcUrl and unsafe cluster on /api/evidence/[address]", async () => {
    const market = Keypair.generate().publicKey.toBase58();
    const res = await getEvidenceApi(
      new Request(
        `http://localhost/api/evidence/${market}?programId=${DEFAULT_PROGRAM_ID}&cluster=http://evil&rpcUrl=http://169.254.169.254/`
      ),
      { params: Promise.resolve({ address: market }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { found: boolean };
    expect(body.found).toBe(false);
  });

  it("enforces Content-Type JSON and same-origin checks + burst caps on /api/faucet and /api/faucet/sandbox", async () => {
    process.env.FAUCET_KEYPAIR_PATH = path.join(tmpDir, "missing-key.json");
    process.env.SANDBOX_FAUCET_KEYPAIR_PATH = path.join(tmpDir, "missing-key.json");
    const addr = Keypair.generate().publicKey.toBase58();

    // validateFaucetRequest rejects non-JSON, missing Origin, cross-site Sec-Fetch-Site, mismatched Origin
    const textPlain = new Request("https://veritas.zephyr110.com/api/faucet", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://veritas.zephyr110.com",
        host: "veritas.zephyr110.com",
      },
      body: JSON.stringify({ address: addr }),
    });
    expect(validateFaucetRequest(textPlain)).toEqual({
      ok: false,
      status: 415,
      error: "unsupported_media_type",
    });

    const crossSite = new Request("https://veritas.zephyr110.com/api/faucet/sandbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        host: "veritas.zephyr110.com",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ address: addr }),
    });
    expect(validateFaucetRequest(crossSite)).toEqual({
      ok: false,
      status: 403,
      error: "forbidden_origin",
    });

    const resFaucetBadCt = await postFaucetApi(textPlain);
    expect(resFaucetBadCt.status).toBe(415);
    const resSandboxBadOrigin = await postSandboxFaucetApi(crossSite);
    expect(resSandboxBadOrigin.status).toBe(403);

    // Same-origin JSON passes origin guard and hits per-IP burst rate limit
    for (let i = 0; i < 12; i += 1) {
      const okReq = new Request("https://veritas.zephyr110.com/api/faucet/sandbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://veritas.zephyr110.com",
          host: "veritas.zephyr110.com",
          "sec-fetch-site": "same-origin",
          "x-real-ip": "198.51.100.22",
        },
        body: JSON.stringify({ address: "not-a-pubkey" }),
      });
      const r = await postSandboxFaucetApi(okReq);
      expect(r.status).toBe(400);
    }
    const burstBlocked = await postSandboxFaucetApi(
      new Request("https://veritas.zephyr110.com/api/faucet/sandbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://veritas.zephyr110.com",
          host: "veritas.zephyr110.com",
          "sec-fetch-site": "same-origin",
          "x-real-ip": "198.51.100.22",
        },
        body: JSON.stringify({ address: addr }),
      })
    );
    expect(burstBlocked.status).toBe(429);

    // Daily global claim cap resets on UTC day rollover
    const d1 = Date.UTC(2026, 10, 25, 12, 0, 0);
    const d2 = Date.UTC(2026, 10, 26, 0, 0, 1);
    expect(checkDailyCountCap("test-cap", 2, d1)).toBe(true);
    recordDailyCount("test-cap", d1);
    recordDailyCount("test-cap", d1);
    expect(checkDailyCountCap("test-cap", 2, d1)).toBe(false);
    expect(checkDailyCountCap("test-cap", 2, d2)).toBe(true);
  });

  it("configures Content-Security-Policy-Report-Only header in next.config.js", async () => {
    const nextConfigModule = await import("../../next.config.js");
    const cfg = (nextConfigModule.default ?? nextConfigModule) as {
      headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
    };
    const rules = await cfg.headers();
    expect(rules).toHaveLength(1);
    const csp = rules[0].headers.find((h) => h.key === "Content-Security-Policy-Report-Only");
    expect(csp).toBeDefined();
    expect(csp?.value).toContain("frame-ancestors 'none'");
    expect(csp?.value).toContain("object-src 'none'");
    expect(csp?.value).toContain("base-uri 'self'");
  });
});
