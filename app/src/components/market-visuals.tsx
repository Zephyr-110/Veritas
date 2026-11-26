"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchCandles, type Candle } from "@/lib/chart";
import { formatCents } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import { pmAmmAccrue, pmAmmQuoteBet } from "@/lib/quote";
import { useNow } from "@/hooks/use-now";
import { Card, StableText } from "@/components/ui";
import { useT } from "@/i18n/provider";

function fmtPrice(v: number): string {
  if (v >= 1000) return Math.round(v).toLocaleString("en-US");
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtTime(unix: number): string {
  const d = new Date(unix * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function aggregateCandles(candles: Candle[], maxCount = 60): Candle[] {
  if (candles.length <= maxCount) return candles;
  const size = Math.ceil(candles.length / maxCount);
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += size) {
    const bucket = candles.slice(i, i + size);
    out.push({
      time: bucket[0].time,
      open: bucket[0].open,
      high: Math.max(...bucket.map((c) => c.high)),
      low: Math.min(...bucket.map((c) => c.low)),
      close: bucket[bucket.length - 1].close,
    });
  }
  return out;
}

export function PriceChartCard({
  pair,
  symbol,
  expiry,
  durationSec,
  thresholdValue,
  thresholdLabel,
}: {
  pair: string;
  symbol: string;
  expiry: number;
  durationSec?: number | null;
  thresholdValue: number;
  thresholdLabel: string;
}) {
  const t = useT();
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await fetchCandles(pair, expiry, Math.floor(Date.now() / 1000), durationSec);
        if (alive) {
          setCandles(aggregateCandles(data));
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pair, expiry, durationSec]);

  const body = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    const W = 720;
    const H = 152;
    const padL = 6;
    const padR = 64;
    const padT = 31;
    const padB = 20;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of candles) {
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
    }
    const dataSpan = hi - lo || 1;
    if (thresholdValue > hi) hi = Math.min(thresholdValue, hi + dataSpan * 0.25);
    if (thresholdValue < lo) lo = Math.max(thresholdValue, lo - dataSpan * 0.25);
    const span = hi - lo || 1;
    lo -= span * 0.07;
    hi += span * 0.07;
    const y = (v: number) => padT + ((hi - v) / (hi - lo)) * plotH;
    const step = plotW / candles.length;
    const bodyW = Math.max(1, Math.min(10, step * 0.62));
    const t0 = candles[0].time;
    const gran = candles.length > 1 ? Math.max(60, candles[1].time - candles[0].time) : 60;
    const t1 = candles[candles.length - 1].time + gran;
    const xTime = (unix: number) => padL + ((unix - t0) / (t1 - t0)) * plotW;
    const thrY = Math.max(padT, Math.min(padT + plotH, y(thresholdValue)));

    const expX = Math.max(padL + 20, Math.min(padL + plotW - 20, xTime(expiry)));
    const last = candles[candles.length - 1];
    const lastColor = last.close >= thresholdValue ? "var(--yes)" : "var(--no)";
    const ticks = [0, 1, 2, 3].map((i) => t0 + ((t1 - t0) * (i + 0.5)) / 4);
    const tagText = `${t("chart.thresholdTag")} ${thresholdLabel}`;
    const pillW = Math.ceil([...tagText].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 11 : 6.4), 14));
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img">
        <rect x={padL} y={padT} width={plotW} height={Math.max(0, thrY - padT)} fill="var(--yes)" opacity={0.045} />
        <rect x={padL} y={thrY} width={plotW} height={Math.max(0, padT + plotH - thrY)} fill="var(--no)" opacity={0.045} />
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={padL}
            x2={padL + plotW}
            y1={padT + plotH * f}
            y2={padT + plotH * f}
            stroke="var(--hair)"
            strokeDasharray="3 5"
          />
        ))}
        {candles.map((c, i) => {
          const color = c.close >= thresholdValue ? "var(--yes)" : "var(--no)";
          const cx = padL + step * (i + 0.5);
          const yOpen = y(c.open);
          const yClose = y(c.close);
          return (
            <g key={c.time}>
              <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth={1} opacity={0.55} />
              <rect
                x={cx - bodyW / 2}
                y={Math.min(yOpen, yClose)}
                width={bodyW}
                height={Math.max(2, Math.abs(yClose - yOpen))}
                fill={color}
                opacity={0.9}
              />
            </g>
          );
        })}
        <line
          x1={padL}
          x2={padL + plotW}
          y1={thrY}
          y2={thrY}
          stroke="var(--ink-strong)"
          strokeWidth={1}
          strokeDasharray="6 4"
          opacity={0.48}
        />
        <g data-threshold-pill="true">
          <rect
            x={padL}
            y={2}
            width={pillW}
            height={18}
            rx={3}
            fill="var(--card-bg)"
            stroke="var(--line)"
            strokeWidth={1}
          />
          <text
            x={padL + 7}
            y={14.5}
            fontSize={10.5}
            fontWeight={500}
            fill="var(--ink-strong)"
            textAnchor="start"
            className="num"
          >
            {tagText}
          </text>
        </g>
        <text x={padL + plotW + 8} y={y(hi - (hi - lo) * 0.02) + 3} fontSize={10} fill="var(--ink-3)" className="num">
          {fmtPrice(hi)}
        </text>
        <text x={padL + plotW + 8} y={y(lo + (hi - lo) * 0.02) + 3} fontSize={10} fill="var(--ink-3)" className="num">
          {fmtPrice(lo)}
        </text>
        {expiry >= t0 && expiry <= t1 ? (
          <g>
            <line
              x1={xTime(expiry)}
              x2={xTime(expiry)}
              y1={padT}
              y2={padT + plotH}
              stroke="var(--line)"
              strokeDasharray="3 4"
            />
            <text
              x={expX - 6 - 34 < padL ? expX + 6 : expX - 6}
              y={padT - 3}
              fontSize={10}
              fill="var(--ink-2)"
              textAnchor={expX - 6 - 34 < padL ? "start" : "end"}
            >
              {t("chart.expiryTag")}
            </text>
          </g>
        ) : null}
        <circle cx={padL + step * (candles.length - 0.5)} cy={y(last.close)} r={7} fill={lastColor} opacity={0.22} />
        <circle
          cx={padL + step * (candles.length - 0.5)}
          cy={y(last.close)}
          r={3.5}
          fill="none"
          stroke={lastColor}
          strokeWidth={1.2}
          className="pulse-ring"
        />
        <circle cx={padL + step * (candles.length - 0.5)} cy={y(last.close)} r={3} fill={lastColor} />
        {ticks.map((unix) => (
          <text key={unix} x={xTime(unix)} y={H - 5} fontSize={10} fill="var(--ink-3)" textAnchor="middle" className="num">
            {fmtTime(Math.round(unix))}
          </text>
        ))}
      </svg>
    );
  }, [candles, expiry, thresholdValue, thresholdLabel, t]);

  return (
    <Card className="stack-3 enter-up">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="section-title">
          {symbol} · <StableText k="chart.title" />
        </div>
        <div className="text-[11px] text-zinc-500">
          <StableText k="chart.source" align="end" />
        </div>
      </div>
      {failed ? (
        <div className="grid aspect-[720/152] place-items-center text-sm text-zinc-500">
          <StableText k="chart.unavailable" align="center" />
        </div>
      ) : body ?? <div className="sk aspect-[720/152]" />}
    </Card>
  );
}

