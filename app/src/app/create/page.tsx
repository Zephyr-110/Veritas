"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { COLLATERAL_SYMBOL, MIN_CREATE_COLLATERAL, PREDICTION_BYTES } from "@/lib/constants";
import { countdown, encodePrediction, formatStamp, fromUi, randomMarketId, utf8Len } from "@/lib/format";
import { FEEDS, feedByKey, feedIdBytes, humanToThreshold } from "@/lib/feeds";
import { findMarketPdas } from "@/lib/pdas";
import { fetchMintMeta } from "@/lib/tokens";
import { ixCreateMarket } from "@/lib/instructions";
import { localizeError } from "@/lib/errors";
import { useFeeds } from "@/hooks/use-feeds";
import { useNow } from "@/hooks/use-now";
import { useProgram } from "@/hooks/use-program";
import { useSettings, useToasts } from "@/components/providers";
import { FeatureCard } from "@/components/market-card";
import { Button, Reveal, TextInput, choiceClass, useTx } from "@/components/ui";
import { useI18n, useT } from "@/i18n/provider";
import type { FeedKey } from "@/lib/types";

const PRESETS = [
  { id: "15m", key: "create.preset15m" as const, ms: 15 * 60 * 1000 },
  { id: "1h", key: "create.preset1h" as const, ms: 60 * 60 * 1000 },
  { id: "4h", key: "create.preset4h" as const, ms: 4 * 60 * 60 * 1000 },
  { id: "1d", key: "create.preset1d" as const, ms: 24 * 60 * 60 * 1000 },
];

const SEED_CHIPS = ["2", "5", "10", "50"];

function defaultExpiry(): Date {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  next.setSeconds(0, 0);
  return next;
}

function buildTitle(symbol: string, human: string, above: boolean, expiry: Date, locale: string): string {
  const grouped = /^\d+$/.test(human) ? human.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : human;
  const hh = String(expiry.getHours()).padStart(2, "0");
  const mm = String(expiry.getMinutes()).padStart(2, "0");
  if (locale === "zh") {
    return symbol + " " + (expiry.getMonth() + 1) + "月" + expiry.getDate() + "日 " + hh + ":" + mm + " " + (above ? "能站上" : "会跌破") + " " + grouped + " 吗？";
  }
  const mon = expiry.toLocaleString("en-US", { month: "short" });
  return symbol + " " + (above ? "above" : "below") + " " + grouped + " at " + hh + ":" + mm + " on " + mon + " " + expiry.getDate() + "?";
}

