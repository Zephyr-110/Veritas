"use client";

import { DEMO_VIDEO_URL } from "@/lib/constants";
import { Reveal, StableText, onSpot } from "./ui";

type VideoEmbed =
  | { kind: "video"; src: string }
  | { kind: "iframe"; src: string };

export function parseVideoEmbed(rawUrl: string): VideoEmbed | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("/")) {
    return /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(trimmed)
      ? { kind: "video", src: trimmed }
      : null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  if (/\.(mp4|webm|mov|m4v)$/i.test(url.pathname)) {
    return { kind: "video", src: url.toString() };
  }

  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\/+/, "").split("/")[0];
    return id ? { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${id}` } : null;
  }

  if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    if (url.pathname.startsWith("/embed/")) {
      return { kind: "iframe", src: `https://www.youtube-nocookie.com${url.pathname}` };
    }
    const id = url.searchParams.get("v");
    return id ? { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${id}` } : null;
  }

  if (host === "vimeo.com" || host === "www.vimeo.com") {
    const id = url.pathname.replace(/^\/+/, "").split("/")[0];
    return id && /^\d+$/.test(id) ? { kind: "iframe", src: `https://player.vimeo.com/video/${id}` } : null;
  }

  if (host === "www.loom.com" || host === "loom.com") {
    if (url.pathname.startsWith("/share/")) {
      const id = url.pathname.replace(/^\/share\//, "").split("/")[0];
      return id ? { kind: "iframe", src: `https://www.loom.com/embed/${id}` } : null;
    }
    if (url.pathname.startsWith("/embed/")) {
      return { kind: "iframe", src: url.toString() };
    }
  }

  return { kind: "iframe", src: url.toString() };
}

export function DemoVideo({ url = DEMO_VIDEO_URL }: { url?: string }) {
  const embed = parseVideoEmbed(url);
  if (!embed) return null;

  return (
    <Reveal>
      <section className="home-section">
        <div onMouseMove={onSpot} className="surface overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hair)] px-5 py-3">
            <span className="home-kicker flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              <StableText k="home.demoVideoKicker" />
            </span>
            <span className="text-xs text-zinc-400">
              <StableText k="home.demoVideoTitle" align="end" />
            </span>
          </div>
          <div className="aspect-video w-full bg-black">
            {embed.kind === "video" ? (
              <video
                src={embed.src}
                controls
                playsInline
                preload="metadata"
                className="h-full w-full"
              />
            ) : (
              <iframe
                src={embed.src}
                title="Veritas Demo Video"
                className="h-full w-full border-0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            )}
          </div>
        </div>
      </section>
    </Reveal>
  );
}
