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
const routeState = vi.hoisted(() => ({ pathname: "/markets" }));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => walletState,
  useConnection: () => ({ connection: { getEpochInfo: vi.fn().mockResolvedValue({ epoch: 1 }) } }),
  useAnchorWallet: () => null,
}));

vi.mock("@/components/providers", () => ({
  useRefresh: () => ({ nonce: 0, bump }),
  useSettings: () => ({
    settings: {
      rpcUrl: "",
      cluster: "devnet",
      programId: "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER",
      collateralMint: "",
    },
  }),
  useToasts: () => ({ push: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routeState.pathname,
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
  Footer,
  Header,
  HeaderFaucet,
  Kv,
  LangSwitch,
  Reveal,
  SandboxCapsule,
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
  routeState.pathname = "/markets";
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

  it("HeaderFaucet 未连接钱包时展示沙盒自动补币入口，连接钱包后隐藏沙盒入口并可领取 100 USDT", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <LocaleProvider>
        <HeaderFaucet />
      </LocaleProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: /Test Funds/i }));
    expect(screen.getAllByText(/0\.04 SOL \+ 30 USDT/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Open Sandbox Account \(Devnet\)/i })).toBeInTheDocument();

    walletState.publicKey = PublicKey.default;
    walletState.connected = true;
    rerender(
      <LocaleProvider>
        <HeaderFaucet />
      </LocaleProvider>
    );
    expect(screen.queryByRole("button", { name: /Open Sandbox Account \(Devnet\)/i })).toBeNull();
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
    expect(screen.getAllByRole("link", { name: "Docs" }).length).toBeGreaterThan(0);
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

  it("Footer 在首页与内页渲染一致的页脚内容", () => {
    routeState.pathname = "/";
    const { container: homeContainer, unmount } = render(
      <LocaleProvider>
        <Footer />
      </LocaleProvider>
    );
    const homeFooterHtml = homeContainer.querySelector("footer")?.innerHTML;
    expect(homeFooterHtml).toBeTruthy();
    expect(screen.getByText("Veritas")).toBeInTheDocument();
    expect(screen.getByText(/CYVp…HuER/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.getByText("Devnet demo. Not real funds.")).toBeInTheDocument();
    unmount();

    routeState.pathname = "/markets";
    const { container: innerContainer } = render(
      <LocaleProvider>
        <Footer />
      </LocaleProvider>
    );
    expect(innerContainer.querySelector("footer")?.innerHTML).toBe(homeFooterHtml);
  });

  it("SandboxCapsule 实时拉取 /api/markets：优先直达剩余 ≥60s 的最短在架盘，否则最短开启盘，无开启盘时不渲染", async () => {
    const { GuestSessionProvider, SANDBOX_STORAGE_KEY } = await import("@/components/guest-session");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { Keypair } = await import("@solana/web3.js");
    const { FEEDS } = await import("@/lib/feeds");
    const kp = Keypair.generate();
    localStorage.setItem(
      SANDBOX_STORAGE_KEY,
      JSON.stringify({ secretKey: Array.from(kp.secretKey), active: true })
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const makeDto = (seed: number, title: string, expiry: number) => {
      const addr = new PublicKey(Buffer.alloc(32, seed)).toBase58();
      const idHex = Buffer.alloc(16, seed).toString("hex");
      return {
        address: addr,
        programId: "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER",
        idHex,
        bump: 255,
        creator: addr,
        title,
        feedKey: "btc",
        feedSymbol: "BTC/USD",
        ocr2State: FEEDS[0].state,
        collateralMint: addr,
        tokenProgram: PublicKey.default.toBase58(),
        decimals: 6,
        yesMint: addr,
        noMint: addr,
        openedAt: nowSec - 10,
        startTs: nowSec - 10,
        expiry,
        endTs: expiry,
        finishTs: 0,
        durationSec: null,
        durationBucket: null,
        status: "open",
        winner: null,
        threshold: "6000000000000",
        priceDecimals: 8,
        settleAbove: true,
        settledPrice: "0",
        settledPublishTime: 0,
        feeBps: 50,
        lZero: "150000000",
        lastAccrualTs: nowSec,
        cumYesPerShare: "0",
        cumNoPerShare: "0",
        reserveYes: "150000000",
        reserveNo: "150000000",
        totalLpShares: "150000000",
        yesPool: "0",
        noPool: "0",
        vault: "150000000",
        yesPrice: 0.5,
        noPrice: 0.5,
        updatedAt: nowSec,
      };
    };

    const m15Short = makeDto(11, "BTC/USD at or above opening price in 15 min?", nowSec + 40);
    const m2Short = makeDto(12, "ETH/USD at or above opening price in 2 min?", nowSec + 80);
    const m2Long = makeDto(13, "SOL/USD at or above opening price in 2 min?", nowSec + 110);

    let mode: "both" | "only15" | "empty" = "both";
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/sandbox/activate") {
        return { ok: true, json: async () => ({ ok: true, touched: true }) };
      }
      const items = mode === "both" ? [m15Short, m2Long, m2Short] : mode === "only15" ? [m15Short] : [];
      return {
        ok: true,
        json: async () => ({ items, total: items.length, page: 1, pageSize: 50, hasMore: false, indexedAt: nowSec }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <LocaleProvider>
          <GuestSessionProvider>
            <SandboxCapsule />
          </GuestSessionProvider>
        </LocaleProvider>
      </QueryClientProvider>
    );

    const capsuleBtn = await screen.findByRole("button", { name: /Sandbox/i });
    await userEvent.click(capsuleBtn);
    const jump2m = await screen.findByTestId("sandbox-quick-jump");
    expect(jump2m).toHaveAttribute("href", `/markets/${m2Short.address}`);

    // Close and reopen with only 15m market
    await userEvent.click(capsuleBtn);
    mode = "only15";
    await userEvent.click(capsuleBtn);
    const jumpLive = await screen.findByTestId("sandbox-quick-jump");
    expect(jumpLive).toHaveAttribute("href", `/markets/${m15Short.address}`);

    // Close and reopen with no live markets -> not rendered
    await userEvent.click(capsuleBtn);
    mode = "empty";
    await userEvent.click(capsuleBtn);
    await waitFor(() => expect(screen.queryByTestId("sandbox-quick-jump")).toBeNull());
  });
});
