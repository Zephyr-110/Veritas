"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { COLLATERAL_SYMBOL, MIN_CREATE_COLLATERAL, PREDICTION_BYTES } from "@/lib/constants";
import { encodePrediction, fromUi, randomMarketId, utf8Len } from "@/lib/format";
import { FEEDS, feedByKey, feedIdBytes, humanToThreshold, type FeedPreset } from "@/lib/feeds";
import { findMarketPdas } from "@/lib/pdas";
import { fetchMintMeta } from "@/lib/tokens";
import { ixCreateMarket } from "@/lib/instructions";
import { localizeError } from "@/lib/errors";
import { useProgram } from "@/hooks/use-program";
import { useSettings, useToasts } from "@/components/providers";
import { Button, Card, Field, TextInput, useTx } from "@/components/ui";
import { useT } from "@/i18n/provider";
import type { FeedKey } from "@/lib/types";

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function defaultExpiryLocal(): string {
  return toLocalInput(new Date(Date.now() + 60 * 60 * 1000));
}

const PRESETS = [
  { id: "15m", key: "create.preset15m" as const, ms: 15 * 60 * 1000 },
  { id: "1h", key: "create.preset1h" as const, ms: 60 * 60 * 1000 },
  { id: "4h", key: "create.preset4h" as const, ms: 4 * 60 * 60 * 1000 },
  { id: "1d", key: "create.preset1d" as const, ms: 24 * 60 * 60 * 1000 },
];

function autoTitle(feed: FeedPreset, human: string, above: boolean, expiry: string): string {
  const op = above ? ">=" : "<";
  const when = expiry.replace("T", " ");
  return feed.symbol + " " + op + " " + human + " @ " + when;
}

export default function CreatePage() {
  const router = useRouter();
  const program = useProgram();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { settings } = useSettings();
  const { busy, run } = useTx();
  const { push } = useToasts();
  const t = useT();

  const [feedKey, setFeedKey] = useState<FeedKey>("btc");
  const feed = feedByKey(feedKey);
  const [human, setHuman] = useState(feed.defaultHuman);
  const [above, setAbove] = useState(true);
  const [expiry, setExpiry] = useState(defaultExpiryLocal);
  const [preset, setPreset] = useState("1h");
  const [amount, setAmount] = useState("2");
  const [title, setTitle] = useState(autoTitle(feed, feed.defaultHuman, true, defaultExpiryLocal()));
  const bytes = utf8Len(title);

  const applyPreset = (id: string, ms: number) => {
    setPreset(id);
    const next = toLocalInput(new Date(Date.now() + ms));
    setExpiry(next);
    setTitle(autoTitle(feed, human, above, next));
  };

  const onFeed = (key: FeedKey) => {
    const next = feedByKey(key);
    setFeedKey(key);
    setHuman(next.defaultHuman);
    setTitle(autoTitle(next, next.defaultHuman, above, expiry));
  };

  const submit = async () => {
    if (!publicKey) return;
    if (!program) {
      push("err", t("create.createFailed"), "errors.badAddress");
      return;
    }
    if (!title.trim()) {
      push("err", t("create.needQuestionTitle"), t("create.needQuestionBody"));
      return;
    }
    if (bytes > PREDICTION_BYTES) {
      push("err", t("create.tooLongTitle"), t("create.tooLongBody"));
      return;
    }
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    if (!Number.isFinite(expiryUnix) || expiryUnix <= Math.floor(Date.now() / 1000)) {
      push("err", t("create.laterTitle"), t("create.laterBody"));
      return;
    }
    try {
      const threshold = humanToThreshold(human, feed.exponent);
      const collateralMint = new PublicKey(settings.collateralMint.trim());
      const meta = await fetchMintMeta(connection, collateralMint);
      const collateralAmount = fromUi(amount, meta.decimals);
      if (collateralAmount < MIN_CREATE_COLLATERAL) {
        push("err", t("create.needPoolTitle"), t("create.needPoolBody", { symbol: COLLATERAL_SYMBOL }));
        return;
      }
      const marketId = randomMarketId();
      const pdas = findMarketPdas(program.programId, marketId);
      const sig = await run(t("tx.createMarket"), () =>
        ixCreateMarket(program, {
          creator: publicKey,
          collateralMint,
          marketId,
          prediction: encodePrediction(title.trim()),
          expiry: expiryUnix,
          collateralAmount,
          feedId: feedIdBytes(feed),
          threshold,
          exponent: feed.exponent,
          settleAbove: above,
          tokenProgram: meta.tokenProgram,
        })
      );
      if (sig) router.push("/markets/" + pdas.market.toBase58());
    } catch (err) {
      push("err", t("create.createFailed"), localizeError(err instanceof Error ? err.message : "errors.txFailed"));
    }
  };

  const unused = useMemo(() => FEEDS.length, []);
  void unused;

  return (
    <div className="mx-auto w-full max-w-2xl stack-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">{t("create.title")}</h1>
        <p className="mt-2 text-sm text-zinc-500">{t("create.subtitle")}</p>
        <p className="mt-2 text-sm text-cyan-200">{t("create.minSeed")}</p>
      </div>
      <Card className="stack-5">
        <Field label={t("create.feed")} hint={t("create.feedHint")}>
          <div className="cluster-2">
            {FEEDS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onFeed(item.key)}
                className={"rounded-full border px-3 py-1 text-xs " + (feedKey === item.key ? "border-white bg-white text-zinc-950" : "border-zinc-800 text-zinc-400")}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("create.threshold")} hint={t("create.thresholdHint")}>
            <TextInput inputMode="decimal" value={human} onChange={(e) => { setHuman(e.target.value); setTitle(autoTitle(feed, e.target.value, above, expiry)); }} className="font-mono tabular-nums" />
          </Field>
          <Field label={t("create.exponent")}>
            <TextInput value={String(feed.exponent)} readOnly className="font-mono tabular-nums" />
          </Field>
        </div>
        <Field label={t("create.direction")}>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <Button type="button" tone={above ? "primary" : "secondary"} onClick={() => { setAbove(true); setTitle(autoTitle(feed, human, true, expiry)); }}>
              {t("create.directionAbove")}
            </Button>
            <Button type="button" tone={!above ? "primary" : "secondary"} onClick={() => { setAbove(false); setTitle(autoTitle(feed, human, false, expiry)); }}>
              {t("create.directionBelow")}
            </Button>
          </div>
        </Field>
        <Field label={t("create.question")} hint={bytes + "/" + PREDICTION_BYTES}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("create.placeholder")} />
        </Field>
        <Field label={t("create.tradingEnds")}>
          <div className="mb-3 cluster-2">
            {PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => applyPreset(item.id, item.ms)}
                className={"rounded-full border px-3 py-1 text-xs " + (preset === item.id ? "border-white bg-white text-zinc-950" : "border-zinc-800 text-zinc-400")}
              >
                {t(item.key)}
              </button>
            ))}
          </div>
          <TextInput type="datetime-local" value={expiry} onChange={(e) => { setPreset("custom"); setExpiry(e.target.value); setTitle(autoTitle(feed, human, above, e.target.value)); }} />
        </Field>
        <Field label={t("create.starting", { symbol: COLLATERAL_SYMBOL })} hint={t("create.startingHint")}>
          <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono tabular-nums" />
        </Field>
        <Button type="button" className="h-12 w-full" disabled={busy || !publicKey} onClick={() => void submit()}>
          {busy ? t("state.confirming") : publicKey ? t("create.submit") : t("create.connectFirst")}
        </Button>
      </Card>
    </div>
  );
}
