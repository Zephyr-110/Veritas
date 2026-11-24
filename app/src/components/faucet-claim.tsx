"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Button, StableText } from "./ui";
import { useRefresh } from "./providers";

export function FaucetClaimButton({ className = "h-9 px-4 text-sm" }: { className?: string }) {
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
        if (data.error) console.warn("Faucet", data.error);
        setState(data.error === "cooldown" ? "cooldown" : "unavailable");
      }
    } catch {
      setState("unavailable");
    }
  };
  const labelKey =
    state === "done"
      ? "help.q2Claimed"
      : state === "cooldown"
        ? "help.q2Cooldown"
        : state === "unavailable"
          ? "help.q2Unavailable"
          : "help.q2Claim";
  return (
    <Button
      type="button"
      tone={publicKey ? "primary" : "secondary"}
      className={className}
      busy={state === "busy"}
      disabled={!publicKey || state === "busy" || state === "done"}
      onClick={() => void claim()}
    >
      <StableText k={labelKey} align="center" />
    </Button>
  );
}
