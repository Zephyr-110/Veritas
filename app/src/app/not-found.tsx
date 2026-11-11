"use client";

import { useT } from "@/i18n/provider";
import { StateBlock } from "@/components/ui";

export default function NotFound() {
  const t = useT();
  return (
    <StateBlock
      kind="empty"
      title={t("notFound.title")}
      body={t("notFound.body")}
      action={
        <a href="/markets" className="link-accent text-[15px]">
          {t("nav.markets")}
        </a>
      }
    />
  );
}
