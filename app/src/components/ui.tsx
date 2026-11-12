"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  DEFAULT_CLUSTER,
  DEFAULT_COLLATERAL_MINT,
  DEFAULT_PROGRAM_ID,
  DEFAULT_RPC,
  GITHUB_REPO,
} from "@/lib/constants";
import { clusterLabel, kindLabel, kindTone, marketKind } from "@/lib/display";
import { explorerAccount, explorerTx, formatYesNo, shorten } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { sendIxs, mustWallet } from "@/lib/send";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import type { ClusterName } from "@/lib/types";
import { useI18n, useT } from "@/i18n/provider";
import { useFeeds } from "@/hooks/use-feeds";
import { PulseAreaMark } from "./logo-marks";
import { FEEDS, formatPythPrice } from "@/lib/feeds";
import { useRefresh, useSettings, useToasts } from "./providers";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function onSpot(e: MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--sx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--sy", `${e.clientY - r.top}px`);
}

export function Button({
  tone = "primary",
  className,
  busy,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "secondary" | "yes" | "no"; busy?: boolean }) {
  const tones: Record<string, string> = {
    primary:
      "shine font-semibold bg-gradient-to-b from-cyan-400 to-cyan-500 text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_0_20px_rgba(34,211,238,0.3),0_4px_14px_0_rgba(34,211,238,0.39)] hover:from-cyan-300 hover:to-cyan-400 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_0_26px_rgba(34,211,238,0.42),0_4px_18px_0_rgba(34,211,238,0.5)]",
    secondary:
      "btn-ghost font-medium bg-transparent text-zinc-200 border border-white/10 hover:border-white/25 hover:bg-white/[0.06]",
    yes:
      "shine font-medium bg-gradient-to-b from-emerald-400/25 to-emerald-500/10 text-emerald-300 border border-emerald-500/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_4px_14px_0_rgba(52,211,153,0.22)] hover:from-emerald-400/35 hover:to-emerald-500/15 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_4px_16px_0_rgba(52,211,153,0.32)]",
    no: "shine font-medium bg-gradient-to-b from-rose-400/25 to-rose-500/10 text-rose-300 border border-rose-500/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_4px_14px_0_rgba(251,113,133,0.22)] hover:from-rose-400/35 hover:to-rose-500/15 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_4px_16px_0_rgba(251,113,133,0.32)]",
  };
  return (
    <button
      data-tone={tone}
      className={cx(
        "relative inline-flex h-10 items-center justify-center rounded-2xl px-4 text-sm transition-all duration-150 hover:brightness-110 active:brightness-95 enabled:hover:scale-[1.02] enabled:active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100",
        tones[tone],
        className
      )}
      {...props}
    >
      <span className={busy ? "opacity-0" : "opacity-100"}>{children}</span>
      {busy ? (
        <span className="absolute h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70" />
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
    <div onMouseMove={onSpot} className={cx("surface p-4 backdrop-blur-md", className)}>
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
  label: string;
  hint?: string;
  error?: string;
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
        "field h-11 w-full rounded-xl border border-zinc-800 px-3 text-sm text-white outline-none placeholder:text-zinc-600 transition-all duration-300",
        props.className
      )}
    />
  );
}

export function Chip({
  children,
  tone = "mute",
}: {
  children: ReactNode;
  tone?: "mute" | "yes" | "no" | "accent" | "ink";
}) {
  const tones: Record<string, string> = {
    mute: "border-zinc-800 text-zinc-400",
    yes: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    no: "border-rose-500/30 bg-rose-500/10 text-rose-400",
    accent: "border-cyan-500/30 bg-cyan-500/10 text-cyan-400",
    ink: "border-zinc-700 text-zinc-200",
  };
  return (
    <span className={cx("chip-x inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium", tones[tone])}>
      {children}
    </span>
  );
}

export function CopyText({ value, label }: { value: string; label?: string }) {
  const { push } = useToasts();
  const t = useT();
  return (
    <button
      type="button"
      className="rounded-md px-1.5 py-0.5 font-mono text-xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        push("info", t("common.copied"), label ?? value);
      }}
    >
      {label ?? shorten(value, 4, 4)}
    </button>
  );
}

