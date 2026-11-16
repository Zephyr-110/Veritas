"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Button } from "./ui";
import { useRefresh } from "./providers";
import { useT } from "@/i18n/provider";

// The devnet test-USDT claim (POST /api/faucet), shared by the Help
// quick-start and the trade desk's zero-balance state. On success it
// bumps the shared refresh nonce so any mounted balance/position query
// refetches and the new funds show up without a reload.
export function FaucetClaimButton({ className = "h-9 px-4 text-sm" }: { className?: string }) {
  const t = useT();
  const { publicKey } = useWallet();
  const { bump } = useRefresh();
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
        bump();
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
      className={className}
      busy={state === "busy"}
      disabled={!publicKey || state === "busy" || state === "done"}
      onClick={() => void claim()}
    >
      {label}
    </Button>
  );
}
