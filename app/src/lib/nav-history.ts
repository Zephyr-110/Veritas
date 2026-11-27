"use client";

export type BackTarget = {
  href: string;
  labelKey: "market.back" | "market.backToMe" | "market.backToHome" | "market.backPrev";
  canRouterBack: boolean;
};

const STORAGE_KEY = "veritas.navHistory.v1";
const MAX_STACK = 20;

let stack: string[] = [];
let hydrated = false;

function isMarketDetailPath(path: string): boolean {
  const clean = path.split("?")[0]?.split("#")[0] ?? "";
  return /^\/(markets|m)\/[^/]+$/.test(clean);
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return "/markets";
  return trimmed;
}

function loadStack(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.startsWith("/")).slice(-MAX_STACK);
  } catch {
    return [];
  }
}

function saveStack(next: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(-MAX_STACK)));
  } catch {
    // sessionStorage unavailable
  }
}

function ensureHydrated() {
  if (!hydrated) {
    stack = loadStack();
    hydrated = true;
  }
}

export function recordNavigation(pathname: string, search = ""): void {
  ensureHydrated();
  const full = normalizePath(search ? `${pathname}${search.startsWith("?") ? search : `?${search}`}` : pathname);
  if (stack.length > 0 && stack[stack.length - 1] === full) return;
  // If user navigated back to the previous entry, pop instead of growing the stack.
  if (stack.length >= 2 && stack[stack.length - 2] === full) {
    stack = stack.slice(0, -1);
    saveStack(stack);
    return;
  }
  stack = [...stack.slice(-(MAX_STACK - 1)), full];
  saveStack(stack);
}

export function labelKeyForPath(href: string): BackTarget["labelKey"] {
  const clean = href.split("?")[0]?.split("#")[0] ?? "";
  if (clean === "/me" || clean.startsWith("/me/")) return "market.backToMe";
  if (clean === "/") return "market.backToHome";
  if (clean === "/markets") return "market.back";
  return "market.backPrev";
}

function sameOriginReferrerPath(currentPathname: string): string | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  if (!document.referrer) return null;
  try {
    const refUrl = new URL(document.referrer);
    if (refUrl.origin !== window.location.origin) return null;
    const candidate = `${refUrl.pathname}${refUrl.search}`;
    if (refUrl.pathname === currentPathname || isMarketDetailPath(refUrl.pathname)) return null;
    return normalizePath(candidate);
  } catch {
    return null;
  }
}

export function resolveBackTarget(currentPathname: string): BackTarget {
  ensureHydrated();
  // Look backwards through our in-app navigation stack for the most recent non-detail page
  // (or previous page different from currentPathname).
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    const entryPath = entry.split("?")[0]?.split("#")[0] ?? "";
    if (entryPath === currentPathname) continue;
    if (entryPath.startsWith("/m/")) continue;
    return {
      href: entry,
      labelKey: labelKeyForPath(entry),
      canRouterBack: i === stack.length - 2,
    };
  }

  const ref = sameOriginReferrerPath(currentPathname);
  if (ref) {
    return {
      href: ref,
      labelKey: labelKeyForPath(ref),
      canRouterBack: false,
    };
  }

  return {
    href: "/markets",
    labelKey: "market.back",
    canRouterBack: false,
  };
}

export function resetNavHistoryForTests(): void {
  stack = [];
  hydrated = false;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
