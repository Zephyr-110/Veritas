import { describe, it, expect, beforeEach } from "vitest";
import {
  acquireAddressLock,
  checkDailySolCap,
  checkIpLimit,
  extractClientIp,
  recordDailySol,
  recordIpClaim,
  releaseAddressLock,
  resetSandboxFaucetGuardForTests,
} from "./sandbox-faucet-guard";

describe("sandbox-faucet-guard", () => {
  beforeEach(() => {
    resetSandboxFaucetGuardForTests();
  });

  it("extracts client IP from x-forwarded-for or x-real-ip", () => {
    const req1 = new Request("http://localhost/api/faucet/sandbox", {
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
    });
    expect(extractClientIp(req1)).toBe("203.0.113.10");

    const req2 = new Request("http://localhost/api/faucet/sandbox", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    expect(extractClientIp(req2)).toBe("198.51.100.7");

    const req3 = new Request("http://localhost/api/faucet/sandbox");
    expect(extractClientIp(req3)).toBe("unknown");
  });

  it("enforces rolling 24h IP limit of 5 claims and resets after 24h", () => {
    const t0 = 1_763_900_000_000;
    const ip = "203.0.113.1";
    for (let i = 0; i < 5; i += 1) {
      expect(checkIpLimit(ip, 5, t0 + i * 1000)).toBe(true);
      recordIpClaim(ip, t0 + i * 1000);
    }
    expect(checkIpLimit(ip, 5, t0 + 10_000)).toBe(false);
    expect(checkIpLimit("203.0.113.2", 5, t0 + 10_000)).toBe(true);

    // After 24h + 1ms from the oldest entry, slot frees up
    const dayMs = 24 * 60 * 60 * 1000;
    expect(checkIpLimit(ip, 5, t0 + dayMs + 1)).toBe(true);
  });

  it("enforces global UTC daily SOL cap and resets on next UTC day", () => {
    const day1 = Date.UTC(2026, 10, 23, 12, 0, 0);
    const day2 = Date.UTC(2026, 10, 24, 0, 0, 1);
    const cap = 100_000_000; // 0.1 SOL

    expect(checkDailySolCap(60_000_000, cap, day1)).toBe(true);
    recordDailySol(60_000_000, day1);
    expect(checkDailySolCap(40_000_000, cap, day1)).toBe(true);
    expect(checkDailySolCap(40_000_001, cap, day1)).toBe(false);

    // Next UTC day resets disbursed total
    expect(checkDailySolCap(60_000_000, cap, day2)).toBe(true);
  });

  it("blocks concurrent in-flight calls and enforces 10s cooldown when keepCooldown=true", () => {
    const addr = "11111111111111111111111111111111";
    const t0 = 1_763_900_000_000;

    expect(acquireAddressLock(addr, t0, 10_000)).toBe(true);
    // Concurrent request blocked immediately
    expect(acquireAddressLock(addr, t0 + 50, 10_000)).toBe(false);

    // Release with cooldown
    releaseAddressLock(addr, { keepCooldown: true, now: t0 + 100, lockMs: 10_000 });
    expect(acquireAddressLock(addr, t0 + 5_000, 10_000)).toBe(false);
    expect(acquireAddressLock(addr, t0 + 10_100, 10_000)).toBe(true);

    // Release without cooldown (e.g. skipped no-op)
    releaseAddressLock(addr, { keepCooldown: false, now: t0 + 10_200, lockMs: 10_000 });
    expect(acquireAddressLock(addr, t0 + 10_201, 10_000)).toBe(true);
  });
});