export function StatusChip({ market, now }: { market: MarketView; now?: number }) {
  const ts = now ?? Math.floor(Date.now() / 1000);
  const kind = marketKind(market, ts);
  return (
    <Chip tone={kindTone(kind, market)}>
      {kind === "live" ? <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" /> : null}
      {kindLabel(kind, market)}
    </Chip>
  );
}

export function OddsLine({ yes }: { yes: number }) {
  return <span className="num whitespace-nowrap text-sm text-zinc-200">{formatYesNo(yes)}</span>;
}

export function StatBox({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-zinc-950/50 px-4 py-3">
      <div className="kicker text-[11px] text-zinc-500">{label}</div>
      <div className="num mt-2 text-right font-medium text-white">{value}</div>
      {hint ? <div className="mt-1 text-right text-xs text-zinc-500">{hint}</div> : null}
    </div>
  );
}

export function Kv({ k, v }: { k: string; v: ReactNode }) {
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

export function Reveal({ children }: { children: ReactNode }) {
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
      { rootMargin: "0px 0px -20% 0px", threshold: 0 }
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
    <div ref={ref} className={cx("reveal", shown && "reveal-in")}>
      {children}
    </div>
  );
}

export function StickyRail({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(false);
  const [soft, setSoft] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const desktop = window.matchMedia("(min-width: 1024px)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!desktop || reduced) {
      let raf = 0;
      const check = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => setStuck(el.getBoundingClientRect().top <= 81));
      };
      check();
      window.addEventListener("scroll", check, { passive: true });
      return () => {
        window.removeEventListener("scroll", check);
        cancelAnimationFrame(raf);
      };
    }
    setSoft(true);
    let shift = 0;
    let dirty = true;
    const measureUntil = performance.now() + 2500;
    let naturalTop = 0;
    let maxShift = 0;
    let raf = 0;
    const measure = () => {
      const parent = el.parentElement;
      if (!parent) return;
      naturalTop = el.getBoundingClientRect().top + window.scrollY - shift;
      maxShift = Math.max(
        0,
        parent.getBoundingClientRect().bottom + window.scrollY - el.offsetHeight - naturalTop
      );
      dirty = false;
    };
    const loop = () => {
      if (dirty || performance.now() < measureUntil) measure();
      const target = Math.min(Math.max(window.scrollY + 80 - naturalTop, 0), maxShift);
      const diff = target - shift;
      if (Math.abs(diff) > 0.05) {
        shift += diff * 0.16;
        el.style.transform = `translate3d(0, ${shift.toFixed(2)}px, 0)`;
        setStuck(shift > 4);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const mark = () => {
      dirty = true;
    };
    window.addEventListener("resize", mark);
    window.addEventListener("load", mark);
    const ro = new ResizeObserver(mark);
    if (el.parentElement) ro.observe(el.parentElement);
    ro.observe(el);
    if (document.body) ro.observe(document.body);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", mark);
      window.removeEventListener("load", mark);
      ro.disconnect();
      el.style.transform = "";
    };
  }, []);
  return (
    <aside ref={ref} className={cx(className, soft && "soft-rail-on", stuck && "rail-stuck")}>
      {children}
    </aside>
  );
}

