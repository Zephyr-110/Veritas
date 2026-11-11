"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
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
} from "@/lib/constants";
import { clusterLabel, kindLabel, kindTone, marketKind } from "@/lib/display";
import { explorerTx, formatYesNo, shorten } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import { parseTxError } from "@/lib/errors";
import { sendIxs, mustWallet } from "@/lib/send";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import type { ClusterName } from "@/lib/types";
import { useI18n, useT } from "@/i18n/provider";
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
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "secondary" | "yes" | "no" }) {
  const tones: Record<string, string> = {
    primary: "shine bg-white text-zinc-950 hover:bg-zinc-100 shadow-[0_0_24px_rgba(255,255,255,0.08)]",
    secondary: "bg-transparent text-zinc-200 border border-zinc-800 hover:border-zinc-700 hover:bg-white/5",
    yes: "shine bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25",
    no: "shine bg-rose-500/15 text-rose-400 border border-rose-500/30 hover:bg-rose-500/25",
  };
  return (
    <button
      className={cx(
        "inline-flex h-10 items-center justify-center rounded-2xl px-4 text-sm font-medium transition-colors duration-200 hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100",
        tones[tone],
        className
      )}
      {...props}
    />
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
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="kicker min-w-0 text-[11px] font-medium leading-tight text-zinc-500">{label}</span>
        {hint ? <span className="num max-w-[45%] shrink-0 text-right text-xs leading-tight text-zinc-500">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        "w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-600 transition-[border-color,box-shadow] duration-200 focus:border-cyan-500/40 focus:ring-2 focus:ring-cyan-500/10",
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
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium", tones[tone])}>
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
      {kind === "live" ? <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" /> : null}
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
      <div className="kicker text-[11px] text-zinc-500">
        {kind === "loading" ? "…" : kind === "pending" ? "…" : ""}
      </div>
      <div className="text-base font-medium text-white">{title}</div>
      {body ? <p className="max-w-xl text-sm leading-relaxed text-zinc-500">{body}</p> : null}
      {kind === "loading" ? <div className="shimmer h-2 w-40 rounded-full bg-zinc-900" /> : null}
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
          locale === "en" ? "bg-white text-zinc-950" : "text-zinc-400 hover:text-white"
        )}
      >
        {t("nav.en")}
      </button>
      <button
        type="button"
        onClick={() => setLocale("zh")}
        className={cx(
          "rounded-full px-2 py-1 text-[11px] font-medium leading-none transition-colors",
          locale === "zh" ? "bg-white text-zinc-950" : "text-zinc-400 hover:text-white"
        )}
      >
        {t("nav.zh")}
      </button>
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

  const nav = [
    { href: "/", label: t("nav.home") },
    { href: "/markets", label: t("nav.markets") },
    { href: "/create", label: t("nav.create") },
    { href: "/me", label: t("nav.me") },
    { href: "/help", label: t("nav.help") },
  ];

  return (
    <header className="header-line sticky top-0 z-40 border-b border-cyan-500/10 bg-[#05070c]/75 backdrop-blur-xl">
      <div className="page-width mx-auto flex min-h-14 min-w-0 flex-wrap items-start justify-between gap-2 px-3 py-2 sm:h-14 sm:flex-nowrap sm:items-center sm:px-4 sm:py-0">
        <div className="flex min-w-0 items-center gap-2 md:gap-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-cyan-500/30 bg-zinc-900 text-xs font-bold text-cyan-200 shadow-[0_0_16px_rgba(34,211,238,0.35)]">
              V
            </span>
            <span className="hidden text-sm font-bold tracking-tight text-white sm:inline">{t("brand.name")}</span>
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
                    active ? "bg-white/10 text-white" : "text-zinc-400 hover:text-white"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

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
                ok ? "live-dot bg-emerald-400" : ok === false ? "bg-rose-400" : "bg-zinc-500"
              )}
            />
            {clusterLabel(settings.cluster)}
          </button>
          <Button type="button" tone="secondary" className="h-8 whitespace-nowrap px-2 text-[11px] md:hidden" onClick={() => setOpen(true)}>
            {t("nav.settings")}
          </Button>
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
                active ? "bg-white text-zinc-950" : "text-zinc-400"
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
          <h2 className="text-xl font-bold tracking-tight text-white">{t("settings.title")}</h2>
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
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-white"
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


