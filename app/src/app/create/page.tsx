"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { PREDICTION_BYTES } from "@/lib/constants";
import { encodePrediction, fromUi, randomMarketId, utf8Len } from "@/lib/format";
import { findMarketPdas } from "@/lib/pdas";
import { fetchMintMeta } from "@/lib/tokens";
import { ixCreateMarket } from "@/lib/instructions";
import { useProgram } from "@/hooks/use-program";
import { useSettings, useToasts } from "@/components/providers";
import { Button, Card, Field, TextInput, useTx } from "@/components/ui";

function defaultExpiryLocal(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CreatePage() {
  const router = useRouter();
  const program = useProgram();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { settings } = useSettings();
  const { busy, run } = useTx();
  const { push } = useToasts();

  const [title, setTitle] = useState("");
  const [expiry, setExpiry] = useState(defaultExpiryLocal);
  const [amount, setAmount] = useState("100");
  const [mint, setMint] = useState(settings.collateralMint);
  const bytes = utf8Len(title);

  const submit = async () => {
    if (!publicKey) return;
    if (!title.trim()) {
      push("err", "Create failed", "Enter a question");
      return;
    }
    if (bytes > PREDICTION_BYTES) {
      push("err", "Create failed", "Question exceeds 64 bytes");
      return;
    }
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    if (!Number.isFinite(expiryUnix) || expiryUnix <= Math.floor(Date.now() / 1000)) {
      push("err", "Create failed", "Expiry must be in the future");
      return;
    }
    try {
      const collateralMint = new PublicKey(mint.trim());
      const meta = await fetchMintMeta(connection, collateralMint);
      const collateralAmount = fromUi(amount, meta.decimals);
      if (collateralAmount <= 0n) {
        push("err", "Create failed", "Initial liquidity must be greater than 0");
        return;
      }
      const marketId = randomMarketId();
      const pdas = findMarketPdas(program.programId, marketId);
      const sig = await run("Create market", () =>
        ixCreateMarket(program, {
          creator: publicKey,
          oracle: publicKey,
          collateralMint,
          marketId,
          prediction: encodePrediction(title.trim()),
          expiry: expiryUnix,
          collateralAmount,
          tokenProgram: meta.tokenProgram,
        })
      );
      if (sig) router.push(`/m/${pdas.market.toBase58()}`);
    } catch (err) {
      push("err", "Create failed", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-[0.22em] text-accent">Create market</div>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-white">Ask a question.</h1>
      </div>
      <Card className="space-y-5">
        <Field label="Question" hint={`${bytes}/${PREDICTION_BYTES} bytes`}>
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Will BTC close above $100k this Friday?"
          />
        </Field>
        <Field label="Expiry">
          <TextInput type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </Field>
        <Field label="Initial liquidity">
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Collateral mint">
          <TextInput value={mint} onChange={(e) => setMint(e.target.value)} />
        </Field>
        <div className="rounded-md bg-bg px-4 py-3 text-sm leading-relaxed text-mute">
          The connected wallet becomes both LP and oracle. That address cannot trade this market.
          Use a second wallet to buy Yes or No. Only the oracle can resolve inside the window.
        </div>
        <Button
          type="button"
          className="w-full py-3"
          disabled={busy || !publicKey}
          onClick={() => void submit()}
        >
          {busy ? "Submitting…" : publicKey ? "Create market" : "Connect wallet first"}
        </Button>
      </Card>
    </div>
  );
}