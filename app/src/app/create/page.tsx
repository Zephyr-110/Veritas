"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { COLLATERAL_SYMBOL, MIN_CREATE_COLLATERAL, PREDICTION_BYTES } from "@/lib/constants";
import { encodePrediction, formatStamp, fromUi, randomMarketId, utf8Len } from "@/lib/format";
import { FEEDS, feedByKey, feedIdBytes, humanToThreshold } from "@/lib/feeds";
import { findMarketPdas } from "@/lib/pdas";
import { fetchMintMeta } from "@/lib/tokens";
import { ixCreateMarket } from "@/lib/instructions";
import { localizeError } from "@/lib/errors";
import { useFeeds } from "@/hooks/use-feeds";
import { useProgram } from "@/hooks/use-program";
import { useSettings, useToasts } from "@/components/providers";
import { FeatureCard } from "@/components/market-card";
import { Button, Field, TextInput, choiceClass, useTx } from "@/components/ui";
import { useT } from "@/i18n/provider";
import type { FeedKey } from "@/lib/types";

const PRESETS = [
  { id: "15m", key: "create.preset15m" as const, ms: 15 * 60 * 1000 },
  { id: "1h", key: "create.preset1h" as const, ms: 60 * 60 * 1000 },
  { id: "4h", key: "create.preset4h" as const, ms: 4 * 60 * 60 * 1000 },
  { id: "1d", key: "create.preset1d" as const, ms: 24 * 60 * 60 * 1000 },
];

function defaultExpiry(): Date {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  next.setSeconds(0, 0);
  return next;
}

function buildTitle(symbol: string, human: string, above: boolean, expiry: Date): string {
  return symbol + " " + (above ? ">=" : "<") + " " + human + " @ " + formatStamp(expiry);
}

function parseSeed(amount: string): bigint | null {
  try {
    return fromUi(amount, 6);
  } catch {
    return null;
  }
}

