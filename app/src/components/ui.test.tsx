import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, Card, Chip, Field, Kv, Reveal, SegTabs, StateBlock, cx } from "@/components/ui";

describe("ui primitives", () => {
  it("cx 过滤假值并拼接", () => {
    expect(cx("a", false, null, undefined, "b")).toBe("a b");
    expect(cx()).toBe("");
  });

  it("Button 渲染 children 并把 tone 映射到 data-tone", () => {
    render(
      <Button tone="yes" className="extra">
        买入
      </Button>
    );
    const btn = screen.getByRole("button", { name: "买入" });
    expect(btn).toHaveAttribute("data-tone", "yes");
    expect(btn).toHaveClass("extra");
    expect(btn).toBeEnabled();
  });

  it("Button busy 时隐藏文案并禁用（防止重复提交）", () => {
    render(
      <Button busy disabled>
        提交
      </Button>
    );
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    // 文案容器被 opacity-0 隐藏，同时渲染出旋转指示器
    expect(btn.querySelector(".animate-spin")).not.toBeNull();
    expect(btn.querySelector(".opacity-0")).not.toBeNull();
  });

  it("Button 透传 onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>点我</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Chip 按 tone 应用不同的边框/文字类", () => {
    const { rerender } = render(<Chip tone="yes">YES</Chip>);
    expect(screen.getByText("YES")).toHaveClass("text-[var(--yes)]");
    rerender(<Chip tone="no">NO</Chip>);
    expect(screen.getByText("NO")).toHaveClass("text-[var(--no)]");
  });

  it("Field 优先显示 error，其次 hint", () => {
    const { rerender } = render(
      <Field label="金额" hint="最小 1 USDT">
        <input />
      </Field>
    );
    expect(screen.getByText("最小 1 USDT")).toBeInTheDocument();
    rerender(
      <Field label="金额" hint="最小 1 USDT" error="余额不足">
        <input />
      </Field>
    );
    expect(screen.getByText("余额不足")).toBeInTheDocument();
    expect(screen.queryByText("最小 1 USDT")).toBeNull();
  });

  it("Card / Kv 渲染内容", () => {
    render(
      <Card className="x">
        <Kv k="总量" v="1,000 USDT" />
      </Card>
    );
    expect(screen.getByText("总量")).toBeInTheDocument();
    expect(screen.getByText("1,000 USDT")).toBeInTheDocument();
  });

  it("StateBlock loading 渲染骨架条，empty 不渲染", () => {
    const { rerender } = render(<StateBlock kind="loading" title="加载中" />);
    expect(screen.getByText("加载中")).toBeInTheDocument();
    expect(document.querySelector(".sk")).not.toBeNull();
    rerender(<StateBlock kind="empty" title="暂无数据" />);
    expect(document.querySelector(".sk")).toBeNull();
  });

  it("SegTabs 点击切换回调正确的值", async () => {
    const onChange = vi.fn();
    render(
      <SegTabs
        value="yes"
        onChange={onChange}
        options={[
          { value: "yes", label: "YES" },
          { value: "no", label: "NO" },
        ]}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "NO" }));
    expect(onChange).toHaveBeenCalledWith("no");
  });

  it("Reveal 在没有 IntersectionObserver 时直接可见（避免内容永久隐藏）", () => {
    const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    // 强制走降级分支
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    try {
      render(<Reveal>内容</Reveal>);
      expect(document.querySelector(".reveal")).toHaveClass("reveal-in");
    } finally {
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
    }
  });
});
