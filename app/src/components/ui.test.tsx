import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublicKey } from "@solana/web3.js";
import { LocaleProvider } from "@/i18n/provider";
import { setLocale } from "@/i18n/store";

const walletState = vi.hoisted(() => ({
  publicKey: null as PublicKey | null,
  connected: false,
  connecting: false,
  wallet: null as unknown,
  wallets: [] as Array<{ adapter: { name: string; icon?: string }; readyState: string }>,
  select: vi.fn(),
  disconnect: vi.fn(),
}));
const bump = vi.hoisted(() => vi.fn());

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => walletState,
  useConnection: () => ({ connection: { getEpochInfo: vi.fn().mockResolvedValue({ epoch: 1 }) } }),
  useAnchorWallet: () => null,
}));

vi.mock("@/components/providers", () => ({
  useRefresh: () => ({ nonce: 0, bump }),
  useSettings: () => ({ settings: { rpcUrl: "", cluster: "devnet", programId: "", collateralMint: "" } }),
  useToasts: () => ({ push: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/markets",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const {
  Button,
  Card,
  Chip,
  Field,
  Header,
  HeaderFaucet,
  Kv,
  LangSwitch,
  Reveal,
  SegTabs,
  StateBlock,
  ThemeToggle,
  WalletButton,
  WalletConnectModal,
  cx,
  openFaucetMenu,
} = await import("@/components/ui");

afterEach(() => {
  cleanup();
  setLocale("en");
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  walletState.publicKey = null;
  walletState.connected = false;
  walletState.wallets = [];
  walletState.select.mockReset();
  bump.mockReset();
  vi.unstubAllGlobals();
});

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

  it("ThemeToggle 在暗色与浅色主题间双向切换并持久化", async () => {
    render(
      <LocaleProvider>
        <ThemeToggle />
      </LocaleProvider>
    );
    const btn = screen.getByRole("button");
    await userEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("veritas-theme")).toBe("light");
    await userEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("veritas-theme")).toBe("dark");
  });

  it("LangSwitch 点击立即同步高亮与语言", async () => {
    render(
      <LocaleProvider>
        <LangSwitch />
      </LocaleProvider>
    );
    const enBtn = screen.getByRole("button", { name: "EN" });
    const zhBtn = screen.getByRole("button", { name: "中文" });
    expect(enBtn.className).toContain("bg-[var(--accent)]");
    await userEvent.click(zhBtn);
    expect(zhBtn.className).toContain("bg-[var(--accent)]");
    expect(enBtn.className).not.toContain("bg-[var(--accent)]");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("WalletConnectModal 在无钱包插件时显示本地化安装引导，在有插件时可选择连接", async () => {
    const { rerender } = render(
      <LocaleProvider>
        <WalletButton />
        <WalletConnectModal />
      </LocaleProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: /Connect wallet/i }));
    expect(screen.getByText(/No Solana wallet extension detected/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Install Phantom/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Browse markets in read-only mode/i })).toHaveAttribute(
      "href",
      "/markets"
    );

    walletState.wallets = [{ adapter: { name: "Phantom" }, readyState: "Installed" }];
    rerender(
      <LocaleProvider>
        <WalletButton />
        <WalletConnectModal />
      </LocaleProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: /Phantom/i }));
    expect(walletState.select).toHaveBeenCalledWith("Phantom");
  });

  it("HeaderFaucet 浮层支持外部调用触发并在连接钱包后领取 USDT", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    walletState.publicKey = PublicKey.default;
    walletState.connected = true;

    render(
      <LocaleProvider>
        <HeaderFaucet />
      </LocaleProvider>
    );
    act(() => openFaucetMenu());
    await userEvent.click(screen.getByRole("button", { name: /Claim 100 test USDT/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bump).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Sent — check your wallet/i)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
  });

  it("Header 在未连接与已连接状态下均不渲染顶栏价格带（HeaderTape）且保留核心导航与钱包控件", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { rerender } = render(
      <LocaleProvider>
        <Header />
      </LocaleProvider>
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /Connect wallet/i })).toBeInTheDocument());
    expect(screen.getAllByRole("link", { name: "Markets" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/BTC\/USD|SOL\/USD/)).toBeNull();

    walletState.publicKey = PublicKey.default;
    walletState.connected = true;
    rerender(
      <LocaleProvider>
        <Header />
      </LocaleProvider>
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /Disconnect/i })).toBeInTheDocument());
    expect(screen.getByText("1111…1111")).toBeInTheDocument();
    expect(screen.queryByText(/BTC\/USD|SOL\/USD/)).toBeNull();
  });
});
