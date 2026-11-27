"use client";

import { useCallback, useEffect, useState } from "react";

export const BALANCE_VISIBILITY_KEY = "veritas.hideBalances.v1";

let cachedHidden = false;
let initialized = false;
const listeners = new Set<() => void>();

function readStoredHidden(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(BALANCE_VISIBILITY_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredHidden(next: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BALANCE_VISIBILITY_KEY, next ? "1" : "0");
  } catch {
    // storage unavailable
  }
}

function notify() {
  listeners.forEach((fn) => fn());
}

export function setBalancesHidden(next: boolean): void {
  initialized = true;
  if (cachedHidden === next) return;
  cachedHidden = next;
  writeStoredHidden(next);
  notify();
}

export function resetBalanceVisibilityForTests(): void {
  cachedHidden = false;
  initialized = false;
  listeners.clear();
}

export function useBalanceVisibility() {
  const [hidden, setHiddenState] = useState<boolean>(false);

  useEffect(() => {
    if (!initialized) {
      cachedHidden = readStoredHidden();
      initialized = true;
    }
    setHiddenState(cachedHidden);

    const sync = () => setHiddenState(cachedHidden);
    listeners.add(sync);

    const onStorage = (e: StorageEvent) => {
      if (e.key !== BALANCE_VISIBILITY_KEY) return;
      cachedHidden = e.newValue === "1";
      notify();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const toggle = useCallback(() => {
    setBalancesHidden(!cachedHidden);
  }, []);

  const setHidden = useCallback((next: boolean) => {
    setBalancesHidden(next);
  }, []);

  return { hidden, toggle, setHidden };
}

export const MASKED_BALANCE = "••••";

export function maskAmount(formatted: string, hidden: boolean, unit?: string): string {
  if (!hidden) return unit ? `${formatted} ${unit}` : formatted;
  return unit ? `${MASKED_BALANCE} ${unit}` : MASKED_BALANCE;
}
