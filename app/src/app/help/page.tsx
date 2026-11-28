"use client";

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import {
  ChevronDown,
  CircleDollarSign,
  ExternalLink,
  Percent,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { CopyText, Reveal, StableText, onSpot } from "@/components/ui";
import { DEFAULT_PROGRAM_ID, GITHUB_REPO, ORACLE_CENSUS_URL } from "@/lib/constants";
import { useMarkets } from "@/hooks/use-markets";
import { useNow } from "@/hooks/use-now";
import { LiveCountdown } from "@/components/live";
import { formatYesNo } from "@/lib/format";
import { questionTitle } from "@/lib/display";
import { useLocale } from "@/i18n/provider";

function ValueCard({
  icon: Icon,
  titleKey,
  bodyKey,
  extraBodyKey,
}: {
  icon: ComponentType<{ className?: string }>;
  titleKey: string;
  bodyKey: string;
  extraBodyKey?: string;
}) {
  return (
    <div onMouseMove={onSpot} className="surface stack-3 p-5 text-center">
      <span className="inline-flex h-10 w-10 items-center justify-center self-center border border-[var(--line)] bg-[var(--seg-bg)] text-white">
        <Icon className="h-5 w-5" />
      </span>
      <div className="font-medium text-white">
        <StableText k={titleKey} block align="center" />
      </div>
      <p className="text-sm leading-relaxed text-zinc-400">
        <StableText k={bodyKey} block align="center" />
      </p>
      {extraBodyKey ? (
        <p className="text-xs leading-relaxed text-zinc-400">
          <StableText k={extraBodyKey} block align="center" />
        </p>
      ) : null}
    </div>
  );
}

function DeepItem({
  id,
  titleKey,
  whyKey,
  howKey,
  children,
}: {
  id: string;
  titleKey: string;
  whyKey: string;
  howKey: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const syncHash = () => {
      if (window.location.hash !== `#${id}`) return;
      setOpen(true);
      requestAnimationFrame(() => {
        rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [id]);

  return (
    <div ref={rootRef} id={id} onMouseMove={onSpot} className="surface scroll-mt-24 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span className="font-medium text-white">
          <StableText k={titleKey} />
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-zinc-500 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className="stack-3 border-t border-[var(--hair)] px-5 pt-4 pb-5">
          <div className="stack-1">
            <div className="text-xs font-medium tracking-wider text-zinc-200 uppercase">
              <StableText k="help.deepWhyLabel" />
            </div>
            <p className="text-[15px] leading-relaxed text-zinc-400">
              <StableText k={whyKey} block />
            </p>
          </div>
          <div className="stack-1">
            <div className="text-xs font-medium tracking-wider text-zinc-200 uppercase">
              <StableText k="help.deepHowLabel" />
            </div>
            <p className="text-[15px] leading-relaxed text-zinc-400">
              <StableText k={howKey} block />
            </p>
          </div>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function QuickStep({
  n,
  titleKey,
  bodyKey,
  children,
}: {
  n: number;
  titleKey: string;
  bodyKey: string;
  children?: ReactNode;
}) {
  return (
    <div onMouseMove={onSpot} className="surface flex h-full flex-col gap-3 p-5">
      <span className="num inline-flex h-7 w-7 items-center justify-center border border-[var(--line)] bg-[var(--seg-bg)] text-xs font-semibold text-white">
        0{n}
      </span>
      <div className="font-medium text-white">
        <StableText k={titleKey} block />
      </div>
      <p className="text-sm leading-relaxed text-zinc-400">
        <StableText k={bodyKey} block />
      </p>
      {children ? <div className="mt-auto pt-1">{children}</div> : null}
    </div>
  );
}

function LiveNowCard() {
  const { markets } = useMarkets();
  const now = useNow(1000);
  useLocale();
  const live = markets
    .filter((m) => m.status === "open" && m.expiry > now)
    .sort((a, b) => a.expiry - b.expiry)[0];
  if (!live) return null;
  return (
    <Link
      href={`/markets/${live.address.toBase58()}`}
      onMouseMove={onSpot}
      className="surface flex items-center justify-between gap-4 p-5"
    >
      <div className="stack-1 min-w-0">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[var(--yes)]">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--yes)]" />
          <StableText k="help.liveNow" />
        </span>
        <span className="truncate font-medium text-white">{live.title ? questionTitle(live) : ""}</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
        <LiveCountdown expiry={live.expiry} now={now} className="text-lg font-semibold text-white" />
        <span className="num whitespace-nowrap text-sm text-zinc-400">{formatYesNo(live.yesPrice)}</span>
        <span className="text-sm font-medium text-white">
          <StableText k="help.cta" align="end" /> →
        </span>
      </div>
    </Link>
  );
}

export default function HelpPage() {
  return (
    <div className="mx-auto w-full max-w-4xl stack-6 fade-in">
      <Reveal>
        <header className="stack-4 items-center text-center">
          <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
            <StableText k="help.title" block align="center" />
          </h1>
          <p className="mx-auto max-w-xl text-[15px] leading-relaxed text-zinc-400">
            <StableText k="help.sub" block align="center" />
          </p>
        </header>
      </Reveal>

      <Reveal>
        <div className="grid gap-3 sm:grid-cols-3">
          <ValueCard icon={CircleDollarSign} titleKey="help.v1Title" bodyKey="help.v1" />
          <ValueCard icon={ShieldCheck} titleKey="help.v2Title" bodyKey="help.v2" />
          <ValueCard
            icon={Percent}
            titleKey="help.v3Title"
            bodyKey="help.v3"
            extraBodyKey="help.feeAnchors"
          />
        </div>
      </Reveal>

      <Reveal>
        <section className="stack-3">
          <h2 className="section-title">
            <StableText k="help.quickTitle" />
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <QuickStep n={1} titleKey="help.q1Title" bodyKey="help.q1" />
            <QuickStep n={2} titleKey="help.q2Title" bodyKey="help.q2" />
            <QuickStep n={3} titleKey="help.q3Title" bodyKey="help.q3" />
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section
          onMouseMove={onSpot}
          className="surface stack-3 border-[var(--warn-line)] bg-[var(--warn-soft)] p-5"
        >
          <div className="flex items-center gap-2 font-medium text-[var(--warn)]">
            <TriangleAlert className="h-5 w-5 shrink-0" />
            <StableText k="help.riskTitle" />
          </div>
          <p className="text-[15px] leading-relaxed text-zinc-300">
            <StableText k="help.risk" block />
          </p>
        </section>
      </Reveal>

      <Reveal>
        <LiveNowCard />
      </Reveal>

      <Reveal>
        <section className="stack-3">
          <h2 className="section-title">
            <StableText k="help.deepTitle" />
          </h2>
          <DeepItem id="permissionless" titleKey="help.a0Title" whyKey="help.a0" howKey="help.a0Sub">
            <p className="text-[15px] leading-relaxed text-zinc-400">
              <StableText k="help.a0Fee" block />
            </p>
            <p className="text-[15px] leading-relaxed text-zinc-400">
              <StableText k="help.a0BetCu" block />
            </p>
            <p className="text-[15px] leading-relaxed text-zinc-400">
              <StableText k="create.rentNote" block />
            </p>
          </DeepItem>
          <DeepItem id="settlement" titleKey="help.a2Title" whyKey="help.a2" howKey="help.a2Sub">
            <a href={ORACLE_CENSUS_URL} className="link-accent text-sm">
              <StableText k="help.censusEvidence" />
            </a>
            <div className="stack-2 border border-[var(--hair)] bg-[var(--seg-bg)] p-4 text-sm leading-relaxed text-zinc-300">
              <p>
                <StableText k="help.a2Tier1" block />
              </p>
              <p>
                <StableText k="help.a2Tier2" block />
              </p>
              <p>
                <StableText k="help.a2Tier3" block />
              </p>
            </div>
            <div className="stack-2 border border-[var(--hair)] bg-[var(--seg-bg)] p-4 text-sm leading-relaxed text-zinc-300">
              <p>
                <StableText k="help.a2Fallback" block />
              </p>
              <pre className="overflow-x-auto border border-[var(--hair)] bg-black/40 px-3 py-2 font-mono text-xs text-zinc-200">
                <code>node scripts/settle.js &lt;MARKET_PUBKEY&gt;</code>
              </pre>
              <p className="text-xs leading-relaxed text-zinc-400">
                <StableText k="help.a2FallbackNote" block />
              </p>
            </div>
            <div className="stack-2 border border-[var(--hair)] bg-[var(--seg-bg)] p-4 text-sm leading-relaxed text-zinc-400">
              <div className="font-medium text-zinc-200">
                <StableText k="help.exTitle" />
              </div>
              <p>
                <StableText k="help.ex1" block />
              </p>
              <p>
                <StableText k="help.ex2" block />
              </p>
            </div>
          </DeepItem>
          <DeepItem id="pm-amm" titleKey="help.a1Title" whyKey="help.a1" howKey="help.a1Sub" />
        </section>
      </Reveal>

      <Reveal>
        <section className="stack-3">
          <h2 className="section-title">
            <StableText k="help.dataTitle" />
          </h2>
          <div onMouseMove={onSpot} className="surface stack-3 p-5 text-[15px] leading-relaxed text-zinc-400">
            <p>
              <StableText k="help.d1" block />
            </p>
            <p>
              <StableText k="help.d2" block />
            </p>
            <p>
              <StableText k="help.d3" block />
            </p>
            <p>
              <StableText k="help.d4" block />
            </p>
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section className="stack-3">
          <h2 className="section-title">
            <StableText k="help.buildersTitle" />
          </h2>
          <div onMouseMove={onSpot} className="surface stack-3 p-5">
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-3 text-[15px] text-zinc-200 transition-colors hover:text-white"
            >
              <StableText k="help.github" />
              <ExternalLink className="h-4 w-4 shrink-0 text-zinc-500" />
            </a>
            <div className="hairline" />
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-[15px] text-zinc-200">
                <StableText k="help.program" />
              </span>
              <CopyText value={DEFAULT_PROGRAM_ID} />
            </div>
            <div className="hairline" />
            <a
              href={`https://explorer.solana.com/address/${DEFAULT_PROGRAM_ID}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-3 text-[15px] text-zinc-200 transition-colors hover:text-white"
            >
              <StableText k="help.explorer" />
              <ExternalLink className="h-4 w-4 shrink-0 text-zinc-500" />
            </a>
          </div>
          <p className="text-center text-sm text-zinc-500">
            <StableText k="help.footnote" block align="center" />
          </p>
        </section>
      </Reveal>
    </div>
  );
}
