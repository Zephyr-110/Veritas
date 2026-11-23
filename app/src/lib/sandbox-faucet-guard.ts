const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_MS = 10_000;

type AddressLock = {
  inFlight: boolean;
  lockedUntil: number;
};

type SandboxFaucetGuardState = {
  ipClaims: Map<string, number[]>;
  dailySol: { dayKey: string; lamports: number };
  addressLocks: Map<string, AddressLock>;
};

const globalScope = globalThis as typeof globalThis & {
  __veritasSandboxFaucetGuard?: SandboxFaucetGuardState;
};

function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function createInitialState(now = Date.now()): SandboxFaucetGuardState {
  return {
    ipClaims: new Map<string, number[]>(),
    dailySol: { dayKey: utcDayKey(now), lamports: 0 },
    addressLocks: new Map<string, AddressLock>(),
  };
}

function getStore(now = Date.now()): SandboxFaucetGuardState {
  if (!globalScope.__veritasSandboxFaucetGuard) {
    globalScope.__veritasSandboxFaucetGuard = createInitialState(now);
  }
  const store = globalScope.__veritasSandboxFaucetGuard;
  const today = utcDayKey(now);
  if (store.dailySol.dayKey !== today) {
    store.dailySol = { dayKey: today, lamports: 0 };
  }
  return store;
}

export function extractClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip")?.trim();
  if (xri) return xri;
  return "unknown";
}

export function acquireAddressLock(
  address: string,
  now = Date.now(),
  lockMs = DEFAULT_LOCK_MS
): boolean {
  const store = getStore(now);
  const existing = store.addressLocks.get(address);
  if (existing && (existing.inFlight || now < existing.lockedUntil)) {
    return false;
  }
  store.addressLocks.set(address, {
    inFlight: true,
    lockedUntil: now + Math.max(0, lockMs),
  });
  return true;
}

export function releaseAddressLock(
  address: string,
  opts: { keepCooldown: boolean; now?: number; lockMs?: number }
): void {
  const now = opts.now ?? Date.now();
  const lockMs = opts.lockMs ?? DEFAULT_LOCK_MS;
  const store = getStore(now);
  if (!opts.keepCooldown) {
    store.addressLocks.delete(address);
    return;
  }
  store.addressLocks.set(address, {
    inFlight: false,
    lockedUntil: now + Math.max(0, lockMs),
  });
}

function pruneIpHistory(store: SandboxFaucetGuardState, ip: string, now: number): number[] {
  const cutoff = now - DAY_MS;
  const raw = store.ipClaims.get(ip) ?? [];
  const valid = raw.filter((ts) => ts > cutoff);
  if (valid.length === 0) {
    store.ipClaims.delete(ip);
  } else if (valid.length !== raw.length) {
    store.ipClaims.set(ip, valid);
  }
  return valid;
}

export function checkIpLimit(ip: string, limit: number, now = Date.now()): boolean {
  if (limit <= 0) return false;
  const store = getStore(now);
  const valid = pruneIpHistory(store, ip, now);
  return valid.length < limit;
}

export function recordIpClaim(ip: string, now = Date.now()): void {
  const store = getStore(now);
  const valid = pruneIpHistory(store, ip, now);
  valid.push(now);
  store.ipClaims.set(ip, valid);
}

export function checkDailySolCap(
  lamportsNeeded: number,
  capLamports: number,
  now = Date.now()
): boolean {
  const store = getStore(now);
  if (capLamports < 0) return false;
  return store.dailySol.lamports + Math.max(0, lamportsNeeded) <= capLamports;
}

export function recordDailySol(lamportsSpent: number, now = Date.now()): void {
  const store = getStore(now);
  store.dailySol.lamports += Math.max(0, lamportsSpent);
}

export function resetSandboxFaucetGuardForTests(): void {
  globalScope.__veritasSandboxFaucetGuard = createInitialState();
}
