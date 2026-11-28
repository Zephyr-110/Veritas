"use client";

import "@/polyfill";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { Buffer } from "buffer";
import {
  DEFAULT_CLUSTER,
  DEFAULT_COLLATERAL_MINT,
  DEFAULT_PROGRAM_ID,
  DEFAULT_RPC,
  STORAGE_KEY,
} from "@/lib/constants";
import { recordNavigation } from "@/lib/nav-history";
import { parsePubkey } from "@/lib/program";
import type { AppSettings, ClusterName, ToastItem, ToastKind } from "@/lib/types";
import { LocaleProvider, useT } from "@/i18n/provider";
import { localizeError, parseTxError } from "@/lib/errors";
import { hasKey } from "@/i18n/store";
import { markTxRefresh } from "@/hooks/use-markets";
import { GuestSessionProvider } from "./guest-session";

import "@solana/wallet-adapter-react-ui/styles.css";

if (typeof window !== "undefined") {
  (window as Window & { Buffer: typeof Buffer }).Buffer = window.Buffer || Buffer;
}

const fallbackSettings: AppSettings = {
  rpcUrl: DEFAULT_RPC,
  cluster: DEFAULT_CLUSTER as ClusterName,
  programId: DEFAULT_PROGRAM_ID,
  collateralMint: DEFAULT_COLLATERAL_MINT,
};

function sanitizeSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const merged = { ...fallbackSettings, ...(raw ?? {}) };
  if (!parsePubkey(merged.programId)) merged.programId = fallbackSettings.programId;
  if (!parsePubkey(merged.collateralMint)) merged.collateralMint = fallbackSettings.collateralMint;
  if (!merged.rpcUrl || !/^https?:\/\//i.test(merged.rpcUrl) && merged.rpcUrl !== "http://127.0.0.1:8899") {
    if (!merged.rpcUrl) merged.rpcUrl = fallbackSettings.rpcUrl;
  }
  if (!["localnet", "devnet", "testnet", "mainnet-beta"].includes(merged.cluster)) {
    merged.cluster = fallbackSettings.cluster;
  }
  return merged;
}

function loadSettings(): AppSettings {
  if (typeof window === "undefined") return fallbackSettings;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallbackSettings;
    return sanitizeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return fallbackSettings;
  }
}

type SettingsCtx = {
  settings: AppSettings;
  setSettings: (next: AppSettings) => void;
};

export const DEFAULT_TOAST_MS = 5200;
export const DEFAULT_ERR_TOAST_MS = 6500;
export const MAX_ERR_TOAST_MS = 10_000;

export type ToastOptions = {
  sticky?: boolean;
  durationMs?: number;
  marketAddress?: string;
  action?: string;
};

export type ToastPatch = {
  kind?: ToastKind;
  title?: string;
  detail?: string;
  href?: string;
  sticky?: boolean;
  durationMs?: number;
  marketAddress?: string;
  action?: string;
};

type ToastCtx = {
  toasts: ToastItem[];
  push: (
    kind: ToastKind,
    title: string,
    detail?: string,
    href?: string,
    opts?: ToastOptions
  ) => number;
  update: (id: number, patch: ToastPatch) => void;
  dismiss: (id: number) => void;
  clearMarketErrors: (marketAddress: string, action?: string) => void;
};

type RefreshCtx = {
  nonce: number;
  bump: () => void;
};

const SettingsContext = createContext<SettingsCtx | null>(null);
const ToastContext = createContext<ToastCtx | null>(null);
const RefreshContext = createContext<RefreshCtx | null>(null);

export function useSettings(): SettingsCtx {
  const ctx = useContext(SettingsContext);
  if (!ctx) return { settings: fallbackSettings, setSettings: () => {} };
  return ctx;
}

function NavHistoryTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname) return;
    const search = typeof window !== "undefined" ? window.location.search : "";
    recordNavigation(pathname, search);
  }, [pathname]);
  return null;
}

export function useToasts(): ToastCtx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used inside Providers");
  return ctx;
}

export function useRefresh(): RefreshCtx {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used inside Providers");
  return ctx;
}

