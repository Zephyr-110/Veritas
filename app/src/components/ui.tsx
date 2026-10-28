"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_CLUSTER, DEFAULT_COLLATERAL_MINT, DEFAULT_PROGRAM_ID, DEFAULT_RPC } from "@/lib/constants";
import { explorerTx, shorten } from "@/lib/format";
import { parseTxError } from "@/lib/errors";
import { sendIxs, mustWallet } from "@/lib/send";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import type { ClusterName } from "@/lib/types";
import { useRefresh, useSettings, useToasts } from "./providers";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Button({
  tone = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "yes" | "no" | "ghost" | "ink" }) {
  const tones: Record<string, string> = {
    primary: "bg-white text-zinc-950 hover:bg-zinc-200",
    yes: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25",
    no: "bg-rose-500/15 text-rose-400 border border-rose-500/30 hover:bg-rose-500/25",
    ghost: "bg-transparent text-zinc-200 border border-zinc-800 hover:border-zinc-700 hover:bg-white/5",
    ink: "bg-zinc-100 text-zinc-950 hover:bg-white",
  };
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5 backdrop-blur-md transition-all hover:border-zinc-700/80",
        className
      )}
    >
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
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</span>
        {hint ? <span className="text-xs text-zinc-500">{hint}</span> : null}
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
        "w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-500/40 focus:ring-2 focus:ring-cyan-500/10",
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
    <span className={cx("inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium", tones[tone])}>
      {children}
    </span>
  );
}

export function CopyText({ value, label }: { value: string; label?: string }) {
  const { push } = useToasts();
  return (
    <button
      type="button"
      className="rounded-md px-1.5 py-0.5 font-mono text-xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        push("info", "Copied", label ?? value);
      }}
    >
      {label ?? shorten(value, 4, 4)}
    </button>
  );
}

export function StatusChip({ status }: { status: string }) {
  if (status === "open") return <Chip tone="yes">Live</Chip>;
  if (status === "resolved") return <Chip tone="accent">Resolved</Chip>;
  if (status === "burn") return <Chip tone="no">Voided</Chip>;
  return <Chip>Upcoming</Chip>;
}

export function OddsBar({ yes }: { yes: number }) {
  const raw = Number.isFinite(yes) ? yes : 0.5;
  const y = Math.max(0, Math.min(100, Math.round(raw * 100)));
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
      <div className="flex h-full w-full">
        <div className="h-full bg-emerald-500" style={{ width: `${y}%` }} />
        <div className="h-full bg-rose-500" style={{ width: `${100 - y}%` }} />
      </div>
    </div>
  );
}

export function useTx() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { push } = useToasts();
  const { bump } = useRefresh();
  const { settings } = useSettings();
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
      push("ok", label, link ? `Confirmed ${sig}` : sig);
      bump();
      return sig;
    } catch (err) {
      push("err", `${label} failed`, parseTxError(err));
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
  if (!connected || !publicKey) {
    return (
      <Button type="button" onClick={() => setVisible(true)}>
        Connect wallet
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <CopyText value={publicKey.toBase58()} label={shorten(publicKey.toBase58(), 4, 4)} />
      <Button type="button" tone="ghost" onClick={() => disconnect()}>
        Disconnect
      </Button>
    </div>
  );
}

export function Header() {
  const pathname = usePathname();
  const { settings } = useSettings();
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
    { href: "/", label: "Markets" },
    { href: "/create", label: "Create" },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-[#0B0E14]/70 backdrop-blur-xl">
      <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg border border-zinc-800 bg-zinc-900 text-sm font-bold text-white">
              V
            </span>
            <span className="text-sm font-bold tracking-tight text-white">Veritas</span>
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cx(
                  "rounded-lg px-3 py-1.5 text-sm transition-colors",
                  pathname === item.href ? "bg-white/10 text-white" : "text-zinc-400 hover:text-white"
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="pointer-events-none absolute left-1/2 hidden max-w-[42%] -translate-x-1/2 text-center lg:block">
          <div className="truncate text-[11px] font-medium text-zinc-300">
            Veritas Markets · Binary Prediction Protocol on Solana
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link href="/create" className="md:hidden">
            <Button type="button" tone="ghost">
              Create
            </Button>
          </Link>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cx(
              "hidden items-center gap-2 rounded-full px-3 py-1 font-mono text-xs md:flex",
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
                ok ? "animate-pulse bg-emerald-400" : ok === false ? "bg-rose-400" : "bg-zinc-500"
              )}
            />
            {settings.cluster}
          </button>
          <Button type="button" tone="ghost" className="md:hidden" onClick={() => setOpen(true)}>
            Settings
          </Button>
          <WalletButton />
        </div>
      </div>
      {open ? <SettingsModal onClose={() => setOpen(false)} /> : null}
    </header>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, setSettings } = useSettings();
  const { bump } = useRefresh();
  const [draft, setDraft] = useState(settings);

  const save = () => {
    try {
      new PublicKey(draft.programId);
      new PublicKey(draft.collateralMint);
    } catch {
      return;
    }
    setSettings(draft);
    bump();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-glow"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-bold tracking-tight text-white">Network</h2>
          <button type="button" className="text-zinc-400 hover:text-white" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="space-y-4">
          <Field label="RPC">
            <TextInput value={draft.rpcUrl} onChange={(e) => setDraft({ ...draft, rpcUrl: e.target.value })} />
          </Field>
          <Field label="Cluster">
            <select
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-white"
              value={draft.cluster}
              onChange={(e) => setDraft({ ...draft, cluster: e.target.value as ClusterName })}
            >
              <option value="localnet">localnet</option>
              <option value="devnet">devnet</option>
              <option value="testnet">testnet</option>
              <option value="mainnet-beta">mainnet-beta</option>
            </select>
          </Field>
          <Field label="Program ID">
            <TextInput value={draft.programId} onChange={(e) => setDraft({ ...draft, programId: e.target.value })} />
          </Field>
          <Field label="Default collateral mint" hint="Prefilled on create">
            <TextInput
              value={draft.collateralMint}
              onChange={(e) => setDraft({ ...draft, collateralMint: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-6 flex justify-between gap-3">
          <Button
            type="button"
            tone="ghost"
            onClick={() =>
              setDraft({
                rpcUrl: DEFAULT_RPC,
                cluster: DEFAULT_CLUSTER as ClusterName,
                programId: DEFAULT_PROGRAM_ID,
                collateralMint: DEFAULT_COLLATERAL_MINT,
              })
            }
          >
            Reset
          </Button>
          <Button type="button" onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
