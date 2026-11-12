"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchCandles, type Candle } from "@/lib/chart";
import { formatCents } from "@/lib/format";
import type { MarketView } from "@/lib/markets";
import { impliedYesPrice, quoteBet } from "@/lib/quote";
import { Card } from "@/components/ui";
import { useT } from "@/i18n/provider";

const UP = "#34d399";
const DOWN = "#fb7185";
const ACCENT = "#22d3ee";

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

export function PriceChartCard({
  pair,
  symbol,
  expiry,
  thresholdValue,
  thresholdLabel,
}: {
  pair: string;
  symbol: string;
  expiry: number;
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
        const data = await fetchCandles(pair, expiry, Math.floor(Date.now() / 1000));
        if (alive) {
          setCandles(data);
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
  }, [pair, expiry]);

  const body = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    const W = 720;
    const H = 252;
    const padL = 6;
    const padR = 64;
    const padT = 14;
    const padB = 20;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of candles) {
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
    }
    lo = Math.min(lo, thresholdValue);
    hi = Math.max(hi, thresholdValue);
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
    const thrY = y(thresholdValue);
    const last = candles[candles.length - 1];
    const lastColor = last.close >= thresholdValue ? UP : DOWN;
    const ticks = [0, 1, 2, 3].map((i) => t0 + ((t1 - t0) * (i + 0.5)) / 4);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img">
        <rect x={padL} y={padT} width={plotW} height={Math.max(0, thrY - padT)} fill={UP} opacity={0.05} />
        <rect x={padL} y={thrY} width={plotW} height={Math.max(0, padT + plotH - thrY)} fill={DOWN} opacity={0.05} />
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={padL}
            x2={padL + plotW}
            y1={padT + plotH * f}
            y2={padT + plotH * f}
            stroke="rgba(255,255,255,0.05)"
            strokeDasharray="3 5"
          />
        ))}
        {candles.map((c, i) => {
          const color = c.close >= thresholdValue ? UP : DOWN;
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
                height={Math.max(1, Math.abs(yClose - yOpen))}
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
          stroke="#e4e4e7"
          strokeWidth={1}
          strokeDasharray="6 4"
          opacity={0.55}
        />
        <text
          x={padL + plotW - 4}
          y={thrY - 6}
          fontSize={10.5}
          fill="#e4e4e7"
          textAnchor="end"
          stroke="#0B0E14"
          strokeWidth={3}
          paintOrder="stroke"
          className="num"
        >
          {t("chart.thresholdTag")} {thresholdLabel}
        </text>
        <text x={padL + plotW + 8} y={y(hi - (hi - lo) * 0.02) + 3} fontSize={10} fill="#71717a" className="num">
          {fmtPrice(hi)}
        </text>
        <text x={padL + plotW + 8} y={y(lo + (hi - lo) * 0.02) + 3} fontSize={10} fill="#71717a" className="num">
          {fmtPrice(lo)}
        </text>
        {expiry >= t0 && expiry <= t1 ? (
          <g>
            <line
              x1={xTime(expiry)}
              x2={xTime(expiry)}
              y1={padT}
              y2={padT + plotH}
              stroke="rgba(255,255,255,0.4)"
              strokeDasharray="3 4"
            />
            <text x={xTime(expiry)} y={padT - 4} fontSize={10} fill="#a1a1aa" textAnchor="middle">
              {t("chart.expiryTag")}
            </text>
          </g>
        ) : null}
        <circle cx={padL + step * (candles.length - 0.5)} cy={y(last.close)} r={7} fill={lastColor} opacity={0.25} />
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
          <text key={unix} x={xTime(unix)} y={H - 5} fontSize={10} fill="#63636b" textAnchor="middle" className="num">
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
          {symbol} · {t("chart.title")}
        </div>
        <div className="text-[11px] text-zinc-500">{t("chart.source")}{pair === "PAXG-USD" ? " · PAXG" : ""}</div>
      </div>
      {body ??
        (failed ? (
          <div className="grid h-[180px] place-items-center text-sm text-zinc-500">{t("chart.unavailable")}</div>
        ) : (
          <div className="h-[252px] animate-pulse rounded bg-white/[0.02]" />
        ))}
    </Card>
  );
}

export function LiquidityCard({ market }: { market: MarketView }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const model = useMemo(() => {
    const reserveYes = market.reserveYes;
    const reserveNo = market.reserveNo;
    if (reserveYes <= 0n || reserveNo <= 0n) return null;
    const unit = 10 ** market.decimals;
    const vaultU = Number(market.vault) / unit;
    const maxX = Math.min(500, Math.max(4, vaultU * 2));
    const N = 36;
    const points: { amount: number; price: number }[] = [];
    for (let i = 0; i <= N; i += 1) {
      const amount = (maxX * i) / N;
      if (i === 0) {
        points.push({ amount: 0, price: impliedYesPrice(reserveYes, reserveNo) });
        continue;
      }
      const aSmall = BigInt(Math.round(amount * unit));
      const { swapOut } = quoteBet(reserveYes, reserveNo, aSmall, "yes");
      const afterFee = (aSmall * 9970n) / 10000n;
      const postNo = reserveNo + afterFee;
      const postYes = reserveYes > swapOut ? reserveYes - swapOut : 0n;
      const sum = postYes + postNo;
      points.push({ amount, price: sum > 0n ? Number(postNo) / Number(sum) : 1 });
    }
    const yesNum = Number(reserveYes);
    const noNum = Number(reserveNo);
    const yesPct = (yesNum / (yesNum + noNum)) * 100;
    return { points, maxX, yesPct, current: points[0].price };
  }, [market]);

  if (!model) return null;
  const active = hover != null ? model.points[hover] : null;

  const W = 340;
  const H = 148;
  const padL = 6;
  const padR = 8;
  const padT = 10;
  const padB = 18;
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
      <div className="section-title">{t("liq.title")}</div>

      <div className="stack-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[13px] text-zinc-400">{t("liq.impact")}</div>
          <div className="num text-[13px] text-zinc-200">
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
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.22} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
            </linearGradient>
          </defs>
          <polygon points={area} fill="url(#impact-fill)" className="fade-in" style={{ animationDelay: "450ms" }} />
          <polyline points={line} fill="none" stroke={ACCENT} strokeWidth={1.6} pathLength={1} strokeDasharray={1} className="draw-line" />
          <circle cx={x(0)} cy={y(model.current)} r={3} fill={ACCENT} />
          {active ? (
            <g>
              <line
                x1={x(active.amount)}
                x2={x(active.amount)}
                y1={padT}
                y2={padT + plotH}
                stroke="rgba(255,255,255,0.25)"
                strokeDasharray="3 3"
              />
              <circle cx={x(active.amount)} cy={y(active.price)} r={3.5} fill="#fff" />
            </g>
          ) : null}
          <text x={padL} y={H - 4} fontSize={9.5} fill="#63636b" className="num">
            0
          </text>
          <text x={padL + plotW} y={H - 4} fontSize={9.5} fill="#63636b" textAnchor="end" className="num">
            {model.maxX.toFixed(0)} U
          </text>
          <text x={padL + 2} y={y(yHi) + 8} fontSize={9.5} fill="#63636b" className="num">
            {formatCents(yHi)}
          </text>
        </svg>
      </div>

      <div className="stack-2">
        <div className="flex items-baseline justify-between text-[13px]">
          <span className="text-zinc-400">{t("liq.reserves")}</span>
          <span className="num text-zinc-400">
            <span style={{ color: UP }}>{t("liq.yes")} {model.yesPct.toFixed(0)}%</span>
            {" · "}
            <span style={{ color: DOWN }}>{t("liq.no")} {(100 - model.yesPct).toFixed(0)}%</span>
          </span>
        </div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full"
            style={{
              width: mounted ? `${model.yesPct}%` : "0%",
              background: UP,
              opacity: 0.75,
              transition: "width 800ms cubic-bezier(0.34, 1.35, 0.64, 1)",
            }}
          />
          <div
            className="h-full"
            style={{
              width: mounted ? `${100 - model.yesPct}%` : "0%",
              background: DOWN,
              opacity: 0.75,
              transition: "width 800ms cubic-bezier(0.34, 1.35, 0.64, 1)",
            }}
          />
        </div>
      </div>

      <p className="text-xs leading-relaxed text-zinc-500">{t("liq.note")}</p>
    </Card>
  );
}
