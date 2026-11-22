"use client";

import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, Droplets, ExternalLink, RefreshCw } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { PublicKey } from "@solana/web3.js";
import {
  DEFAULT_CLUSTER,
  DEFAULT_COLLATERAL_MINT,
  DEFAULT_PROGRAM_ID,
  DEFAULT_RPC,
  GITHUB_REPO,
} from "@/lib/constants";
import { kindLabelKey, kindTone, marketKind } from "@/lib/display";
import { explorerAccount, explorerTx, shorten } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { sendIxs, mustWallet } from "@/lib/send";
import type { ClusterName } from "@/lib/types";
import { useI18n, useLocale, useT } from "@/i18n/provider";
import { tPair, type Vars } from "@/i18n/store";
import { useFeeds } from "@/hooks/use-feeds";
import { PulseAreaMark } from "./logo-marks";
import { FEEDS, formatFeedPrice } from "@/lib/feeds";
import { PriceAge } from "./price-age";
import { useRefresh, useSettings, useToasts } from "./providers";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function onSpot(e: MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--sx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--sy", `${e.clientY - r.top}px`);
}

/**
 * Renders the active translation on top of a hidden sibling of the other
 * language inside a 1x1 CSS grid cell, guaranteeing identical max(EN, ZH)
 * box dimensions and <1px layout shift across bilingual toggles.
 */
export function StableText({
  k,
  vars,
  block = false,
  align = "start",
  className,
}: {
  k: string;
  vars?: Vars;
  block?: boolean;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const locale = useLocale();
  const { en, zh } = tPair(k, vars, locale);
  const activeText = locale === "zh" ? zh : en;
  const reserveText = locale === "zh" ? en : zh;
  const activeLang = locale === "zh" ? "zh-CN" : "en";
  const reserveLang = locale === "zh" ? "en" : "zh-CN";
  const alignCls =
    align === "center"
      ? "justify-items-center text-center"
      : align === "end"
        ? "justify-items-end text-right"
        : "justify-items-start text-left";
  return (
    <span className={cx(block ? "grid" : "inline-grid", "items-baseline", alignCls, className)}>
      <span
        lang={reserveLang}
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 select-none invisible"
      >
        {reserveText}
      </span>
      <span lang={activeLang} className="col-start-1 row-start-1">
        {activeText}
      </span>
    </span>
  );
}

export function Button({
  tone = "primary",
  className,
  busy,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "secondary" | "yes" | "no";
  busy?: boolean;
}) {
  const tones: Record<string, string> = {
    primary: "btn-primary font-semibold",
    secondary: "btn-ghost font-medium",
    yes: "font-medium border border-[var(--yes-line)] bg-[var(--yes-soft)] text-[var(--yes)] hover:brightness-110",
    no: "font-medium border border-[var(--no-line)] bg-[var(--no-soft)] text-[var(--no)] hover:brightness-110",
  };
  return (
    <button
      data-tone={tone}
      className={cx(
        "relative inline-flex h-10 items-center justify-center whitespace-nowrap px-4 text-sm transition-opacity duration-150 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
        tones[tone],
        className
      )}
      {...props}
    >
      <span className={cx("inline-flex items-center justify-center gap-1.5", busy ? "opacity-0" : "opacity-100")}>
        {children}
      </span>
      {busy ? (
        <span className="absolute h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-75" />
      ) : null}
    </button>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div onMouseMove={onSpot} className={cx("surface p-5", className)}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="block space-y-2">
      <span className="block text-[13px] font-medium leading-tight text-zinc-400">{label}</span>
      {children}
      {error ? (
        <span className="block text-[13px] leading-5 text-rose-400">{error}</span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function choiceClass(on: boolean): string {
  return cx("choice", on && "choice-on");
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        "field h-11 w-full border border-zinc-700 px-3 text-sm text-white outline-none placeholder:text-zinc-600 transition-colors duration-200",
        props.className
      )}
    />
  );
}

export function Chip({
  children,
  tone = "mute",
  className,
}: {
  children: ReactNode;
  tone?: "mute" | "yes" | "no" | "accent" | "ink";
  className?: string;
}) {
  const tones: Record<string, string> = {
    mute: "border-[var(--hair)] text-[var(--ink-2)]",
    yes: "border-[var(--yes-line)] bg-[var(--yes-soft)] text-[var(--yes)]",
    no: "border-[var(--no-line)] bg-[var(--no-soft)] text-[var(--no)]",
    accent: "border-[var(--line)] bg-[var(--seg-bg)] text-[var(--ink)]",
    ink: "border-[var(--warn-line)] bg-[var(--warn-soft)] text-[var(--warn)]",
  };
  return (
    <span
      className={cx(
        "chip-x inline-flex items-center gap-1.5 whitespace-nowrap border px-2.5 py-0.5 text-[11px] font-medium",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function CopyText({ value, label }: { value: string; label?: string }) {
  const { push } = useToasts();
  const t = useT();
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        push("info", t("common.copied"), label ?? value);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      <span>{label ?? shorten(value, 4, 4)}</span>
      {copied ? (
        <Check className="h-3 w-3 text-[var(--yes)]" aria-hidden />
      ) : (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="opacity-55"
          aria-hidden
        >
          <rect x="9" y="9" width="12" height="12" />
          <path d="M5 15V5h10" />
        </svg>
      )}
    </button>
  );
}

export function StatusChip({ market, now }: { market: MarketView; now?: number }) {
  const ts = now && now > 0 ? now : 0;
  const kind = marketKind(market, ts);
  const labelKey = kindLabelKey(kind, market);
  return (
    <Chip tone={kindTone(kind, market)} className="min-w-[8.75rem] justify-center">
      {kind === "live" ? <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--yes)]" /> : null}
      <StableText k={labelKey} align="center" />
    </Chip>
  );
}

export function Kv({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-zinc-500">{k}</span>
      <span className="num text-right font-medium text-white">{v}</span>
    </div>
  );
}

export function PopNum({ text }: { text: string }) {
  return (
    <span key={text} className="pop-num inline-block">
      {text}
    </span>
  );
}

export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setShown(true);
      return;
    }
    const show = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setShown(true);
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0 }
    );
    const rearm = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry.isIntersecting && entry.boundingClientRect.top > 0) setShown(false);
      },
      { threshold: 0 }
    );
    show.observe(el);
    rearm.observe(el);
    return () => {
      show.disconnect();
      rearm.disconnect();
    };
  }, []);
  return (
    <div ref={ref} className={cx("reveal", shown && "reveal-in", className)}>
      {children}
    </div>
  );
}

