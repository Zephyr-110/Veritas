"use client";

import "@/polyfill";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { Buffer } from "buffer";
import {
  DEFAULT_CLUSTER,
  DEFAULT_COLLATERAL_MINT,
  DEFAULT_PROGRAM_ID,
  DEFAULT_RPC,
  STORAGE_KEY,
} from "@/lib/constants";
import { parsePubkey } from "@/lib/program";
import type { AppSettings, ClusterName, ToastItem, ToastKind } from "@/lib/types";
import { LocaleProvider, useT } from "@/i18n/provider";
import { localizeError, parseTxError } from "@/lib/errors";
import { hasKey } from "@/i18n/store";

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

type ToastCtx = {
  toasts: ToastItem[];
  push: (kind: ToastKind, title: string, detail?: string, href?: string) => void;
  dismiss: (id: number) => void;
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
  if (!ctx) throw new Error("useSettings must be used inside Providers");
  return ctx;
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
  const t = useT();

  useEffect(() => {
    setSettingsState(loadSettings());
  }, []);

  const setSettings = useCallback((next: AppSettings) => {
    const clean = sanitizeSettings(next);
    setSettingsState(clean);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  }, []);

  const push = useCallback((kind: ToastKind, title: string, detail?: string, href?: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const safeDetail = !detail ? undefined : hasKey(detail) ? localizeError(detail) : detail;
    setToasts((prev) => [...prev.slice(-4), { id, kind, title, detail: safeDetail, href }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 5200);
  }, [t]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const bump = useCallback(() => setNonce((n) => n + 1), []);
  const wallets = useMemo(() => [], []);

  const onWalletError = useCallback(
    (err: { name?: string; message?: string }) => {
      if (/WalletNotSelected|WalletNotReady|WalletLoad/i.test(`${err.name ?? ""} ${err.message ?? ""}`)) return;
      push("err", t("errors.wallet"), parseTxError(err));
    },
    [push, t]
  );

  return (
    <SettingsContext.Provider value={{ settings, setSettings }}>
      <ToastContext.Provider value={{ toasts, push, dismiss }}>
        <RefreshContext.Provider value={{ nonce, bump }}>
          <ConnectionProvider endpoint={settings.rpcUrl} config={{ commitment: "confirmed" }}>
            <WalletProvider wallets={wallets} autoConnect onError={onWalletError}>
              <WalletModalProvider>
                {children}
                <ToastViewport toasts={toasts} dismiss={dismiss} />
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
          className={`toast-in pointer-events-auto rounded-2xl border px-4 py-3 text-left shadow-glow backdrop-blur ${
            item.kind === "ok"
              ? "border-yes/40 bg-panel text-yes"
              : item.kind === "err"
                ? "border-no/40 bg-panel text-no"
                : "border-line bg-panel text-ink"
          }`}
        >
          <button type="button" className="w-full text-left" onClick={() => dismiss(item.id)}>
            <div className="font-medium">{item.title}</div>
            {item.detail && !item.href ? <div className="mt-1 text-xs text-mute">{item.detail}</div> : null}
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


