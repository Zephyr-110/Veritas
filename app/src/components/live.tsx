"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "@/i18n/provider";
import { countdown } from "@/lib/format";
import { cx } from "./ui";

export function FlashNum({
  value,
  children,
  className,
}: {
  value: number;
  children: ReactNode;
  className?: string;
}) {
  const prev = useRef(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (value === prev.current) return;
    const next = value > prev.current ? "up" : "down";
    prev.current = value;
    setDir(next);
    const id = window.setTimeout(() => setDir(null), 650);
    return () => window.clearTimeout(id);
  }, [value]);

  return (
    <span className={cx("num inline-block", dir === "up" && "flash-up", dir === "down" && "flash-down", className)}>
      {children}
    </span>
  );
}

export function LiveCountdown({
  expiry,
  now,
  className,
}: {
  expiry: number;
  now: number;
  className?: string;
}) {
  const t = useT();
  const text = countdown(expiry, now);
  const prev = useRef(text);
  const [ticked, setTicked] = useState(false);

  useEffect(() => {
    if (prev.current === text) return;
    prev.current = text;
    setTicked(true);
    const id = window.setTimeout(() => setTicked(false), 180);
    return () => window.clearTimeout(id);
  }, [text]);

  const ended = text === t("time.ended");
  const head = ended ? text : text.slice(0, -2);
  const tail = ended ? "" : text.slice(-2);

  return (
    <span className={cx("num font-mono tabular-nums", className)} aria-live="polite">
      {head}
      {tail ? <span className={cx("inline-block", ticked && "tick")}>{tail}</span> : null}
    </span>
  );
}

export function CountUp({
  value,
  format,
  duration = 1000,
}: {
  value: number;
  format: (v: number) => string;
  duration?: number;
}) {
  const [display, setDisplay] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      setDisplay(value);
      return;
    }
    started.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      setDisplay(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <>{format(display)}</>;
}
