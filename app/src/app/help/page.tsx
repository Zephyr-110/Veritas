"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  ChevronDown,
  CircleDollarSign,
  ExternalLink,
  Percent,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useT } from "@/i18n/provider";
import { Button, CopyText, Reveal } from "@/components/ui";
import { DEFAULT_PROGRAM_ID } from "@/lib/constants";
import { useMarkets } from "@/hooks/use-markets";
import { useNow } from "@/hooks/use-now";
import { LiveCountdown } from "@/components/live";
import { formatYesNo } from "@/lib/format";

const GITHUB_URL = "https://github.com/Zephyr-110/Veritas";

function ValueCard({
  icon: Icon,
  title,
  body,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="surface stack-3 rounded-xl p-5 text-center backdrop-blur-md">
      <span className="inline-flex h-10 w-10 items-center justify-center self-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
        <Icon className="h-5 w-5" />
      </span>
      <div className="font-medium text-white">{title}</div>
      <p className="text-sm leading-relaxed text-zinc-400">{body}</p>
    </div>
  );
}

function DeepItem({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="surface overflow-hidden rounded-xl backdrop-blur-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span className="font-medium text-white">{title}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        className={`grid transition-all duration-300 ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="overflow-hidden">
          <div className="stack-3 px-5 pb-5">
            <p className="text-[15px] leading-relaxed text-zinc-400">{body}</p>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickStep({
  n,
  title,
  body,
  children,
}: {
  n: number;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="surface flex h-full flex-col gap-3 rounded-xl p-5 backdrop-blur-md">
      <span className="num inline-flex h-7 w-7 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10 text-sm font-semibold text-cyan-300">
        {n}
      </span>
      <div className="font-medium text-white">{title}</div>
      <p className="text-sm leading-relaxed text-zinc-400">{body}</p>
      {children ? <div className="mt-auto pt-1">{children}</div> : null}
    </div>
  );
}

function ClaimButton() {
  const t = useT();
  const { publicKey } = useWallet();
  const [state, setState] = useState<"idle" | "busy" | "done" | "cooldown" | "unavailable">("idle");
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
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setState(data.error === "cooldown" ? "cooldown" : "unavailable");
      }
    } catch {
      setState("unavailable");
    }
  };
  const label =
    state === "done"
      ? t("help.q2Claimed")
      : state === "cooldown"
        ? t("help.q2Cooldown")
        : state === "unavailable"
          ? t("help.q2Unavailable")
          : t("help.q2Claim");
  return (
    <Button
      type="button"
      className="h-9 px-4 text-sm"
      busy={state === "busy"}
      disabled={!publicKey || state === "busy" || state === "done"}
      onClick={() => void claim()}
    >
      {label}
    </Button>
  );
}

function LiveNowCard() {
  const t = useT();
  const { markets } = useMarkets();
  const now = useNow(1000);
  const live = markets
    .filter((m) => m.status === "open" && m.expiry > now)
    .sort((a, b) => a.expiry - b.expiry)[0];
  if (!live) return null;
  return (
    <Link
      href={`/markets/${live.address.toBase58()}`}
      className="surface flex items-center justify-between gap-4 rounded-xl p-5 backdrop-blur-md transition-colors hover:border-cyan-400/30"
    >
      <div className="stack-1 min-w-0">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-emerald-300">
          <span className="live-dot" />
          {t("help.liveNow")}
        </span>
        <span className="truncate font-medium text-white">{live.title}</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
        <LiveCountdown expiry={live.expiry} now={now} className="cd-glow text-lg font-semibold text-white" />
        <span className="num text-sm text-zinc-400">{formatYesNo(live.yesPrice)}</span>
      </div>
    </Link>
  );
}

export default function HelpPage() {
  const t = useT();
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-3xl stack-6 fade-in">
      <Reveal>
        <header className="stack-4 items-center text-center">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
            {t("help.title")}
          </h1>
          <p className="mx-auto max-w-xl text-[15px] leading-relaxed text-zinc-400">{t("help.sub")}</p>
        </header>
      </Reveal>

      <Reveal>
        <div className="grid gap-3 sm:grid-cols-3">
          <ValueCard icon={CircleDollarSign} title={t("help.v1Title")} body={t("help.v1")} />
          <ValueCard icon={ShieldCheck} title={t("help.v2Title")} body={t("help.v2")} />
          <ValueCard icon={Percent} title={t("help.v3Title")} body={t("help.v3")} />
        </div>
      </Reveal>

      <Reveal>
        <section className="stack-3">
          <h2 className="section-title">{t("help.quickTitle")}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <QuickStep n={1} title={t("help.q1Title")} body={t("help.q1")} />
            <QuickStep n={2} title={t("help.q2Title")} body={t("help.q2")}>
              <div className="flex flex-wrap items-center gap-3">
                <ClaimButton />
                <a
                  href="https://faucet.solana.com"
                  target="_blank"
                  rel="noreferrer"
                  className="link-accent inline-flex items-center gap-1 text-sm"
                >
                  {t("help.q2Sol")}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </QuickStep>
            <QuickStep n={3} title={t("help.q3Title")} body={t("help.q3")} />
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section className="stack-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-5">
          <div className="flex items-center gap-2 font-medium text-amber-200">
            <TriangleAlert className="h-5 w-5 shrink-0" />
            {t("help.riskTitle")}
          </div>
          <p className="text-[15px] leading-relaxed text-amber-100/70">{t("help.risk")}</p>
        </section>
      </Reveal>

      <Reveal>
        <LiveNowCard />
      </Reveal>

      <Reveal>
        <div className="flex justify-center">
          <Button className="h-12 px-8 text-base" onClick={() => router.push("/markets")}>
            {t("help.cta")}
          </Button>
        </div>
      </Reveal>

      <Reveal>
        <section className="stack-3">
          <h2 className="section-title">{t("help.deepTitle")}</h2>
          <DeepItem title={t("help.a1Title")} body={t("help.a1")} />
          <DeepItem title={t("help.a2Title")} body={t("help.a2")}>
            <div className="stack-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-4 text-sm leading-relaxed text-zinc-400">
              <div className="font-medium text-zinc-200">{t("help.exTitle")}</div>
              <p>{t("help.ex1")}</p>
              <p>{t("help.ex2")}</p>
            </div>
          </DeepItem>
        </section>
      </Reveal>

      <Reveal>
        <section className="stack-3">
          <h2 className="section-title">{t("help.buildersTitle")}</h2>
          <div className="surface stack-3 rounded-xl p-5 backdrop-blur-md">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-3 text-[15px] text-zinc-200 transition-colors hover:text-white"
            >
              <span>{t("help.github")}</span>
              <ExternalLink className="h-4 w-4 shrink-0 text-zinc-500" />
            </a>
            <div className="hairline" />
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-[15px] text-zinc-200">{t("help.program")}</span>
              <CopyText value={DEFAULT_PROGRAM_ID} />
            </div>
            <div className="hairline" />
            <a
              href={`https://solscan.io/account/${DEFAULT_PROGRAM_ID}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-3 text-[15px] text-zinc-200 transition-colors hover:text-white"
            >
              <span>{t("help.explorer")}</span>
              <ExternalLink className="h-4 w-4 shrink-0 text-zinc-500" />
            </a>
          </div>
          <p className="text-center text-sm text-zinc-500">{t("help.footnote")}</p>
        </section>
      </Reveal>
    </div>
  );
}
