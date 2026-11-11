"use client";

import { useT } from "@/i18n/provider";

export default function HelpPage() {
  const t = useT();
  const paras = ["help.p1", "help.p2", "help.p3", "help.p4", "help.p5", "help.p6", "help.p7", "help.p8"] as const;
  return (
    <div className="mx-auto w-full max-w-2xl stack-5">
      <h1 className="text-2xl font-semibold tracking-tight text-white">{t("help.title")}</h1>
      {paras.map((key) => (
        <p key={key} className="text-sm leading-relaxed text-zinc-400">
          {t(key)}
        </p>
      ))}
    </div>
  );
}
