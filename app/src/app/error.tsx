"use client";

import Link from "next/link";
import { Button } from "@/components/ui";
import { useT } from "@/i18n/provider";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  return (
    <div className="surface min-h-56 p-6">
      <div className="text-2xl font-semibold tracking-tight text-white">{t("errorPage.title")}</div>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">{t("errorPage.fallback")}</p>
      <div className="mt-6 cluster-3">
        <Button type="button" onClick={reset}>
          {t("common.tryAgain")}
        </Button>
        <Link href="/markets" className="text-sm text-white underline hover:text-zinc-200">
          {t("errorPage.back")}
        </Link>
      </div>
    </div>
  );
}
