"use client";

import { useEffect, useRef } from "react";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  c: string;
};

const COLORS = ["#7af0ff", "#34d399", "#fb7185", "#c4b5fd", "#ffffff"];

export function Ambience() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const mouse = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.28, tx: 0.5, ty: 0.28 };
    const trail: { x: number; y: number }[] = [];
    let particles: Particle[] = [];
    let frame = 0;
    let running = true;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(140, (w * h) / 14000));
      particles = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.8 + 0.4,
        c: COLORS[(Math.random() * COLORS.length) | 0],
      }));
    };

    const onMove = (e: PointerEvent) => {
      mouse.tx = e.clientX;
      mouse.ty = e.clientY;
    };

    const draw = () => {
      if (!running) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      mouse.x += (mouse.tx - mouse.x) * 0.08;
      mouse.y += (mouse.ty - mouse.y) * 0.08;
      trail.push({ x: mouse.x, y: mouse.y });
      if (trail.length > 18) trail.shift();

      ctx.clearRect(0, 0, w, h);

      const g = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 420);
      g.addColorStop(0, "rgba(34, 211, 238, 0.14)");
      g.addColorStop(0.45, "rgba(52, 211, 153, 0.05)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      if (trail.length > 2) {
        ctx.beginPath();
        ctx.moveTo(trail[0].x, trail[0].y);
        for (let i = 1; i < trail.length; i += 1) ctx.lineTo(trail[i].x, trail[i].y);
        ctx.strokeStyle = "rgba(122, 240, 255, 0.18)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const dist = Math.hypot(dx, dy) || 1;
        if (dist < 280) {
          p.vx += (dx / dist) * 0.012;
          p.vy += (dy / dist) * 0.012;
        }
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.99;
        p.vy *= 0.99;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        p.x = Math.max(0, Math.min(w, p.x));
        p.y = Math.max(0, Math.min(h, p.y));
      }

      for (let i = 0; i < particles.length; i += 1) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j += 1) {
          const b = particles[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 110) {
            ctx.strokeStyle = `rgba(122, 240, 255, ${((110 - d) / 110) * 0.12})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      for (const p of particles) {
        ctx.beginPath();
        ctx.fillStyle = p.c;
        ctx.globalAlpha = 0.55;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      frame = requestAnimationFrame(draw);
    };

    resize();
    mouse.tx = window.innerWidth * 0.5;
    mouse.ty = window.innerHeight * 0.28;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("resize", resize);
    const onVis = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frame);
      } else if (!running) {
        running = true;
        frame = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    frame = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <>
      <canvas ref={ref} className="ambience-canvas pointer-events-none fixed inset-0 -z-10 h-full w-full" aria-hidden />
      <div className="pointer-events-none fixed inset-0 -z-10 grid-veil" aria-hidden />
      <div className="pointer-events-none fixed inset-0 z-[60] noise" aria-hidden />
    </>
  );
}