function SettingsInner({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<AppSettings>(fallbackSettings);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [nonce, setNonce] = useState(0);
  const queryClient = useQueryClient();
  const t = useT();
  const toastTimersRef = useRef<Map<number, number>>(new Map());
  const refreshTimersRef = useRef<number[]>([]);
  const nextToastIdRef = useRef(1);

  useEffect(() => {
    setSettingsState(loadSettings());
  }, []);

  useEffect(() => {
    const timers = toastTimersRef.current;
    const refreshTimers = refreshTimersRef;
    return () => {
      timers.forEach((timerId) => window.clearTimeout(timerId));
      timers.clear();
      refreshTimers.current.forEach((timerId) => window.clearTimeout(timerId));
      refreshTimers.current = [];
    };
  }, []);

  const setSettings = useCallback((next: AppSettings) => {
    const clean = sanitizeSettings(next);
    setSettingsState(clean);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const clearToastTimer = useCallback((id: number) => {
    const existing = toastTimersRef.current.get(id);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      toastTimersRef.current.delete(id);
    }
  }, []);

  const scheduleToastDismiss = useCallback(
    (id: number, durationMs = DEFAULT_TOAST_MS) => {
      clearToastTimer(id);
      const timerId = window.setTimeout(() => {
        toastTimersRef.current.delete(id);
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, durationMs);
      toastTimersRef.current.set(id, timerId);
    },
    [clearToastTimer]
  );

  const boundedErrorDuration = useCallback((durationMs?: number) => {
    const raw = durationMs ?? DEFAULT_ERR_TOAST_MS;
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ERR_TOAST_MS;
    return Math.min(raw, MAX_ERR_TOAST_MS);
  }, []);

  const clearMarketErrors = useCallback(
    (marketAddress: string, action?: string) => {
      if (!marketAddress) return;
      setToasts((prev) => {
        let changed = false;
        const next = prev.filter((item) => {
          const match =
            item.kind === "err" &&
            item.marketAddress === marketAddress &&
            (action === undefined || item.action === action);
          if (match) {
            clearToastTimer(item.id);
            changed = true;
            return false;
          }
          return true;
        });
        return changed ? next : prev;
      });
    },
    [clearToastTimer]
  );

  const resolveDetail = useCallback((detail?: string) => {
    if (!detail) return undefined;
    return hasKey(detail) ? localizeError(detail) : detail;
  }, []);

  const push = useCallback(
    (
      kind: ToastKind,
      title: string,
      detail?: string,
      href?: string,
      opts?: ToastOptions
    ): number => {
      const id = Date.now() * 1000 + (nextToastIdRef.current++ % 1000);
      const safeDetail = resolveDetail(detail);
      const marketAddress = opts?.marketAddress;
      const action = opts?.action;
      setToasts((prev) => {
        const base =
          kind === "ok" && marketAddress
            ? prev.filter((item) => {
                const staleErr =
                  item.kind === "err" &&
                  item.marketAddress === marketAddress &&
                  (action === undefined || item.action === action);
                if (staleErr) clearToastTimer(item.id);
                return !staleErr;
              })
            : prev;
        return [
          ...base.slice(-4),
          { id, kind, title, detail: safeDetail, href, marketAddress, action },
        ];
      });
      if (kind === "err") {
        scheduleToastDismiss(id, boundedErrorDuration(opts?.durationMs));
      } else if (!opts?.sticky) {
        scheduleToastDismiss(id, opts?.durationMs ?? DEFAULT_TOAST_MS);
      }
      return id;
    },
    [boundedErrorDuration, clearToastTimer, resolveDetail, scheduleToastDismiss]
  );

  const update = useCallback(
    (id: number, patch: ToastPatch) => {
      let resolvedKind: ToastKind | undefined = patch.kind;
      setToasts((prev) => {
        const current = prev.find((item) => item.id === id);
        if (!current) return prev;
        const nextKind = patch.kind ?? current.kind;
        resolvedKind = nextKind;
        const nextMarket = "marketAddress" in patch ? patch.marketAddress : current.marketAddress;
        const nextAction = "action" in patch ? patch.action : current.action;
        const nextItem: ToastItem = {
          ...current,
          kind: nextKind,
          title: patch.title ?? current.title,
          detail: "detail" in patch ? resolveDetail(patch.detail) : current.detail,
          href: "href" in patch ? patch.href : current.href,
          marketAddress: nextMarket,
          action: nextAction,
        };
        const out: ToastItem[] = [];
        for (const item of prev) {
          if (item.id === id) {
            out.push(nextItem);
            continue;
          }
          if (
            nextKind === "ok" &&
            nextMarket &&
            item.kind === "err" &&
            item.marketAddress === nextMarket &&
            (nextAction === undefined || item.action === nextAction)
          ) {
            clearToastTimer(item.id);
            continue;
          }
          out.push(item);
        }
        return out;
      });
      if (resolvedKind === "err") {
        scheduleToastDismiss(id, boundedErrorDuration(patch.durationMs));
      } else if (patch.sticky) {
        clearToastTimer(id);
      } else {
        scheduleToastDismiss(id, patch.durationMs ?? DEFAULT_TOAST_MS);
      }
    },
    [boundedErrorDuration, clearToastTimer, resolveDetail, scheduleToastDismiss]
  );

  const dismiss = useCallback(
    (id: number) => {
      clearToastTimer(id);
      setToasts((prev) => prev.filter((item) => item.id !== id));
    },
    [clearToastTimer]
  );

  const bump = useCallback(() => {
    refreshTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    refreshTimersRef.current = [];
    const invalidatePostTx = (includeLists: boolean) => {
      markTxRefresh();
      void queryClient.invalidateQueries({ queryKey: ["market"], refetchType: "all" });
      void queryClient.invalidateQueries({ queryKey: ["position"], refetchType: "all" });
      void queryClient.invalidateQueries({ queryKey: ["positions"], refetchType: "all" });
      void queryClient.invalidateQueries({ queryKey: ["redemptions"], refetchType: "all" });
      void queryClient.invalidateQueries({ queryKey: ["sandbox-balance"], refetchType: "all" });
      void queryClient.invalidateQueries({ queryKey: ["wallet-balance"], refetchType: "all" });
      void queryClient.invalidateQueries({ queryKey: ["ruling-db"], refetchType: "all" });
      void queryClient.invalidateQueries({ queryKey: ["ruling"], refetchType: "all" });
      if (includeLists) {
        void queryClient.invalidateQueries({ queryKey: ["markets"], refetchType: "all" });
        void queryClient.invalidateQueries({ queryKey: ["visible-vaults"] });
      }
    };
    setNonce((n) => n + 1);
    invalidatePostTx(true);
    for (const delayMs of [1500, 4000]) {
      const id = window.setTimeout(() => invalidatePostTx(false), delayMs);
      refreshTimersRef.current.push(id);
    }
  }, [queryClient]);
  const wallets = useMemo(() => [], []);

  const onWalletError = useCallback(
    (err: { name?: string; message?: string }) => {
      const tag = `${err.name ?? ""} ${err.message ?? ""}`;
      if (/WalletNotSelected|WalletNotReady|WalletLoad|WalletSignTransaction|WalletSendTransaction/i.test(tag)) {
        return;
      }
      const key = parseTxError(err);
      const detail = key === "errors.txFailed" ? err.message || undefined : key;
      push("err", t("errors.wallet"), detail);
    },
    [push, t]
  );

  return (
    <SettingsContext.Provider value={{ settings, setSettings }}>
      <ToastContext.Provider value={{ toasts, push, update, dismiss, clearMarketErrors }}>
        <RefreshContext.Provider value={{ nonce, bump }}>
          <ConnectionProvider endpoint={settings.rpcUrl} config={{ commitment: "confirmed" }}>
            <WalletProvider wallets={wallets} autoConnect onError={onWalletError}>
              <WalletModalProvider>
                <GuestSessionProvider>
                  <NavHistoryTracker />
                  {children}
                  <ToastViewport toasts={toasts} dismiss={dismiss} />
                </GuestSessionProvider>
              </WalletModalProvider>
            </WalletProvider>
          </ConnectionProvider>
        </RefreshContext.Provider>
      </ToastContext.Provider>
    </SettingsContext.Provider>
  );
}

function ToastLinkFallback() {
  const t = useT();
  return <>{t("tx.view")}</>;
}

function ToastViewport({
  toasts,
  dismiss,
}: {
  toasts: ToastItem[];
  dismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[80] flex w-[min(92vw,360px)] flex-col gap-2">
      {toasts.map((item) => (
        <div
          key={item.id}
          role={item.kind === "err" ? "alert" : "status"}
          aria-live={item.kind === "err" ? "assertive" : "polite"}
          className={`toast-in pointer-events-auto border px-4 py-3 text-left shadow-glow backdrop-blur-2xl ${
            item.kind === "ok"
              ? "border-[var(--yes-line)] bg-[var(--float-bg)] text-[var(--yes)]"
              : item.kind === "err"
                ? "border-[var(--no)]/60 bg-[var(--float-bg)] text-[var(--no)]"
                : "border-[var(--card-line)] bg-[var(--float-bg)] text-[var(--ink)]"
          }`}
        >
          <button type="button" className="w-full text-left" onClick={() => dismiss(item.id)}>
            <div className="font-medium">{item.title}</div>
            {item.detail && !item.href ? (
              <div
                className={
                  item.kind === "err" ? "mt-1 text-xs text-[var(--no)]/90" : "mt-1 text-xs text-mute"
                }
              >
                {item.detail}
              </div>
            ) : null}
          </button>
          {item.href ? (
            <a
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className="link-accent mt-2 inline-block text-xs"
            >
              {item.detail ?? <ToastLinkFallback />}
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <SettingsInner>{children}</SettingsInner>
      </LocaleProvider>
    </QueryClientProvider>
  );
}