function clampPart(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export default function CreatePage() {
  const router = useRouter();
  const program = useProgram();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { settings } = useSettings();
  const { busy, run } = useTx();
  const { push } = useToasts();
  const { quotes, ready } = useFeeds();
  const t = useT();

  const [feedKey, setFeedKey] = useState<FeedKey>("btc");
  const feed = feedByKey(feedKey);
  const [human, setHuman] = useState(feed.defaultHuman);
  const [above, setAbove] = useState(true);
  const [expiry, setExpiry] = useState(defaultExpiry);
  const [preset, setPreset] = useState("1h");
  const [amount, setAmount] = useState("2");
  const [title, setTitle] = useState(buildTitle(t(feed.labelKey), feed.defaultHuman, true, defaultExpiry()));
  const [titleLocked, setTitleLocked] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const userThreshold = useRef(false);
  const lastAutoFeed = useRef<FeedKey | null>(null);
  const bytes = utf8Len(title);

  const syncTitle = (nextTitle: string) => {
    if (!titleLocked) setTitle(nextTitle);
  };

  const applyPreset = (id: string, ms: number) => {
    setPreset(id);
    const next = new Date(Date.now() + ms);
    next.setSeconds(0, 0);
    setExpiry(next);
    syncTitle(buildTitle(t(feed.labelKey), human, above, next));
  };

  const onFeed = (key: FeedKey) => {
    userThreshold.current = false;
    lastAutoFeed.current = null;
    setFeedKey(key);
  };

  useEffect(() => {
    if (lastAutoFeed.current === feedKey) return;
    if (userThreshold.current) {
      lastAutoFeed.current = feedKey;
      return;
    }
    const q = quotes[feedKey];
    if (q?.available && q.price != null) {
      const rounded = String(Math.round(q.price));
      setHuman(rounded);
      lastAutoFeed.current = feedKey;
      if (!titleLocked) setTitle(buildTitle(t(feed.labelKey), rounded, above, expiry));
      return;
    }
    if (ready) {
      setHuman(feed.defaultHuman);
      lastAutoFeed.current = feedKey;
      if (!titleLocked) setTitle(buildTitle(t(feed.labelKey), feed.defaultHuman, above, expiry));
    }
  }, [feedKey, quotes, ready, feed.labelKey, feed.defaultHuman, above, expiry, titleLocked, t]);

  const setExpiryPart = (part: "month" | "day" | "hour" | "minute", raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const next = new Date(expiry.getTime());
    if (part === "month") next.setMonth(clampPart(n, 1, 12) - 1);
    if (part === "day") next.setDate(clampPart(n, 1, 31));
    if (part === "hour") next.setHours(clampPart(n, 0, 23));
    if (part === "minute") next.setMinutes(clampPart(n, 0, 59));
    next.setSeconds(0, 0);
    setPreset("custom");
    setExpiry(next);
    syncTitle(buildTitle(t(feed.labelKey), human, above, next));
  };

  const expiryUnix = Math.floor(expiry.getTime() / 1000);
  const seedAtoms = parseSeed(amount);
  const questionError = !title.trim()
    ? t("create.needQuestionBody")
    : bytes > PREDICTION_BYTES
      ? t("create.tooLongBody")
      : "";
  const expiryError = !Number.isFinite(expiryUnix) || expiryUnix <= Math.floor(Date.now() / 1000) ? t("create.laterBody") : "";
  let thresholdError = "";
  try {
    humanToThreshold(human, feed.exponent);
  } catch {
    thresholdError = t("create.thresholdInvalid");
  }
  const seedError =
    seedAtoms == null || seedAtoms < MIN_CREATE_COLLATERAL ? t("create.needPoolBody", { symbol: COLLATERAL_SYMBOL }) : "";

  const submit = async () => {
    setAttempted(true);
    if (questionError || expiryError || thresholdError || seedError) return;
    if (!publicKey) return;
    if (!program) {
      push("err", t("create.createFailed"), t("errors.badAddress"));
      return;
    }
    try {
      const threshold = humanToThreshold(human, feed.exponent);
      const collateralMint = new PublicKey(settings.collateralMint.trim());
      const meta = await fetchMintMeta(connection, collateralMint);
      const collateralAmount = fromUi(amount, meta.decimals);
      if (collateralAmount < MIN_CREATE_COLLATERAL) {
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

  const previewThreshold = useMemo(
    () => t(feed.labelKey) + " " + (above ? ">=" : "<") + " " + human,
    [feed.labelKey, above, human, t]
  );

  return (
    <div className="split split-create fade-in">
      <div className="stack-6">
        <h1 className="page-title">{t("create.title")}</h1>
        <form
          className="stack-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <section className="stack-4">
            <h2 className="section-title">{t("create.groupQuestion")}</h2>
            <Field label={t("create.question")} error={attempted ? questionError : undefined}>
              <TextInput
                value={title}
                onChange={(e) => {
                  setTitleLocked(true);
                  setTitle(e.target.value);
                }}
                placeholder={t("create.placeholder")}
              />
            </Field>
            <Field label={t("create.tradingEnds")} error={attempted ? expiryError : undefined}>
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {PRESETS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => applyPreset(item.id, item.ms)}
                    className={choiceClass(preset === item.id)}
                  >
                    {t(item.key)}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Field label={t("create.month")}>
                  <TextInput
                    inputMode="numeric"
                    className="num text-right"
                    value={String(expiry.getMonth() + 1)}
                    onChange={(e) => setExpiryPart("month", e.target.value)}
                  />
                </Field>
                <Field label={t("create.day")}>
                  <TextInput
                    inputMode="numeric"
                    className="num text-right"
                    value={String(expiry.getDate())}
                    onChange={(e) => setExpiryPart("day", e.target.value)}
                  />
                </Field>
                <Field label={t("create.hour")}>
                  <TextInput
                    inputMode="numeric"
                    className="num text-right"
                    value={String(expiry.getHours())}
                    onChange={(e) => setExpiryPart("hour", e.target.value)}
                  />
                </Field>
                <Field label={t("create.minute")}>
                  <TextInput
                    inputMode="numeric"
                    className="num text-right"
                    value={String(expiry.getMinutes())}
                    onChange={(e) => setExpiryPart("minute", e.target.value)}
                  />
                </Field>
              </div>
            </Field>
          </section>

          <section className="stack-4">
            <h2 className="section-title">{t("create.groupSettlement")}</h2>
            <Field label={t("create.feed")} hint={t("create.feedHint")}>
              <div className="grid grid-cols-3 gap-2">
                {FEEDS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => onFeed(item.key)}
                    className={choiceClass(feedKey === item.key)}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>
            </Field>
            <Field label={t("create.threshold")} error={attempted ? thresholdError : undefined}>
              <TextInput
                inputMode="decimal"
                value={human}
                onChange={(e) => {
                  userThreshold.current = true;
                  setHuman(e.target.value);
                  syncTitle(buildTitle(t(feed.labelKey), e.target.value, above, expiry));
                }}
                className="num text-right"
              />
            </Field>
            <Field label={t("create.direction")}>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    setAbove(true);
                    syncTitle(buildTitle(t(feed.labelKey), human, true, expiry));
                  }}
                  className={choiceClass(above)}
                >
                  {t("create.directionAbove")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAbove(false);
                    syncTitle(buildTitle(t(feed.labelKey), human, false, expiry));
                  }}
                  className={choiceClass(!above)}
                >
                  {t("create.directionBelow")}
                </button>
              </div>
            </Field>
          </section>

          <section className="stack-4">
            <h2 className="section-title">{t("create.groupSeed")}</h2>
            <Field
              label={t("create.starting", { symbol: COLLATERAL_SYMBOL })}
              hint={t("create.seedLiveHint", { symbol: COLLATERAL_SYMBOL })}
              error={attempted || amount.trim().length > 0 ? seedError : undefined}
            >
              <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="num text-right" />
            </Field>
          </section>

          <Button type="submit" className="h-12 w-full" disabled={busy || !publicKey}>
            {busy ? t("state.confirming") : publicKey ? t("create.submit") : t("create.connectFirst")}
          </Button>
        </form>
      </div>
      <aside className="desk-rail stack-3">
        <div className="section-title">{t("create.preview")}</div>
        <FeatureCard
          title={title}
          yesPrice={0.5}
          expiry={Number.isFinite(expiryUnix) ? expiryUnix : undefined}
          liquidity={t("create.previewSeed", { amount: amount || "0", symbol: COLLATERAL_SYMBOL })}
          threshold={previewThreshold}
        />
      </aside>
    </div>
  );
}
