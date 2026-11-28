import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyQuotes } from "@/lib/chainlink";
import { LocaleProvider } from "@/i18n/provider";
import { setLocale } from "@/i18n/store";

const guestState = vi.hoisted(() => ({
  isSandbox: true,
  entering: false,
  txPending: false,
  locked: false,
}));

const openWalletModal = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({ publicKey: null, connected: false }),
  useConnection: () => ({ connection: {} }),
}));

vi.mock("@/components/guest-session", () => ({
  useGuestSession: () => guestState,
}));

vi.mock("@/hooks/use-program", () => ({
  useProgram: () => null,
}));

vi.mock("@/hooks/use-feeds", () => ({
  useFeeds: () => ({ quotes: emptyQuotes() }),
}));

vi.mock("@/hooks/use-now", () => ({
  useNow: () => 1_767_225_600,
}));

vi.mock("@/components/providers", () => ({
  useRefresh: () => ({ nonce: 0, bump: vi.fn() }),
  useSettings: () => ({
    settings: {
      rpcUrl: "https://api.devnet.solana.com",
      cluster: "devnet",
      programId: "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER",
      collateralMint: "CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG",
    },
  }),
  useToasts: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    useTx: () => ({ busy: false, run: vi.fn() }),
    openWalletModal,
  };
});

const { default: CreatePage } = await import("@/app/create/page");

beforeEach(() => {
  guestState.isSandbox = true;
  guestState.entering = false;
  guestState.txPending = false;
  guestState.locked = false;
  openWalletModal.mockReset();
});

afterEach(() => {
  cleanup();
  setLocale("en");
});

describe("CreatePage sandbox lock reason", () => {
  it("沙盒未锁定时可点击连接真实钱包，不显示锁定原因", async () => {
    render(
      <LocaleProvider>
        <CreatePage />
      </LocaleProvider>
    );

    const submit = screen.getByRole("button", { name: /Connect real wallet to create market/i });
    expect(submit).toBeEnabled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByText(
        "Sandbox Account (Devnet) supports trading and redemption only — creating a market requires a real wallet: it binds persistent creator authority, and the wallet must hold at least 0.02 SOL to cover account rent and fees."
      )
    ).toBeInTheDocument();
    // Preview threshold uses Unicode "≥" consistently with the rest of the site
    expect(screen.getByText(/BTC\/USD ≥ /)).toBeInTheDocument();
    expect(screen.queryByText(/BTC\/USD >= /)).toBeNull();

    await userEvent.click(submit);
    expect(openWalletModal).toHaveBeenCalledTimes(1);
  });

  it("沙盒交易确认中锁定时禁用提交并给出 txPending 原因", () => {
    guestState.txPending = true;
    guestState.locked = true;

    render(
      <LocaleProvider>
        <CreatePage />
      </LocaleProvider>
    );

    const submit = screen.getByRole("button", { name: /Connect real wallet to create market/i });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-describedby", "create-sandbox-note");
    expect(screen.getByRole("status")).toHaveTextContent(
      /A sandbox transaction is currently confirming/i
    );
  });

  it("沙盒账户初始化/补币中锁定时禁用提交并给出 entering 原因", () => {
    guestState.entering = true;
    guestState.locked = true;

    render(
      <LocaleProvider>
        <CreatePage />
      </LocaleProvider>
    );

    const submit = screen.getByRole("button", { name: /Connect real wallet to create market/i });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      /A sandbox account action is in progress/i
    );
  });

  it("在创建须知区逐字展示中英双语账户租金说明", () => {
    const { rerender } = render(
      <LocaleProvider>
        <CreatePage />
      </LocaleProvider>
    );
    expect(
      screen.getByText(
        "Creating a market also requires roughly 0.014 SOL of account rent, locked until the market's accounts are burned 30 days after it finalises."
      )
    ).toBeInTheDocument();

    act(() => {
      setLocale("zh");
    });
    rerender(
      <LocaleProvider>
        <CreatePage />
      </LocaleProvider>
    );
    expect(
      screen.getByText(
        "创建市场另需约 0.014 SOL 的账户租金，锁定至市场完结 30 天后烧毁账户时回收。"
      )
    ).toBeInTheDocument();
  });
});
