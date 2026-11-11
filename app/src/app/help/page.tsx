"use client";

import { useT } from "@/i18n/provider";

const SECTIONS = [
  ["help.whatTitle", "help.what"],
  ["help.tradeTitle", "help.trade"],
  ["help.makeTitle", "help.make"],
  ["help.settleTitle", "help.settle"],
  ["help.voidTitle", "help.void"],
] as const;

export default function HelpPage() {
  const t = useT();
  return (
    <div className="mx-auto w-full max-w-2xl stack-6 fade-in">
      <h1 className="page-title">{t("help.title")}</h1>
      {SECTIONS.map(([title, body]) => (
        <section key={title} className="stack-3">
          <h2 className="section-title">{t(title)}</h2>
          <p className="text-[15px] leading-relaxed text-zinc-400">{t(body)}</p>
        </section>
      ))}
    </div>
  );
}
