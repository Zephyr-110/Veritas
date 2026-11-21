"use client";

import Link from "next/link";
import { Button, StableText } from "@/components/ui";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="surface min-h-56 p-6">
      <div className="page-title">
        <StableText k="errorPage.title" />
      </div>
      <p className="mt-2 text-[15px] leading-relaxed text-zinc-400">
        <StableText k="errorPage.fallback" block />
      </p>
      <div className="mt-6 cluster-3">
        <Button type="button" onClick={reset}>
          <StableText k="common.tryAgain" align="center" />
        </Button>
        <Link href="/markets" className="link-accent text-[15px]">
          <StableText k="errorPage.back" />
        </Link>
      </div>
    </div>
  );
}
