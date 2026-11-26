import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n/provider";
import { DemoVideo, parseVideoEmbed } from "@/components/demo-video";

afterEach(() => cleanup());

describe("parseVideoEmbed", () => {
  it("空 URL 或非法协议返回 null（不渲染假占位）", () => {
    expect(parseVideoEmbed("")).toBeNull();
    expect(parseVideoEmbed("   ")).toBeNull();
    expect(parseVideoEmbed("javascript:alert(1)")).toBeNull();
    expect(parseVideoEmbed("http://example.com/demo.mp4")).toBeNull();
  });

  it("支持 YouTube、Vimeo、Loom 与直链 MP4 规范化", () => {
    expect(parseVideoEmbed("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      kind: "iframe",
      src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    });
    expect(parseVideoEmbed("https://www.youtube.com/watch?v=abc123")).toEqual({
      kind: "iframe",
      src: "https://www.youtube-nocookie.com/embed/abc123",
    });
    expect(parseVideoEmbed("https://vimeo.com/123456789")).toEqual({
      kind: "iframe",
      src: "https://player.vimeo.com/video/123456789",
    });
    expect(parseVideoEmbed("https://www.loom.com/share/deadbeef")).toEqual({
      kind: "iframe",
      src: "https://www.loom.com/embed/deadbeef",
    });
    expect(parseVideoEmbed("https://cdn.example.com/demo.mp4")).toEqual({
      kind: "video",
      src: "https://cdn.example.com/demo.mp4",
    });
    expect(parseVideoEmbed("/videos/veritas.mp4")).toEqual({
      kind: "video",
      src: "/videos/veritas.mp4",
    });
  });
});

describe("DemoVideo 组件", () => {
  it("配置常量为空时不渲染任何 DOM 占位", () => {
    const { container } = render(
      <LocaleProvider>
        <DemoVideo url="" />
      </LocaleProvider>
    );
    expect(container.firstChild).toBeNull();
  });

  it("提供合法视频 URL 时渲染嵌入式播放器", () => {
    render(
      <LocaleProvider>
        <DemoVideo url="https://youtu.be/dQw4w9WgXcQ" />
      </LocaleProvider>
    );
    const iframe = screen.getByTitle("Veritas hackathon demo walkthrough video") as HTMLIFrameElement;
    expect(iframe).toBeInTheDocument();
    expect(iframe.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });
});
