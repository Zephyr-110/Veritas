"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LegacyMarketRedirect() {
  const params = useParams<{ address: string }>();
  const router = useRouter();
  useEffect(() => {
    if (params.address) router.replace("/markets/" + params.address);
  }, [params.address, router]);
  return null;
}