function parseSeed(amount: string): bigint | null {
  try {
    return fromUi(amount, 6);
  } catch {
    return null;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function Row({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-4">
      <span className="w-24 shrink-0 pt-2 text-sm text-zinc-400">{label}</span>
      <div className="stack-2 min-w-0 flex-1">
        {children}
        {error ? (
          <span className="text-[13px] leading-5 text-rose-400">{error}</span>
        ) : hint ? (
          <span className="field-hint">{hint}</span>
        ) : null}
      </div>
    </div>
  );
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
  const now = useNow(1000);
  const t = useT();
  const { locale } = useI18n();

  const [feedKey, setFeedKey] = useState<FeedKey>("btc");
  const feed = feedByKey(feedKey);
  const [human, setHuman] = useState(feed.defaultHuman);
  const [above, setAbove] = useState(true);
  const [expiry, setExpiry] = useState(defaultExpiry);
  const [preset, setPreset] = useState("1h");
  const [exactOpen, setExactOpen] = useState(false);
  const [amount, setAmount] = useState("2");
  const [title, setTitle] = useState(buildTitle(t(feed.labelKey), feed.defaultHuman, true, defaultExpiry(), locale));
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
    syncTitle(buildTitle(t(feed.labelKey), human, above, next, locale));
  };

  const applyExact = (value: string) => {
    const next = new Date(value);
    if (Number.isNaN(next.getTime())) return;
    next.setSeconds(0, 0);
    setPreset("custom");
    setExpiry(next);
    syncTitle(buildTitle(t(feed.labelKey), human, above, next, locale));
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
      if (!titleLocked) setTitle(buildTitle(t(feed.labelKey), rounded, above, expiry, locale));
      return;
    }
    if (ready) {
      setHuman(feed.defaultHuman);
      lastAutoFeed.current = feedKey;
      if (!titleLocked) setTitle(buildTitle(t(feed.labelKey), feed.defaultHuman, above, expiry, locale));
    }
  }, [feedKey, quotes, ready, feed.labelKey, feed.defaultHuman, above, expiry, titleLocked, t]);

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

  const spot = quotes[feedKey];
  const applySpot = () => {
    if (!spot?.available || spot.price == null) return;
    userThreshold.current = false;
    const rounded = String(Math.round(spot.price));
    setHuman(rounded);
    syncTitle(buildTitle(t(feed.labelKey), rounded, above, expiry, locale));
  };

  const displayHuman = useMemo(() => {
    const n = Number(human);
    return human.trim() && Number.isFinite(n) ? n.toLocaleString("en-US") : human;
  }, [human]);

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
          className="stack-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Reveal><section className="surface stack-6 p-5">
            <div className="stack-2">
              <span className="text-[13px] font-medium text-zinc-500">{t("create.question")}</span>
              <input
                value={title}
                onChange={(e) => {
                  setTitleLocked(true);
                  setTitle(e.target.value);
                }}
                placeholder={t("create.placeholder")}
                className="w-full border-b border-white/10 bg-transparent pb-2 text-lg font-medium text-white outline-none transition-colors placeholder:text-zinc-600 focus:border-cyan-400/50"
              />
              {attempted && questionError ? (
                <span className="text-[13px] leading-5 text-rose-400">{questionError}</span>
              ) : (
                <span className="field-hint">{t("create.titleHint")}</span>
              )}
            </div>

            <p className="text-xl font-medium leading-relaxed text-zinc-200">
              <span className="text-white">{t(feed.labelKey)}</span>
              {" · "}
              {t("create.sayWhen", { stamp: formatStamp(expiry) })}
              {" · "}
              <span className="num text-cyan-300">
                {t("create.sayIf", { op: above ? "≥" : "<", threshold: displayHuman })}
              </span>
              {" → "}
              <span className="font-semibold text-emerald-300">{t("create.sayThen")}</span>
            </p>

            <div className="hairline" />

            <div className="stack-4">
              <Row label={t("create.feed")} hint={t("create.feedHint")}>
                <div className="flex flex-wrap gap-2">
                  {FEEDS.filter((item) => item.market).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => onFeed(item.key)}
                      className={choiceClass(feedKey === item.key) + " choice-sm"}
                    >
                      {t(item.labelKey)}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label={t("create.direction")}>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAbove(true);
                      syncTitle(buildTitle(t(feed.labelKey), human, true, expiry, locale));
                    }}
                    className={choiceClass(above) + " choice-sm"}
                  >
                    {t("create.directionAbove")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAbove(false);
                      syncTitle(buildTitle(t(feed.labelKey), human, false, expiry, locale));
                    }}
                    className={choiceClass(!above) + " choice-sm"}
                  >
                    {t("create.directionBelow")}
                  </button>
                </div>
              </Row>
              <Row label={t("create.threshold")} error={attempted ? thresholdError : undefined}>
                <div className="flex flex-wrap items-center gap-2">
                  <div style={{ width: "11rem" }}>
                    <TextInput
                    inputMode="decimal"
                    value={human}
                    onChange={(e) => {
                      userThreshold.current = true;
                      setHuman(e.target.value);
                      syncTitle(buildTitle(t(feed.labelKey), e.target.value, above, expiry, locale));
                    }}
                    className="num text-right"
                    />
                  </div>
                  {spot?.available && spot.price != null ? (
                    <button type="button" onClick={applySpot} className={choiceClass(false) + " choice-sm num"}>
                      {t("create.spotNow", { price: Math.round(spot.price).toLocaleString("en-US") })}
                    </button>
                  ) : null}
                </div>
              </Row>
            </div>
          </section></Reveal>

          <Reveal><section className="surface stack-6 p-5">
            <Row label={t("create.tradingEnds")} error={attempted ? expiryError : undefined}>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => applyPreset(item.id, item.ms)}
                    className={choiceClass(preset === item.id) + " choice-sm"}
                  >
                    {t(item.key)}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-zinc-500">
                <span>{t("create.endsAt", { stamp: formatStamp(expiry), left: countdown(expiryUnix, now) })}</span>
                <button
                  type="button"
                  className="link-accent"
                  onClick={() => setExactOpen((v) => !v)}
                >
                  {t("create.exact")}
                </button>
              </div>
              {exactOpen ? (
                <div style={{ width: "16rem" }}>
                  <TextInput
                    type="datetime-local"
                    min={isoLocal(new Date())}
                    value={isoLocal(expiry)}
                    onChange={(e) => applyExact(e.target.value)}
                    className="num"
                  />
                </div>
              ) : null}
            </Row>
            <div className="hairline" />
            <Row
              label={t("create.groupSeed")}
              hint={t("create.seedLiveHint", { symbol: COLLATERAL_SYMBOL })}
              error={attempted || amount.trim().length > 0 ? seedError : undefined}
            >
              <div className="flex flex-wrap items-center gap-2">
                <div style={{ width: "11rem" }}>
                  <TextInput
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="num text-right"
                  />
                </div>
                <div className="flex gap-1.5">
                  {SEED_CHIPS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setAmount(v)}
                      className={choiceClass(amount === v) + " choice-sm num"}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </Row>
          </section></Reveal>

          <div className="max-w-xs">
            <Button type="submit" className="h-12 w-full" disabled={busy || !publicKey}>
            {busy ? t("state.confirming") : publicKey ? t("create.submit") : t("create.connectFirst")}
            </Button>
          </div>
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
        <div className="surface stack-2 p-4">
          <div className="section-title">{t("create.notesTitle")}</div>
          <p className="text-[13px] leading-5 text-zinc-400">{t("markets.rule1")}</p>
          <p className="text-[13px] leading-5 text-zinc-400">{t("markets.rule2")}</p>
          <p className="text-[13px] leading-5 text-zinc-400">{t("create.noteFinal")}</p>
        </div>
      </aside>
    </div>
  );
}