export function LiquidityCard({ market }: { market: MarketView }) {
  const t = useT();
  const now = useNow(5000);
  const [hover, setHover] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const ts = now > 0 ? now : market.lastAccrualTs;
  const model = useMemo(() => {
    const accrued = pmAmmAccrue(market, ts);
    if (accrued.reserveYes <= 0 || accrued.reserveNo <= 0 || accrued.lEff <= 0) return null;
    const unit = 10 ** market.decimals;
    const vaultU = Number(market.vault) / unit;
    const poolU = (accrued.reserveYes + accrued.reserveNo) / (2 * unit);
    const maxX = Math.min(500, Math.max(4, (vaultU > 0 ? vaultU : poolU) * 2));
    const N = 40;
    const points: { amount: number; price: number }[] = [];
    for (let i = 0; i <= N; i += 1) {
      const amount = (maxX * i) / N;
      if (i === 0) {
        points.push({ amount: 0, price: accrued.yesPrice });
        continue;
      }
      const q = pmAmmQuoteBet(
        accrued.reserveYes,
        accrued.reserveNo,
        accrued.lEff,
        amount * unit,
        "yes",
        market.feeBps
      );
      points.push({ amount, price: q.postYesPrice });
    }
    const yesPct = (accrued.reserveYes / (accrued.reserveYes + accrued.reserveNo)) * 100;
    return { points, maxX, yesPct, current: points[0].price };
  }, [market, ts]);

  if (!model) return null;
  const active = hover != null ? model.points[hover] : null;

  const W = 640;
  const H = 200;
  const padL = 6;
  const padR = 8;
  const padT = 12;
  const padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const prices = model.points.map((p) => p.price);
  const yLo = Math.max(0, Math.min(0.45, Math.min(...prices) - 0.03));
  const yHi = Math.min(1, Math.max(0.6, Math.max(...prices) + 0.03));
  const x = (amount: number) => padL + (amount / model.maxX) * plotW;
  const y = (price: number) => padT + ((yHi - price) / (yHi - yLo)) * plotH;
  const line = model.points.map((p) => `${x(p.amount)},${y(p.price)}`).join(" ");
  const area = `${padL},${padT + plotH} ${line} ${padL + plotW},${padT + plotH}`;

  return (
    <Card className="stack-4">
      <div className="section-title">
        <StableText k="liq.title" />
      </div>

      <div className="stack-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[13px] text-zinc-400">
            <StableText k="liq.impact" />
          </div>
          <div className="num whitespace-nowrap text-[13px] text-zinc-200">
            {active
              ? t("liq.impactReadout", {
                  amount: `${active.amount < 1 ? active.amount.toFixed(2) : active.amount.toFixed(1)} U`,
                  price: formatCents(active.price),
                })
              : t("liq.impactNow", { price: formatCents(model.current) })}
          </div>
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full"
          role="img"
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const frac = (e.clientX - rect.left) / rect.width;
            const idx = Math.round(frac * (model.points.length - 1));
            setHover(Math.max(0, Math.min(model.points.length - 1, idx)));
          }}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="impact-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.07} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <polygon points={area} fill="url(#impact-fill)" className="fade-in" style={{ animationDelay: "300ms" }} />
          <polyline
            points={line}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.25}
            opacity={0.85}
            pathLength={1}
            strokeDasharray={1}
            className="draw-line"
          />
          <circle cx={x(0)} cy={y(model.current)} r={3} fill="var(--accent)" />
          {active ? (
            <g>
              <line
                x1={x(active.amount)}
                x2={x(active.amount)}
                y1={padT}
                y2={padT + plotH}
                stroke="var(--line)"
                strokeDasharray="3 3"
              />
              <circle
                cx={x(active.amount)}
                cy={y(active.price)}
                r={3.5}
                fill="var(--ink-strong)"
                stroke="var(--bg)"
                strokeWidth={1.5}
              />
            </g>
          ) : null}
          <text x={padL} y={H - 4} fontSize={11} fill="var(--ink-3)" className="num">
            0
          </text>
          <text x={padL + plotW} y={H - 4} fontSize={11} fill="var(--ink-3)" textAnchor="end" className="num">
            {model.maxX.toFixed(0)} U
          </text>
          <text x={padL + 2} y={y(yHi) + 8} fontSize={11} fill="var(--ink-3)" className="num">
            {formatCents(yHi)}
          </text>
        </svg>
      </div>

      <div className="stack-2">
        <div className="flex items-baseline justify-between text-[13px]">
          <span className="text-zinc-400">
            <StableText k="liq.reserves" />
          </span>
          {(() => {
            const yesTenths = Math.max(0, Math.min(1000, Math.round(model.yesPct * 10)));
            const noTenths = 1000 - yesTenths;
            return (
              <span className="num text-zinc-400">
                <span style={{ color: "var(--yes)" }}>{t("liq.yes")} {(yesTenths / 10).toFixed(1)}%</span>
                {" · "}
                <span style={{ color: "var(--no)" }}>{t("liq.no")} {(noTenths / 10).toFixed(1)}%</span>
              </span>
            );
          })()}
        </div>
        <div className="flex h-2 overflow-hidden bg-zinc-800">
          <div
            className="h-full"
            style={{
              width: mounted ? `${model.yesPct}%` : "0%",
              background: "var(--yes)",
              opacity: 0.78,
              transition: "width 700ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
          <div
            className="h-full"
            style={{
              width: mounted ? `${100 - model.yesPct}%` : "0%",
              background: "var(--no)",
              opacity: 0.78,
              transition: "width 700ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        </div>
      </div>

      <p className="text-xs leading-relaxed text-zinc-500">
        <StableText k="liq.note" block />
      </p>
    </Card>
  );
}
