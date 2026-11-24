"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  COLLATERAL_SYMBOL,
  MIN_CREATE_COLLATERAL,
  MIN_CREATE_SOL_LAMPORTS,
  PREDICTION_BYTES,
} from "@/lib/constants";
import { countdown, encodePrediction, formatFixed, formatStamp, fromUi, randomMarketId, toUi, utf8Len } from "@/lib/format";
import { FEEDS, feedByKey, formatFeedPrice, humanToThreshold } from "@/lib/feeds";
import { findMarketPdas } from "@/lib/pdas";
import { ataOf, fetchMintMeta, unpackAmount } from "@/lib/tokens";
import { ixCreateMarket } from "@/lib/instructions";
import { localizeError } from "@/lib/errors";
import { useFeeds } from "@/hooks/use-feeds";
import { useNow } from "@/hooks/use-now";
import { useProgram } from "@/hooks/use-program";
import { useRefresh, useSettings, useToasts } from "@/components/providers";
import { FeatureCard } from "@/components/market-card";
import { PriceAge } from "@/components/price-age";
import { Button, Reveal, StableText, TextInput, choiceClass, onSpot, openWalletModal, useTx } from "@/components/ui";
import { useGuestSession } from "@/components/guest-session";
import { useI18n, useT } from "@/i18n/provider";
import type { FeedKey } from "@/lib/types";

const PRESETS = [
  { id: "5m", key: "create.preset5m" as const, ms: 5 * 60 * 1000 },
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
  const stamp = formatStamp(expiry);
  if (locale === "zh") {
    return symbol + " " + stamp + " " + (above ? "能站上" : "会跌破") + " " + grouped + " 吗？";
  }
  return symbol + " " + (above ? "above" : "below") + " " + grouped + " at " + stamp + "?";
}

function parseSeed(amount: string): bigint | null {
  try {
    return fromUi(amount, 6);
  } catch {
    return null;
  }
}

