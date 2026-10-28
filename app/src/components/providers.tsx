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
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { Buffer } from "buffer";
import {
  DEFAULT_CLUSTER,
  DEFAULT_COLLATERAL_MINT,
  DEFAULT_PROGRAM_ID,
  DEFAULT_RPC,
  STORAGE_KEY,
} from "@/lib/constants";
import type { AppSettings, ClusterName, ToastItem, ToastKind } from "@/lib/types";

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

function loadSettings(): AppSettings {
  if (typeof window === "undefined") return fallbackSettings;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallbackSettings;
    return { ...fallbackSettings, ...JSON.parse(raw) };
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
  push: (kind: ToastKind, title: string, detail?: string) => void;
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
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setSettingsState(loadSettings());
    setReady(true);
  }, []);

  const setSettings = useCallback((next: AppSettings) => {
    setSettingsState(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const push = useCallback((kind: ToastKind, title: string, detail?: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev.slice(-4), { id, kind, title, detail }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5200);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const bump = useCallback(() => setNonce((n) => n + 1), []);

  const wallets = useMemo(() => [], []);

  if (!ready) {
    return <div className="min-h-screen bg-bg" />;
  }

  return (
    <SettingsContext.Provider value={{ settings, setSettings }}>
      <ToastContext.Provider value={{ toasts, push, dismiss }}>
        <RefreshContext.Provider value={{ nonce, bump }}>
          <ConnectionProvider endpoint={settings.rpcUrl} config={{ commitment: "confirmed" }}>
            <WalletProvider wallets={wallets} autoConnect>
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

function ToastViewport({
  toasts,
  dismiss,
}: {
  toasts: ToastItem[];
  dismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[80] flex w-[min(92vw,360px)] flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto rounded-2xl border px-4 py-3 text-left shadow-glow backdrop-blur ${
            t.kind === "ok"
              ? "border-yes/40 bg-panel text-yes"
              : t.kind === "err"
                ? "border-no/40 bg-panel text-no"
                : "border-line bg-panel text-ink"
          }`}
        >
          <div className="font-medium">{t.title}</div>
          {t.detail ? <div className="mt-1 text-xs text-mute break-all">{t.detail}</div> : null}
        </button>
      ))}
    </div>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return <SettingsInner>{children}</SettingsInner>;
}
