"use client";

import { useEffect, useRef } from "react";

type Layer = 0 | 1 | 2;

type Particle = {
  x: number;
  y: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  r: number;
  layer: Layer;
  alpha: number;
  phase: number;
};

type Ripple = {
  x: number;
  y: number;
  start: number;
  maxR: number;
  dur: number;
};

const LAYER_PARALLAX = [0.06, 0.14, 0.24] as const;
const LAYER_SPEED = [0.14, 0.24, 0.36] as const;

export function Ambience() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let isLight = document.documentElement.dataset.theme === "light";

    const pointer = {
      x: window.innerWidth * 0.5,
      y: window.innerHeight * 0.35,
      tx: window.innerWidth * 0.5,
      ty: window.innerHeight * 0.35,
      active: false,
    };

    let scrollY = window.scrollY;
    let targetScrollY = window.scrollY;
    let width = window.innerWidth;
    let height = window.innerHeight;
    let particles: Particle[] = [];
    const ripples: Ripple[] = [];
    let frame = 0;
    let running = true;

    const buildParticles = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const total = Math.max(58, Math.min(135, Math.round((width * height) / 14500)));
      particles = Array.from({ length: total }, (_, idx) => {
        const layer: Layer = idx % 5 === 0 ? 2 : idx % 2 === 0 ? 1 : 0;
        const x = Math.random() * width;
        const y = Math.random() * height;
        const spd = LAYER_SPEED[layer];
        const angle = Math.random() * Math.PI * 2;
        return {
          x,
          y,
          ox: x,
          oy: y,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd,
          r: layer === 2 ? Math.random() * 1.35 + 1.15 : layer === 1 ? Math.random() * 0.9 + 0.75 : Math.random() * 0.7 + 0.45,
          layer,
          alpha: layer === 2 ? 0.52 : layer === 1 ? 0.34 : 0.2,
          phase: Math.random() * Math.PI * 2,
        };
      });
    };

    const onPointerMove = (e: PointerEvent) => {
      pointer.tx = e.clientX;
      pointer.ty = e.clientY;
      pointer.active = true;
    };

    const onPointerLeave = () => {
      pointer.active = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      ripples.push({
        x: e.clientX,
        y: e.clientY,
        start: performance.now(),
        maxR: 260,
        dur: 680,
      });
      if (ripples.length > 4) ripples.shift();
      for (const p of particles) {
        const py = p.y - scrollY * LAYER_PARALLAX[p.layer];
        const wrappedY = ((py % height) + height) % height;
        const dx = p.x - e.clientX;
        const dy = wrappedY - e.clientY;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1 && d2 < 240 * 240) {
          const d = Math.sqrt(d2);
          const force = (1 - d / 240) * (p.layer === 2 ? 1.45 : 0.9);
          p.vx += (dx / d) * force;
          p.vy += (dy / d) * force;
        }
      }
    };

    const onScroll = () => {
      targetScrollY = window.scrollY;
    };

    const renderFrame = (nowMs: number, stepPhysics: boolean) => {
      const inkRgb = isLight ? "14, 14, 18" : "248, 248, 250";
      const glowAlpha = isLight ? 0.055 : 0.075;

      pointer.x += (pointer.tx - pointer.x) * 0.1;
      pointer.y += (pointer.ty - pointer.y) * 0.1;
      scrollY += (targetScrollY - scrollY) * 0.12;

      ctx.clearRect(0, 0, width, height);

      // Subtle monochrome pointer ambient lens
      if (pointer.active) {
        const g = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 320);
        g.addColorStop(0, `rgba(${inkRgb}, ${glowAlpha})`);
        g.addColorStop(0.55, `rgba(${inkRgb}, ${glowAlpha * 0.3})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }

      // Draw click shockwave ripples
      for (let i = ripples.length - 1; i >= 0; i -= 1) {
        const rp = ripples[i];
        const t = (nowMs - rp.start) / rp.dur;
        if (t >= 1) {
          ripples.splice(i, 1);
          continue;
        }
        const eased = 1 - Math.pow(1 - t, 3);
        const radius = eased * rp.maxR;
        const opacity = (1 - t) * (isLight ? 0.18 : 0.22);
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${inkRgb}, ${opacity.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Update & compute projected positions
      const projX = new Float32Array(particles.length);
      const projY = new Float32Array(particles.length);
      const boost = new Float32Array(particles.length);

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        if (stepPhysics) {
          const baseSpeed = LAYER_SPEED[p.layer];
          // Gentle autonomous drift
          p.ox += Math.cos(p.phase + nowMs * 0.00018) * baseSpeed * 0.28;
          p.oy += Math.sin(p.phase + nowMs * 0.00015) * baseSpeed * 0.28;
          p.x += p.vx;
          p.y += p.vy;

          // Subtle cursor orbital deflection (never clumps into a center knot)
          if (pointer.active) {
            const sy = ((p.y - scrollY * LAYER_PARALLAX[p.layer]) % height + height) % height;
            const dx = pointer.x - p.x;
            const dy = pointer.y - sy;
            const d2 = dx * dx + dy * dy;
            if (d2 < 195 * 195 && d2 > 4) {
              const d = Math.sqrt(d2);
              const prox = 1 - d / 195;
              boost[i] = prox;
              const swirl = prox * 0.022;
              const push = d < 64 ? -(1 - d / 64) * 0.055 : prox * 0.011;
              p.vx += (dx / d) * push - (dy / d) * swirl;
              p.vy += (dy / d) * push + (dx / d) * swirl;
            }
          }

          // Damping and soft boundary wrap
          p.vx *= 0.975;
          p.vy *= 0.975;
          const speedNow = Math.hypot(p.vx, p.vy);
          if (speedNow < baseSpeed * 0.45) {
            p.vx += Math.cos(p.phase + nowMs * 0.0004) * 0.012;
            p.vy += Math.sin(p.phase + nowMs * 0.0004) * 0.012;
          }
          if (p.x < -16) p.x = width + 16;
          if (p.x > width + 16) p.x = -16;
          if (p.y < -16) p.y = height + 16;
          if (p.y > height + 16) p.y = -16;
        }

        projX[i] = p.x;
        const rawY = p.y - scrollY * LAYER_PARALLAX[p.layer];
        projY[i] = ((rawY % height) + height) % height;
      }

      // Connect mid/foreground constellation nodes (squared-distance culled)
      const linkDist = 122;
      const linkDist2 = linkDist * linkDist;
      ctx.lineWidth = 0.75;
      for (let i = 0; i < particles.length; i += 1) {
        if (particles[i].layer === 0) continue;
        for (let j = i + 1; j < particles.length; j += 1) {
          if (particles[j].layer === 0) continue;
          const dx = projX[i] - projX[j];
          const dy = projY[i] - projY[j];
          const d2 = dx * dx + dy * dy;
          if (d2 < linkDist2) {
            const d = Math.sqrt(d2);
            const proximity = 1 - d / linkDist;
            const hoverBoost = Math.max(boost[i], boost[j]) * 0.14;
            const a = proximity * (isLight ? 0.11 : 0.12) + hoverBoost * proximity;
            ctx.strokeStyle = `rgba(${inkRgb}, ${a.toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(projX[i], projY[i]);
            ctx.lineTo(projX[j], projY[j]);
            ctx.stroke();
          }
        }
      }

      // Filaments to pointer
      if (pointer.active) {
        for (let i = 0; i < particles.length; i += 1) {
          if (boost[i] <= 0.08 || particles[i].layer === 0) continue;
          const a = boost[i] * (isLight ? 0.16 : 0.2);
          ctx.strokeStyle = `rgba(${inkRgb}, ${a.toFixed(3)})`;
          ctx.lineWidth = 0.75;
          ctx.beginPath();
          ctx.moveTo(projX[i], projY[i]);
          ctx.lineTo(pointer.x, pointer.y);
          ctx.stroke();
        }
      }

      // Draw particles with soft halo for foreground layer
      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        const a = Math.min(0.88, p.alpha + boost[i] * 0.35);
        if (p.layer === 2) {
          ctx.beginPath();
          ctx.fillStyle = `rgba(${inkRgb}, ${(a * 0.18).toFixed(3)})`;
          ctx.arc(projX[i], projY[i], p.r * 2.8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.fillStyle = `rgba(${inkRgb}, ${a.toFixed(3)})`;
        ctx.arc(projX[i], projY[i], p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const tick = (nowMs: number) => {
      if (!running) return;
      renderFrame(nowMs, true);
      frame = requestAnimationFrame(tick);
    };

    buildParticles();

    const themeObs = new MutationObserver(() => {
      isLight = document.documentElement.dataset.theme === "light";
      if (reducedMotion) renderFrame(performance.now(), false);
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    window.addEventListener("resize", buildParticles);

    if (reducedMotion) {
      renderFrame(performance.now(), false);
      return () => {
        themeObs.disconnect();
        window.removeEventListener("resize", buildParticles);
      };
    }

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });

    const onVis = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frame);
      } else if (!running) {
        running = true;
        frame = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    frame = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      themeObs.disconnect();
      window.removeEventListener("resize", buildParticles);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <>
      <canvas
        ref={ref}
        className="ambience-canvas pointer-events-none fixed inset-0 z-0 h-full w-full"
        aria-hidden
      />
      <div className="pointer-events-none fixed inset-0 z-0 grid-veil" aria-hidden />
      <div className="pointer-events-none fixed inset-0 z-[60] noise" aria-hidden />
    </>
  );
}