function spotInputValue(price: number): string {
  if (price >= 1000) return String(Math.round(price));
  if (price >= 10) return price.toFixed(2).replace(/\.?0+$/, "");
  return price.toFixed(4).replace(/\.?0+$/, "");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function Row({
  labelKey,
  error,
  hintKey,
  hintVars,
  children,
}: {
  labelKey: string;
  error?: ReactNode;
  hintKey?: string;
  hintVars?: Record<string, string | number>;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 sm:flex-row sm:gap-4">
      <span className="shrink-0 text-sm text-zinc-400 sm:w-40 sm:pt-2">
        <StableText k={labelKey} />
      </span>
      <div className="stack-2 w-full min-w-0 flex-1">
        {children}
        {error ? (
          <span className="text-[13px] leading-5 text-rose-400">{error}</span>
        ) : hintKey ? (
          <span className="field-hint">
            <StableText k={hintKey} vars={hintVars} block />
          </span>
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
  const { isSandbox, txPending, locked } = useGuestSession();
  const { settings } = useSettings();
  const { nonce } = useRefresh();
  const { busy, run } = useTx();
  const { push } = useToasts();
  const { quotes } = useFeeds();
  const now = useNow(1000);
  const t = useT();
  const { locale } = useI18n();

  const [feedKey, setFeedKey] = useState<FeedKey>("btc");
  const feed = feedByKey(feedKey);
  const [human, setHuman] = useState(feed.defaultHuman);
  const [above, setAbove] = useState(true);
  const [expiry, setExpiry] = useState<Date | null>(null);
  const [preset, setPreset] = useState("1h");
  const [exactOpen, setExactOpen] = useState(false);
  const [amount, setAmount] = useState("2");
  const [title, setTitle] = useState("");
  const [titleLocked, setTitleLocked] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const userThreshold = useRef(false);
  const lastAutoFeed = useRef<FeedKey | null>(null);

  useEffect(() => {
    setExpiry((prev) => prev ?? defaultExpiry());
  }, []);

  const [walletBalance, setWalletBalance] = useState<{ atoms: bigint; decimals: number } | null>(null);
  const [solLamports, setSolLamports] = useState<number | null>(null);
  useEffect(() => {
    if (!publicKey) {
      setWalletBalance(null);
      setSolLamports(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const lamports = await connection.getBalance(publicKey, "confirmed");
        if (!cancelled) setSolLamports(lamports);
      } catch {
        if (!cancelled) setSolLamports(null);
      }
    })();
    void (async () => {
      try {
        const mint = new PublicKey(settings.collateralMint.trim());
        const meta = await fetchMintMeta(connection, mint);
        const ata = ataOf(mint, publicKey, meta.tokenProgram);
        const info = await connection.getAccountInfo(ata);
        if (!cancelled) {
          setWalletBalance({ atoms: unpackAmount(ata, info, meta.tokenProgram), decimals: meta.decimals });
        }
      } catch {
        if (!cancelled) setWalletBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, settings.collateralMint, nonce]);
  const maxAmount = walletBalance ? toUi(walletBalance.atoms, walletBalance.decimals, walletBalance.decimals) : null;
  const solShort = Boolean(publicKey && solLamports !== null && solLamports < MIN_CREATE_SOL_LAMPORTS);

  const autoTitle = useMemo(() => {
    const exp = expiry ?? defaultExpiry();
    return buildTitle(t(feed.labelKey), human, above, exp, locale);
  }, [t, feed.labelKey, human, above, expiry, locale]);

  const effectiveTitle = titleLocked ? title : autoTitle;
  const bytes = utf8Len(effectiveTitle);

  const applyPreset = (id: string, ms: number) => {
    setPreset(id);
    const next = new Date(Date.now() + ms);
    next.setSeconds(0, 0);
    setExpiry(next);
  };

  const applyExactParts = (dateStr: string, hourStr: string, minStr: string) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    const next = new Date(y, (m || 1) - 1, d || 1, Number(hourStr), Number(minStr), 0, 0);
    if (Number.isNaN(next.getTime())) return;
    setPreset("custom");
    setExpiry(next);
  };

  const exactDateOptions = useMemo(() => {
    const base = expiry ? new Date(expiry.getTime()) : defaultExpiry();
    const today = now > 0 ? new Date(now * 1000) : new Date(base.getTime());
    today.setHours(0, 0, 0, 0);
    const list: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const d = new Date(today.getTime());
      d.setDate(today.getDate() + i);
      list.push(dateKey(d));
    }
    const cur = dateKey(base);
    if (!list.includes(cur)) list.unshift(cur);
    return list;
  }, [expiry, now]);

  const onFeed = (key: FeedKey) => {
    userThreshold.current = false;
    const nextFeed = feedByKey(key);
    const q = quotes[key];
    const hasSpot = Boolean(q?.available && q.price != null);
    const nextHuman = hasSpot ? spotInputValue(q!.price!) : nextFeed.defaultHuman;
    lastAutoFeed.current = hasSpot ? key : null;
    setFeedKey(key);
    setHuman(nextHuman);
  };

  useEffect(() => {
    if (lastAutoFeed.current === feedKey) return;
    if (userThreshold.current) {
      lastAutoFeed.current = feedKey;
      return;
    }
    const q = quotes[feedKey];
    if (q?.available && q.price != null) {
      setHuman(spotInputValue(q.price));
      lastAutoFeed.current = feedKey;
    }
  }, [feedKey, quotes]);

  const expiryUnix = expiry ? Math.floor(expiry.getTime() / 1000) : 0;
  const seedAtoms = parseSeed(amount);
  const questionErrorKey = !effectiveTitle.trim()
    ? "create.needQuestionBody"
    : bytes > PREDICTION_BYTES
      ? "create.tooLongBody"
      : "";
  const expiryErrorKey = !expiry
    ? ""
    : !Number.isFinite(expiryUnix) || (now > 0 && expiryUnix <= now)
      ? "create.laterBody"
      : "";
  let thresholdErrorKey = "";
  try {
    humanToThreshold(human, feed.decimals);
  } catch {
    thresholdErrorKey = "create.thresholdInvalid";
  }
  const seedErrorKey =
    seedAtoms == null || seedAtoms < MIN_CREATE_COLLATERAL ? "create.needPoolBody" : "";

  const spot = quotes[feedKey];
  const applySpot = () => {
    if (!spot?.available || spot.price == null) return;
    userThreshold.current = false;
    setHuman(spotInputValue(spot.price));
  };

  const displayHuman = useMemo(() => {
    const n = Number(human);
    return human.trim() && Number.isFinite(n) ? n.toLocaleString("en-US") : human;
  }, [human]);

  const submit = async () => {
    if (isSandbox) {
      openWalletModal();
      return;
    }
    setAttempted(true);
    if (!expiry || questionErrorKey || expiryErrorKey || thresholdErrorKey || seedErrorKey || solShort) return;
    if (!publicKey) {
      openWalletModal();
      return;
    }
    if (!program) {
      push("err", t("create.createFailed"), t("errors.badAddress"));
      return;
    }
    try {
      const threshold = humanToThreshold(human, feed.decimals);
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
          ocr2State: new PublicKey(feed.state),
          marketId,
          prediction: encodePrediction(effectiveTitle.trim()),
          expiry: expiryUnix,
          collateralAmount,
          threshold,
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
        <h1 className="page-title">
          <StableText k="create.title" />
        </h1>
        <form
          className="stack-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Reveal>
            <section onMouseMove={onSpot} className="surface stack-6 p-5">
              <div className="stack-2">
                <span className="text-[13px] font-medium text-zinc-500">
                  <StableText k="create.question" />
                </span>
                <input
                  value={effectiveTitle}
                  onChange={(e) => {
                    setTitleLocked(true);
                    setTitle(e.target.value);
                  }}
                  placeholder={t("create.placeholder")}
                  className="w-full border-b border-[var(--line)] bg-transparent pb-2 text-lg font-medium text-white outline-none transition-colors placeholder:text-zinc-600 focus:border-[var(--accent)]"
                />
                <div className="flex items-baseline justify-between gap-3">
                  {attempted && questionErrorKey ? (
                    <span className="text-[13px] leading-5 text-rose-400">
                      <StableText k={questionErrorKey} />
                    </span>
                  ) : (
                    <span className="field-hint">
                      <StableText k="create.titleHint" block />
                    </span>
                  )}
                  <span
                    className={`num shrink-0 text-xs ${bytes > PREDICTION_BYTES ? "text-rose-400" : "text-zinc-500"}`}
                  >
                    <StableText k="create.byteCount" vars={{ bytes, max: PREDICTION_BYTES }} align="end" />
                  </span>
                </div>
              </div>

              <p className="text-lg font-medium leading-relaxed text-zinc-200">
                <span className="text-white">{feed.symbol}</span>
                {" · "}
                <StableText k="create.sayWhen" vars={{ stamp: expiry ? formatStamp(expiry) : "---- -- -- --:--" }} />
                {" · "}
                <span className="num text-white">
                  <StableText k="create.sayIf" vars={{ op: above ? "≥" : "<", threshold: displayHuman }} />
                </span>
                {" → "}
                <span className="font-semibold text-[var(--yes)]">
                  <StableText k="create.sayThen" />
                </span>
              </p>

              <div className="hairline" />

              <div className="stack-4">
                <Row labelKey="create.feed" hintKey="create.feedHint">
                  <div className="flex flex-wrap gap-2">
                    {FEEDS.filter((item) => item.market).map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => onFeed(item.key)}
                        className={choiceClass(feedKey === item.key) + " choice-sm"}
                      >
                        {item.symbol}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row labelKey="create.direction">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setAbove(true)}
                      className={choiceClass(above) + " choice-sm"}
                    >
                      <StableText k="create.directionAbove" align="center" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setAbove(false)}
                      className={choiceClass(!above) + " choice-sm"}
                    >
                      <StableText k="create.directionBelow" align="center" />
                    </button>
                  </div>
                </Row>
                <Row
                  labelKey="create.threshold"
                  error={attempted && thresholdErrorKey ? <StableText k={thresholdErrorKey} /> : undefined}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div style={{ width: "11rem" }}>
                      <TextInput
                        inputMode="decimal"
                        value={human}
                        onChange={(e) => {
                          userThreshold.current = true;
                          setHuman(e.target.value);
                        }}
                        className="num text-right"
                      />
                    </div>
                    {spot?.available && spot.price != null ? (
                      <>
                        <button type="button" onClick={applySpot} className={choiceClass(false) + " choice-sm num"}>
                          <StableText k="create.spotNow" vars={{ price: formatFeedPrice(spot.price) }} align="center" />
                        </button>
                        <PriceAge publishTime={spot.publishTime} className="min-w-[4.5rem] text-left text-[11px]" />
                      </>
                    ) : null}
                  </div>
                </Row>
              </div>
            </section>
          </Reveal>

          <Reveal>
            <section onMouseMove={onSpot} className="surface stack-6 p-5">
              <Row
                labelKey="create.tradingEnds"
                error={attempted && expiryErrorKey ? <StableText k={expiryErrorKey} /> : undefined}
              >
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => applyPreset(item.id, item.ms)}
                      className={choiceClass(preset === item.id) + " choice-sm"}
                    >
                      <StableText k={item.key} align="center" />
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-zinc-500">
                  <StableText
                    k="create.endsAt"
                    vars={{
                      stamp: expiry ? formatStamp(expiry) : "---- -- -- --:--",
                      left: expiry && now > 0 ? countdown(expiryUnix, now) : "--:--:--",
                    }}
                  />
                  <button
                    type="button"
                    className="link-accent"
                    onClick={() => setExactOpen((v) => !v)}
                  >
                    <StableText k="create.exact" align="center" />
                  </button>
                </div>
                {exactOpen ? (() => {
                  const base = expiry ?? defaultExpiry();
                  const curDate = dateKey(base);
                  const curHour = pad2(base.getHours());
                  const curMin = pad2(base.getMinutes());
                  const selectCls =
                    "num field h-10 border border-zinc-700 px-2.5 text-sm text-white outline-none";
                  return (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <select
                        aria-label={t("create.tradingEnds")}
                        value={curDate}
                        onChange={(e) => applyExactParts(e.target.value, curHour, curMin)}
                        className={selectCls}
                      >
                        {exactDateOptions.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                      <div className="flex items-center gap-1.5">
                        <select
                          aria-label={t("create.hour")}
                          value={curHour}
                          onChange={(e) => applyExactParts(curDate, e.target.value, curMin)}
                          className={selectCls}
                        >
                          {Array.from({ length: 24 }, (_, h) => pad2(h)).map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                        <span className="text-xs text-zinc-400">
                          <StableText k="create.hour" />
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <select
                          aria-label={t("create.minute")}
                          value={curMin}
                          onChange={(e) => applyExactParts(curDate, curHour, e.target.value)}
                          className={selectCls}
                        >
                          {Array.from({ length: 60 }, (_, m) => pad2(m)).map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                        <span className="text-xs text-zinc-400">
                          <StableText k="create.minute" />
                        </span>
                      </div>
                    </div>
                  );
                })() : null}
              </Row>
              <div className="hairline" />
              <Row
                labelKey="create.groupSeed"
                hintKey="create.seedLiveHint"
                hintVars={{ symbol: COLLATERAL_SYMBOL }}
                error={
                  (attempted || amount.trim().length > 0) && seedErrorKey ? (
                    <StableText k={seedErrorKey} vars={{ symbol: COLLATERAL_SYMBOL }} />
                  ) : undefined
                }
              >
                <div className="stack-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div style={{ width: "11rem" }}>
                      <TextInput
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="num text-right"
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
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
                      <button
                        type="button"
                        disabled={!maxAmount}
                        onClick={() => maxAmount && setAmount(maxAmount)}
                        className={choiceClass(maxAmount != null && amount === maxAmount) + " choice-sm"}
                      >
                        <StableText k="common.max" align="center" />
                      </button>
                    </div>
                  </div>
                  {publicKey && walletBalance ? (
                    <div className="text-right text-xs text-zinc-500">
                      <StableText
                        k="common.balance"
                        vars={{
                          amount: `${formatFixed(walletBalance.atoms, walletBalance.decimals, 2)} ${COLLATERAL_SYMBOL}`,
                        }}
                        align="end"
                      />
                    </div>
                  ) : null}
                </div>
              </Row>
            </section>
          </Reveal>

          {solShort && solLamports !== null ? (
            <p className="text-[13px] leading-5 text-rose-400">
              <StableText k="create.insufficientSol" vars={{ sol: (solLamports / 1e9).toFixed(4) }} block />
            </p>
          ) : null}

          <div className="max-w-xs">
            <Button
              type="submit"
              className="h-12 w-full"
              busy={busy || (isSandbox && locked)}
              disabled={busy || (isSandbox ? locked : solShort)}
              aria-describedby={isSandbox ? "create-sandbox-note" : undefined}
            >
              <StableText
                k={
                  busy
                    ? "state.confirming"
                    : isSandbox
                      ? "create.sandboxSubmit"
                      : !publicKey
                        ? "create.connectFirst"
                        : solShort
                          ? "create.needSolBtn"
                          : "create.submit"
                }
                align="center"
              />
            </Button>
          </div>
          {isSandbox ? (
            <div id="create-sandbox-note" className="stack-1.5">
              {locked ? (
                <p role="status" className="text-[13px] leading-relaxed text-[var(--warn)]">
                  <StableText
                    k={txPending ? "create.sandboxLockedTx" : "create.sandboxLockedEntering"}
                    block
                  />
                </p>
              ) : null}
              <p className="text-[13px] leading-relaxed text-zinc-400">
                <StableText k="create.sandboxHint" block />
              </p>
            </div>
          ) : !publicKey ? (
            <p className="text-[13px] leading-relaxed text-zinc-400">
              <StableText k="create.readOnlyHint" />{" "}
              <Link href="/markets" className="link-accent">
                <StableText k="create.readOnlyCta" />
              </Link>
            </p>
          ) : null}
        </form>
      </div>
      <aside className="desk-rail stack-3">
        <div className="section-title">
          <StableText k="create.preview" />
        </div>
        <FeatureCard
          title={effectiveTitle}
          yesPrice={0.5}
          expiry={expiry && Number.isFinite(expiryUnix) ? expiryUnix : undefined}
          liquidity={t("create.previewSeed", {
            amount: seedAtoms != null ? formatFixed(seedAtoms, 6, 2) : "0.00",
            symbol: COLLATERAL_SYMBOL,
          })}
          threshold={previewThreshold}
        />
        <div onMouseMove={onSpot} className="surface stack-2 p-5">
          <div className="section-title">
            <StableText k="create.notesTitle" />
          </div>
          <p className="text-[13px] leading-5 text-zinc-400">
            <StableText k="markets.rule1" block />
          </p>
          <p className="text-[13px] leading-5 text-zinc-400">
            <StableText k="markets.rule2" block />
          </p>
          <p className="text-[13px] leading-5 text-zinc-400">
            <StableText k="create.noteFinal" block />
          </p>
        </div>
      </aside>
    </div>
  );
}