export function SegTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode; color: string; activeText?: string }[];
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
      className="seg-tabs relative grid rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="seg-thumb absolute inset-y-1 rounded-lg transition-all duration-300"
        style={{
          left: "0.25rem",
          width: `calc((100% - 0.5rem) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
          background: active?.color,
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
          transitionTimingFunction: "cubic-bezier(0.34, 1.3, 0.64, 1)",
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`relative z-10 h-9 rounded-lg text-sm font-medium transition-all duration-150 active:scale-95 ${
            o.value === value
              ? (o.activeText ?? "text-white")
              : "bg-white/[0.05] text-zinc-400 hover:bg-white/[0.09] hover:text-zinc-200"
          }`}
        >
          {o.label}
        </button>
      ))}
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
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="surface flex min-h-40 flex-col items-start justify-center gap-3 px-5 py-6">
      <div className="text-base font-medium text-white">{title}</div>
      {body ? <p className="max-w-xl text-sm leading-relaxed text-zinc-500">{body}</p> : null}
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

export function WalletButton() {
  const { publicKey, connected, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const t = useT();
  if (!connected || !publicKey) {
    return (
      <Button type="button" onClick={() => setVisible(true)} className="h-8 shrink-0 whitespace-nowrap px-2 text-[11px] sm:h-10 sm:px-4 sm:text-sm">
        {t("wallet.connect")}
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <CopyText value={publicKey.toBase58()} label={shorten(publicKey.toBase58(), 4, 4)} />
      <Button type="button" tone="secondary" className="h-8 shrink-0 whitespace-nowrap px-2 text-[11px] sm:h-10 sm:px-4 sm:text-sm" onClick={() => disconnect()}>
        {t("wallet.disconnect")}
      </Button>
    </div>
  );
}

function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
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
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-zinc-800 bg-zinc-950/80 text-zinc-400 transition-colors hover:text-white"
    >
      {theme === "light" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )}
    </button>
  );
}

function LangSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      className="inline-flex h-8 shrink-0 items-center rounded-full border border-zinc-800 bg-zinc-950/80 p-0.5"
      role="group"
      aria-label={t("nav.language")}
    >
      <button
        type="button"
        onClick={() => setLocale("en")}
        className={cx(
          "rounded-full px-2 py-1 text-[11px] font-medium leading-none transition-colors",
          locale === "en" ? "bg-accent text-zinc-950" : "text-zinc-400 hover:text-white"
        )}
      >
        {t("nav.en")}
      </button>
      <button
        type="button"
        onClick={() => setLocale("zh")}
        className={cx(
          "rounded-full px-2 py-1 text-[11px] font-medium leading-none transition-colors",
          locale === "zh" ? "bg-accent text-zinc-950" : "text-zinc-400 hover:text-white"
        )}
      >
        {t("nav.zh")}
      </button>
    </div>
  );
}

function HeaderTape() {
  const { quotes } = useFeeds();
  const items = FEEDS.filter((f) => f.key === "btc" || f.key === "sol");
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-5 xl:flex">
      {items.map((f) => (
        <span key={f.key} className="flex items-baseline gap-1.5 text-[13px]">
          <span className="font-medium text-zinc-500">{f.symbol}</span>
          <span className="num text-zinc-200">{formatPythPrice(quotes[f.key]?.price ?? null)}</span>
        </span>
      ))}
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
    const el = document.getElementById("masthead");
    if (!el) {
      delete root.dataset.brand;
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) root.dataset.brand = "hidden";
        else delete root.dataset.brand;
      },
      { rootMargin: "-56px 0px 0px 0px" }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      delete root.dataset.brand;
    };
  }, [pathname]);

  const nav = [
    { href: "/markets", label: t("nav.markets") },
    { href: "/create", label: t("nav.create") },
    { href: "/me", label: t("nav.me") },
    { href: "/help", label: t("nav.help") },
  ];

  return (
    <header className="app-header header-line nav-in sticky top-0 z-40 border-b border-cyan-500/10 backdrop-blur-xl">
      <div className="page-width relative mx-auto flex min-h-14 min-w-0 flex-wrap items-start justify-between gap-2 px-3 py-2 sm:h-14 sm:flex-nowrap sm:items-center sm:px-4 sm:py-0">
        <div className="flex min-w-0 items-center gap-2 md:gap-5">
          <Link href="/" className="header-brand flex items-center gap-2.5">
<PulseAreaMark size={30} />
            <span className="brand-word hidden text-base font-bold text-white sm:inline">{t("brand.name")}</span>
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {nav.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(
                    "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors",
                    active ? "bg-accent/15 text-accent" : "text-zinc-400 hover:text-white"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <HeaderTape />
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1 sm:flex-none sm:gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cx(
              "hidden items-center gap-2 rounded-full px-3 py-1 text-xs md:flex",
              ok
                ? "border border-emerald-800/50 bg-emerald-950/40 text-emerald-400"
                : ok === false
                  ? "border border-rose-800/50 bg-rose-950/40 text-rose-400"
                  : "border border-zinc-700 bg-zinc-900 text-zinc-400"
            )}
          >
            <span
              className={cx(
                "h-1.5 w-1.5 rounded-full",
                ok ? "live-dot bg-accent" : ok === false ? "bg-rose-400" : "bg-zinc-500"
              )}
            />
            {clusterLabel(settings.cluster)}
          </button>
          <Button type="button" tone="secondary" className="h-8 whitespace-nowrap px-2 text-[11px] md:hidden" onClick={() => setOpen(true)}>
            {t("nav.settings")}
          </Button>
          <ThemeToggle />
          <LangSwitch />
          <WalletButton />
        </div>
      </div>
      <nav className="page-width mx-auto flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
        {nav.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cx(
                "whitespace-nowrap rounded-full px-3 py-1 text-[11px]",
                active ? "bg-accent text-zinc-950" : "text-zinc-400"
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      {open ? <SettingsModal onClose={() => setOpen(false)} /> : null}
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

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div className="surface w-full max-w-lg p-6 shadow-glow" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="page-title">{t("settings.title")}</h2>
          <button type="button" className="text-zinc-400 hover:text-white" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
        <p className="mb-5 text-sm text-zinc-400">{t("settings.hint")}</p>
        <div className="stack-4">
          <Field label={t("settings.rpc")}>
            <TextInput value={draft.rpcUrl} onChange={(e) => setDraft({ ...draft, rpcUrl: e.target.value })} />
          </Field>
          <Field label={t("settings.network")}>
            <select
              className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm text-white"
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
            <TextInput value={draft.programId} onChange={(e) => setDraft({ ...draft, programId: e.target.value })} />
          </Field>
          <Field label={t("settings.settlementToken")} hint={t("settings.settlementHint")}>
            <TextInput value={draft.collateralMint} onChange={(e) => setDraft({ ...draft, collateralMint: e.target.value })} />
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
    </div>
  );
}



export function Footer() {
  const t = useT();
  const pathname = usePathname();
  const { settings } = useSettings();
  const programHref = explorerAccount(settings.programId, settings.cluster);
  if (pathname === "/") return null;
  return (
    <footer className="page-width relative z-10 mx-auto px-4 pb-8 pt-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-zinc-500">
        {programHref ? (
          <a href={programHref} target="_blank" rel="noreferrer" className="link-accent font-mono">
            {t("footer.program")} {shorten(settings.programId, 4, 4)}
          </a>
        ) : (
          <span className="font-mono">
            {t("footer.program")} {shorten(settings.programId, 4, 4)}
          </span>
        )}
        <a href={GITHUB_REPO} target="_blank" rel="noreferrer" className="link-accent">
          {t("footer.github")}
        </a>
        <span>{t("footer.disclaimer")}</span>
      </div>
    </footer>
  );
}
