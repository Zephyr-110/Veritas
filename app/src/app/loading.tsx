"use client";

import { useT } from "@/i18n/provider";
import { StateBlock } from "@/components/ui";

export default function Loading() {
  const t = useT();
  return <StateBlock kind="loading" title={t("state.loading")} />;
}
