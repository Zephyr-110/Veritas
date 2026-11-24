"use client";

import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000, until = Infinity): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const current = () => Math.floor(Date.now() / 1000);
    setNow(current());
    if (current() >= until) return;
    const id = setInterval(() => {
      const time = current();
      setNow(time);
      if (time >= until) clearInterval(id);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, until]);
  return now;
}