export function SegTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode; color?: string; activeText?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const active = options[index];
  return (
    <div
      className="seg-tabs relative grid p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="seg-thumb absolute inset-y-1 transition-transform duration-200"
        style={{
          left: "0.25rem",
          width: `calc((100% - 0.5rem) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
          background: active?.color ?? "var(--seg-thumb)",
          border: "1px solid var(--card-line)",
          transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "relative z-10 flex h-9 items-center justify-center px-2 text-sm font-medium transition-colors duration-150",
            o.value === value
              ? o.activeText ?? "text-[var(--ink-strong)]"
              : "text-[var(--ink-2)] hover:text-[var(--ink-strong)]"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function DataFreshness({
  updatedAt,
  refreshing,
  staleError,
  onRefresh,
  className,
}: {
  updatedAt: number | null;
  refreshing?: boolean;
  staleError?: boolean;
  onRefresh?: () => void;
  className?: string;
}) {
  useLocale();
  if (!updatedAt && !refreshing) return null;
  const stamp = updatedAt
    ? (() => {
        const d = new Date(updatedAt);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      })()
    : "";

  return (
    <div className={cx("flex flex-wrap items-center gap-3 text-xs text-zinc-500", className)}>
      {staleError && updatedAt ? (
        <span className="inline-flex items-center gap-1.5 text-[var(--warn)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />
          <StableText k="freshness.staleWarning" vars={{ time: stamp }} />
        </span>
      ) : updatedAt ? (
        <span className="num inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--yes)] opacity-80" />
          <StableText k="freshness.asOf" vars={{ time: stamp }} />
        </span>
      ) : null}
      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 border border-[var(--hair)] px-2 py-0.5 text-[11px] text-zinc-400 transition-colors hover:border-[var(--line)] hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={cx("h-3 w-3", refreshing && "animate-spin")} aria-hidden />
          <StableText k={refreshing ? "freshness.syncing" : "freshness.refresh"} align="center" />
        </button>
      ) : null}
    </div>
  );
}

export function StateBlock({
  kind,
  title,
  body,
  action,
}: {
  kind: "loading" | "empty" | "wallet" | "error" | "pending";
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="surface flex min-h-40 flex-col items-start justify-center gap-3 px-6 py-6">
      <div className="text-base font-medium text-white">{title}</div>
      {body ? <p className="max-w-xl text-sm leading-relaxed text-zinc-400">{body}</p> : null}
      {kind === "loading" || kind === "pending" ? <div className="sk h-2 w-40" /> : null}
      {action}
    </div>
  );
}

export function useTx() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { push } = useToasts();
  const { bump } = useRefresh();
  const { settings } = useSettings();
  const t = useT();
  const [busy, setBusy] = useState(false);

  const run = async (
    label: string,
    build: () => Promise<import("@solana/web3.js").TransactionInstruction[]>
  ): Promise<string | null> => {
    setBusy(true);
    try {
      const w = mustWallet(wallet);
      const ixs = await build();
      const sig = await sendIxs(connection, w, ixs);
      const link = explorerTx(sig, settings.cluster);
      push("ok", label, link ? t("tx.view") : t("tx.confirmed"), link ?? undefined);
      bump();
      return sig;
    } catch (err) {
      push("err", t("tx.failed", { label }), parseTxError(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  return { busy, run };
}

let walletModalOpen = false;
const walletModalListeners = new Set<() => void>();
function setWalletModalOpen(next: boolean) {
  walletModalOpen = next;
  walletModalListeners.forEach((fn) => fn());
}

function useWalletModalState(): [boolean, (next: boolean) => void] {
  const [isOpen, setIsOpen] = useState(walletModalOpen);
  useEffect(() => {
    setIsOpen(walletModalOpen);
    const sync = () => setIsOpen(walletModalOpen);
    walletModalListeners.add(sync);
    return () => {
      walletModalListeners.delete(sync);
    };
  }, []);
  return [isOpen, setWalletModalOpen];
}

export function WalletButton() {
  const { publicKey, connected, connecting, wallet, select, disconnect } = useWallet();
  if (!connected || !publicKey) {
    return (
      <Button
        type="button"
        onClick={() => {
          if (wallet && !connected && !connecting) {
            select(null);
          }
          setWalletModalOpen(true);
        }}
        className="h-8 shrink-0 px-3 text-xs sm:h-9 sm:px-4"
      >
        <StableText k="wallet.connect" align="center" />
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <CopyText value={publicKey.toBase58()} label={shorten(publicKey.toBase58(), 4, 4)} />
      <Button
        type="button"
        tone="secondary"
        className="h-8 shrink-0 px-3 text-xs sm:h-9 sm:px-4"
        onClick={() => disconnect()}
      >
        <StableText k="wallet.disconnect" align="center" />
      </Button>
    </div>
  );
}

export function WalletConnectModal() {
  const [isOpen, setOpen] = useWalletModalState();
  const { wallets, select } = useWallet();

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, setOpen]);

  if (!isOpen || typeof document === "undefined") return null;

  const installed = wallets.filter(
    (w) => w.readyState === "Installed" || w.readyState === "Loadable"
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-md"
      onClick={() => setOpen(false)}
    >
      <div
        className="surface panel-float w-full max-w-md border border-[var(--line)] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-white">
            <StableText k="wallet.modalTitle" />
          </h2>
          <button
            type="button"
            className="text-xs text-zinc-400 transition-colors hover:text-white"
            onClick={() => setOpen(false)}
          >
            <StableText k="common.close" />
          </button>
        </div>

        {installed.length > 0 ? (
          <div className="stack-3">
            <p className="text-xs text-zinc-400">
              <StableText k="wallet.detected" block />
            </p>
            <div className="stack-2">
              {installed.map((w) => (
                <button
                  key={w.adapter.name}
                  type="button"
                  onClick={() => {
                    select(w.adapter.name);
                    setOpen(false);
                  }}
                  className="flex h-11 w-full items-center justify-between border border-[var(--card-line)] bg-[var(--seg-bg)] px-4 text-sm font-medium text-white transition-colors hover:border-[var(--line)] hover:bg-[var(--seg-thumb)]"
                >
                  <span className="flex items-center gap-3">
                    {w.adapter.icon ? (
                      <img src={w.adapter.icon} alt="" className="h-5 w-5 shrink-0" />
                    ) : null}
                    <span>{w.adapter.name}</span>
                  </span>
                  <span className="text-xs text-zinc-400">
                    <StableText k="common.connect" align="end" />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="stack-3 border border-[var(--hair)] bg-[var(--seg-bg)] p-4">
            <div className="text-sm font-medium text-white">
              <StableText k="wallet.noWalletTitle" block />
            </div>
            <p className="text-xs leading-relaxed text-zinc-400">
              <StableText k="wallet.noWalletBody" block />
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <a
                href="https://phantom.app/download"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center justify-center gap-1.5 border border-[var(--line)] bg-[var(--card-bg)] px-3 text-xs font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:text-white"
              >
                <StableText k="wallet.installPhantom" align="center" />
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <a
                href="https://solflare.com/download"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center justify-center gap-1.5 border border-[var(--line)] bg-[var(--card-bg)] px-3 text-xs font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:text-white"
              >
                <StableText k="wallet.installSolflare" align="center" />
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        )}

        <div className="mt-4 border-t border-[var(--hair)] pt-3">
          <Link
            href="/markets"
            onClick={() => setOpen(false)}
            className="link-accent inline-flex items-center text-xs"
          >
            <StableText k="wallet.browseReadOnly" />
          </Link>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    const root = document.documentElement;
    root.dataset.theme = next;
    root.style.colorScheme = next;
    void root.offsetHeight;
    try {
      localStorage.setItem("veritas-theme", next);
    } catch {
      /* storage unavailable */
    }
    setTheme(next);
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t("nav.theme")}
      title={t("nav.theme")}
      className="grid h-8 w-8 shrink-0 place-items-center border border-[var(--hair)] bg-[var(--seg-bg)] text-[var(--ink-2)] hover:border-[var(--line)] hover:text-[var(--ink-strong)]"
    >
      {theme === "light" ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )}
    </button>
  );
}

export function LangSwitch() {
  const { locale, setLocale, t } = useI18n();
  const btnCls = (on: boolean) =>
    cx(
      "flex h-full min-w-[2.5rem] items-center justify-center px-2 text-[11px] font-medium leading-none",
      on ? "bg-[var(--accent)] text-[var(--on-accent)]" : "text-[var(--ink-2)] hover:text-[var(--ink-strong)]"
    );
  return (
    <div
      className="inline-grid h-8 shrink-0 grid-cols-2 items-stretch overflow-hidden border border-[var(--hair)] bg-[var(--seg-bg)]"
      role="group"
      aria-label={t("nav.language")}
    >
      <button type="button" onClick={() => setLocale("en")} className={btnCls(locale === "en")}>
        EN
      </button>
      <button type="button" onClick={() => setLocale("zh")} className={btnCls(locale === "zh")}>
        中文
      </button>
    </div>
  );
}

function HeaderTape() {
  const { quotes } = useFeeds();
  const items = FEEDS.filter((f) => f.key === "btc" || f.key === "sol");
  return (
    <div className="pointer-events-none hidden items-center gap-5 xl:flex">
      {items.map((f) => (
        <span key={f.key} className="flex items-baseline gap-1.5 text-[12px]">
          <span className="font-medium text-zinc-500">{f.symbol}</span>
          <span className="num text-zinc-200">{formatFeedPrice(quotes[f.key]?.price ?? null)}</span>
          <PriceAge publishTime={quotes[f.key]?.publishTime ?? null} className="min-w-[4.5rem] text-left text-[10px] text-zinc-500" />
        </span>
      ))}
    </div>
  );
}

function clusterKey(cluster: string): "cluster.mainnet" | "cluster.local" | "cluster.devnet" | "cluster.testnet" {
  if (cluster === "mainnet-beta") return "cluster.mainnet";
  if (cluster === "localnet") return "cluster.local";
  if (cluster === "testnet") return "cluster.testnet";
  return "cluster.devnet";
}

let faucetMenuOpen = false;
const faucetMenuListeners = new Set<() => void>();
function setFaucetMenuOpen(next: boolean | ((prev: boolean) => boolean)) {
  faucetMenuOpen = typeof next === "function" ? next(faucetMenuOpen) : next;
  faucetMenuListeners.forEach((fn) => fn());
}

export function openFaucetMenu() {
  setFaucetMenuOpen(true);
}

export function HeaderFaucet() {
  const { publicKey } = useWallet();
  const { bump } = useRefresh();
  const [open, setOpen] = useState(faucetMenuOpen);
  const [state, setState] = useState<"idle" | "busy" | "done" | "cooldown" | "unavailable">("idle");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(faucetMenuOpen);
    const sync = () => setOpen(faucetMenuOpen);
    faucetMenuListeners.add(sync);
    return () => {
      faucetMenuListeners.delete(sync);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setFaucetMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFaucetMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const claim = async () => {
    if (!publicKey) return;
    setState("busy");
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: publicKey.toBase58() }),
      });
      if (res.ok) {
        setState("done");
        bump();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setState(data.error === "cooldown" ? "cooldown" : "unavailable");
      }
    } catch {
      setState("unavailable");
    }
  };

  const labelKey =
    state === "done"
      ? "help.q2Claimed"
      : state === "cooldown"
        ? "help.q2Cooldown"
        : state === "unavailable"
          ? "help.q2Unavailable"
          : "help.q2Claim";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setFaucetMenuOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 border border-[var(--hair)] bg-[var(--seg-bg)] px-2.5 text-xs text-[var(--ink)] hover:border-[var(--line)] hover:text-[var(--ink-strong)]"
      >
        <Droplets className="h-3.5 w-3.5 text-[var(--ink-2)]" />
        <StableText k="nav.faucet" align="center" />
      </button>
      {open ? (
        <div className="faucet-pop absolute right-0 top-full z-50 mt-2 w-72 border border-[var(--line)] bg-zinc-950 p-4 shadow-2xl sm:w-80">
          <div className="stack-3">
            <div className="stack-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">
                  <StableText k="nav.faucetTitle" />
                </span>
                <button
                  type="button"
                  onClick={() => setFaucetMenuOpen(false)}
                  className="text-xs text-zinc-400 transition-colors hover:text-white"
                >
                  <StableText k="common.close" />
                </button>
              </div>
              <p className="text-xs text-zinc-400">
                <StableText k="nav.faucetSub" block />
              </p>
            </div>

            <div className="stack-2 border border-[var(--hair)] bg-[var(--seg-bg)] p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-white">
                  <StableText k="nav.faucetUsdtTitle" />
                </span>
                <span className="num shrink-0 text-[11px] text-zinc-400">100 / 24h</span>
              </div>
              <p className="text-xs leading-relaxed text-zinc-400">
                <StableText k="nav.faucetUsdtDesc" block />
              </p>
              {publicKey ? (
                <Button
                  type="button"
                  tone="primary"
                  className="h-8 w-full px-3 text-xs"
                  busy={state === "busy"}
                  disabled={state === "busy" || state === "done"}
                  onClick={() => void claim()}
                >
                  <StableText k={labelKey} align="center" />
                </Button>
              ) : (
                <Button
                  type="button"
                  tone="secondary"
                  className="h-8 w-full px-3 text-xs"
                  onClick={() => {
                    setFaucetMenuOpen(false);
                    setWalletModalOpen(true);
                  }}
                >
                  <StableText k="wallet.connect" align="center" />
                </Button>
              )}
            </div>

            <div className="stack-2 border border-[var(--hair)] bg-[var(--seg-bg)] p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-white">
                  <StableText k="nav.faucetSolTitle" />
                </span>
                <span className="shrink-0 text-[11px] text-zinc-400">Gas</span>
              </div>
              <p className="text-xs leading-relaxed text-zinc-400">
                <StableText k="nav.faucetSolDesc" block />
              </p>
              <a
                href="https://faucet.solana.com"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 w-full items-center justify-center gap-1.5 border border-[var(--line)] bg-[var(--card-bg)] px-3 text-xs font-medium text-[var(--ink)] hover:border-zinc-500 hover:text-[var(--ink-strong)]"
              >
                <StableText k="help.q2Sol" align="center" />
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Header() {
  const pathname = usePathname();
  const { settings } = useSettings();
  const t = useT();
  const [open, setOpen] = useState(false);
  const { connection } = useConnection();
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!window.location.hash) {
      window.scrollTo(0, 0);
    }
  }, [pathname]);

  useEffect(() => {
    let alive = true;
    connection
      .getEpochInfo()
      .then(() => alive && setOk(true))
      .catch(() => alive && setOk(false));
    return () => {
      alive = false;
    };
  }, [connection, settings.rpcUrl]);

  useEffect(() => {
    const root = document.documentElement;
    if (pathname !== "/") {
      delete root.dataset.brand;
      return;
    }
    const update = () => {
      const el = document.getElementById("masthead");
      if (!el) return;
      if (el.getBoundingClientRect().bottom > 56) root.dataset.brand = "hidden";
      else delete root.dataset.brand;
    };
    update();
    const raf = requestAnimationFrame(update);
    const timers = [window.setTimeout(update, 250), window.setTimeout(update, 1000)];
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach((id) => window.clearTimeout(id));
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      delete root.dataset.brand;
    };
  }, [pathname]);

  const nav = [
    { href: "/markets", key: "nav.markets" as const },
    { href: "/create", key: "nav.create" as const },
    { href: "/me", key: "nav.me" as const },
    { href: "/help", key: "nav.help" as const },
  ];

  return (
    <header className="app-header nav-in sticky top-0 z-40">
      <div className="page-width relative mx-auto flex min-h-14 min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2 sm:h-14 sm:flex-nowrap sm:px-4 sm:py-0">
        <div className="flex min-w-0 items-center gap-3 md:gap-6">
          <Link href="/" className="header-brand flex items-center gap-2.5 text-[var(--ink-strong)]">
            <PulseAreaMark size={26} />
            <span className="brand-word font-display hidden text-lg font-semibold sm:inline">
              {t("brand.name")}
            </span>
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {nav.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(
                    "whitespace-nowrap px-3 py-1.5 text-sm",
                    active
                      ? "border border-[var(--card-line)] bg-[var(--seg-thumb)] font-medium text-[var(--ink-strong)]"
                      : "border border-transparent text-[var(--ink-2)] hover:text-[var(--ink-strong)]"
                  )}
                >
                  <StableText k={item.key} align="center" />
                </Link>
              );
            })}
          </nav>
        </div>

        <HeaderTape />

        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5 sm:flex-none sm:gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="hidden h-8 items-center gap-2 border border-[var(--hair)] bg-[var(--seg-bg)] px-2.5 text-xs text-[var(--ink)] hover:border-[var(--line)] hover:text-[var(--ink-strong)] md:inline-flex"
          >
            <span
              className={cx(
                "h-1.5 w-1.5 rounded-full",
                ok ? "live-dot bg-[var(--yes)]" : ok === false ? "bg-[var(--no)]" : "bg-zinc-500"
              )}
            />
            <StableText k={clusterKey(settings.cluster)} align="center" />
          </button>
          <Button
            type="button"
            tone="secondary"
            className="h-8 whitespace-nowrap px-2.5 text-[11px] md:hidden"
            onClick={() => setOpen(true)}
          >
            <StableText k="nav.settings" align="center" />
          </Button>
          <ThemeToggle />
          <LangSwitch />
          <HeaderFaucet />
          <WalletButton />
        </div>
      </div>
      <nav className="page-width mx-auto flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
        {nav.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cx(
                "whitespace-nowrap px-3 py-1 text-xs",
                active
                  ? "bg-[var(--accent)] font-medium text-[var(--on-accent)]"
                  : "text-zinc-400"
              )}
            >
              <StableText k={item.key} align="center" />
            </Link>
          );
        })}
      </nav>
      {open ? <SettingsModal onClose={() => setOpen(false)} /> : null}
      <WalletConnectModal />
    </header>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, setSettings } = useSettings();
  const { bump } = useRefresh();
  const { push } = useToasts();
  const t = useT();
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    try {
      new PublicKey(draft.programId);
      new PublicKey(draft.collateralMint);
    } catch {
      push("err", t("settings.invalidTitle"), t("settings.invalidBody"));
      return;
    }
    setSettings(draft);
    bump();
    onClose();
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="surface panel-float w-full max-w-lg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="page-title">{t("settings.title")}</h2>
          <button
            type="button"
            className="text-sm text-zinc-400 transition-colors hover:text-white"
            onClick={onClose}
          >
            {t("common.close")}
          </button>
        </div>
        <p className="mb-5 text-sm text-zinc-400">{t("settings.hint")}</p>
        <div className="stack-4">
          <Field label={t("settings.rpc")}>
            <TextInput
              value={draft.rpcUrl}
              onChange={(e) => setDraft({ ...draft, rpcUrl: e.target.value })}
            />
          </Field>
          <Field label={t("settings.network")}>
            <select
              className="field h-11 w-full border border-zinc-700 px-3 text-sm text-white outline-none"
              value={draft.cluster}
              onChange={(e) => setDraft({ ...draft, cluster: e.target.value as ClusterName })}
            >
              <option value="localnet">{t("cluster.local")}</option>
              <option value="devnet">{t("cluster.devnet")}</option>
              <option value="testnet">{t("cluster.testnet")}</option>
              <option value="mainnet-beta">{t("cluster.mainnet")}</option>
            </select>
          </Field>
          <Field label={t("settings.programId")}>
            <TextInput
              value={draft.programId}
              onChange={(e) => setDraft({ ...draft, programId: e.target.value })}
            />
          </Field>
          <Field label={t("settings.settlementToken")} hint={t("settings.settlementHint")}>
            <TextInput
              value={draft.collateralMint}
              onChange={(e) => setDraft({ ...draft, collateralMint: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-6 flex justify-between gap-3">
          <Button
            type="button"
            tone="secondary"
            onClick={() =>
              setDraft({
                rpcUrl: DEFAULT_RPC,
                cluster: DEFAULT_CLUSTER as ClusterName,
                programId: DEFAULT_PROGRAM_ID,
                collateralMint: DEFAULT_COLLATERAL_MINT,
              })
            }
          >
            {t("common.reset")}
          </Button>
          <Button type="button" onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function Footer() {
  const pathname = usePathname();
  const { settings } = useSettings();
  const programHref = explorerAccount(settings.programId, settings.cluster);
  if (pathname === "/") return null;
  return (
    <footer className="page-width relative z-10 mx-auto border-t border-[var(--hair)] px-4 pb-8 pt-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-zinc-500">
        {programHref ? (
          <a href={programHref} target="_blank" rel="noreferrer" className="link-accent font-mono">
            <StableText k="footer.program" /> {shorten(settings.programId, 4, 4)}
          </a>
        ) : (
          <span className="font-mono">
            <StableText k="footer.program" /> {shorten(settings.programId, 4, 4)}
          </span>
        )}
        <a href={GITHUB_REPO} target="_blank" rel="noreferrer" className="link-accent">
          <StableText k="footer.github" />
        </a>
        <StableText k="footer.disclaimer" />
      </div>
    </footer>
  );
}
