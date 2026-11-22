import { describe, it, expect, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { RESOLVE_WINDOW } from "@/lib/constants";
import {
  chancePct,
  clusterLabel,
  formatWhen,
  hasBet,
  isMarketVoided,
  kindLabel,
  kindLabelKey,
  kindTone,
  listSection,
  marketKind,
  money,
  questionTitle,
  resolveHours,
  timeCopy,
} from "@/lib/display";
import { FEEDS } from "@/lib/feeds";
import { EMPTY_POSITION, type MarketView } from "@/lib/markets";
import { getLocale, setLocale } from "@/i18n/store";

function makeMarket(overrides: Partial<MarketView> = {}): MarketView {
  const key = PublicKey.default;
  return {
    address: key,
    pdas: {
      market: key,
      marketBump: 255,
      snapshot: key,
      yesMint: key,
      noMint: key,
      collateralVault: key,
      yesPool: key,
      noPool: key,
    },
    title: "BTC/USD >= 73,479 @ 2026-01-01",
    id: Array.from({ length: 16 }, () => 1),
    creator: key,
    collateralMint: key,
    yesMint: key,
    noMint: key,
    status: "open",
    winner: null,
    expiry: 1_767_225_600,
    endTs: 1_767_225_600,
    finishTs: 0,
    bump: 255,
    yesPool: 0n,
    noPool: 0n,
    vault: 0n,
    decimals: 6,
    tokenProgram: key,
    yesPrice: 0.5,
    noPrice: 0.5,
    reserveYes: 100n,
    reserveNo: 100n,
    totalLpShares: 100n,
    ocr2State: new PublicKey(FEEDS[0].state),
    feedKey: "btc",
    feedSymbol: "BTC/USD",
    priceDecimals: 8,
    threshold: 73_479n * 10n ** 8n,
    settleAbove: true,
    settledPrice: 0n,
    settledPublishTime: 0,
    feeBps: 30,
    lastAccrualTs: 0,
    cumYesPerShare: 0n,
    cumNoPerShare: 0n,
    ...overrides,
  };
}

describe("display", () => {
  const prevLocale = getLocale();
  afterEach(() => setLocale(prevLocale));

  describe("questionTitle", () => {
    it("自定义标题原样返回", () => {
      const m = makeMarket({ title: "Will ETH merge succeed?" });
      expect(questionTitle(m)).toBe("Will ETH merge succeed?");
    });

    it("自动规格标题在 en/zh 与 settleAbove=true/false 下转为自然问句", () => {
      const mAbove = makeMarket({ settleAbove: true });
      const mBelow = makeMarket({
        title: "ETH/USD < 2,000 @ 2026-01-01",
        ocr2State: PublicKey.default,
        threshold: 2_000n * 10n ** 8n,
        settleAbove: false,
      });

      setLocale("en");
      expect(questionTitle(mAbove)).toMatch(/^BTC\/USD above 73,479 at \d{4}-\d{2}-\d{2} \d{2}:\d{2}\?$/);
      expect(questionTitle(mBelow)).toMatch(/^ETH\/USD below 2,000 at \d{4}-\d{2}-\d{2} \d{2}:\d{2}\?$/);

      setLocale("zh");
      expect(questionTitle(mAbove)).toMatch(/^BTC\/USD \d{4}-\d{2}-\d{2} \d{2}:\d{2} 能站上 73,479 吗？$/);
      expect(questionTitle(mBelow)).toMatch(/^ETH\/USD \d{4}-\d{2}-\d{2} \d{2}:\d{2} 会跌破 2,000 吗？$/);

      const mZhAuto = makeMarket({ title: "BTC/USD 2026-11-22 16:32 能站上 73,479 吗？", settleAbove: true });
      const mEnAuto = makeMarket({
        title: "ETH/USD below 2,000 at 2026-11-22 16:32?",
        ocr2State: new PublicKey(FEEDS[1].state),
        threshold: 2_000n * 10n ** 8n,
        settleAbove: false,
      });
      setLocale("en");
      expect(questionTitle(mZhAuto)).toMatch(/^BTC\/USD above 73,479 at \d{4}-\d{2}-\d{2} \d{2}:\d{2}\?$/);
      setLocale("zh");
      expect(questionTitle(mEnAuto)).toMatch(/^ETH\/USD \d{4}-\d{2}-\d{2} \d{2}:\d{2} 会跌破 2,000 吗？$/);
    });

    it("时长模板标题按当前语言重拼，自由标题原样保留", () => {
      const mOpen = makeMarket({
        title: "SOL/USD at or above opening price in 12 min?",
        ocr2State: PublicKey.default,
        settleAbove: true,
      });
      setLocale("zh");
      expect(questionTitle(mOpen)).toBe("SOL/USD 12 分钟后能站上开盘价吗？");
      setLocale("en");
      expect(questionTitle(mOpen)).toBe("SOL/USD at or above opening price in 12 min?");

      const mNumZh = makeMarket({
        title: "ETH/USD 1 小时后会跌破 2,500 吗？",
        ocr2State: new PublicKey(FEEDS[1].state),
        settleAbove: false,
      });
      setLocale("en");
      expect(questionTitle(mNumZh)).toBe("ETH/USD below 2,500 in 1 hour?");
      setLocale("zh");
      expect(questionTitle(mNumZh)).toBe("ETH/USD 1 小时后会跌破 2,500 吗？");

      const mCustom = makeMarket({ title: "SOL/USD 能不能在下周破百？", ocr2State: PublicKey.default });
      setLocale("en");
      expect(questionTitle(mCustom)).toBe("SOL/USD 能不能在下周破百？");
    });
  });

  it("money / formatWhen / resolveHours", () => {
    expect(money(1_250_000n, 6)).toBe("1.25 USDT");
    expect(money(1_250_000n, 6, 4)).toBe("1.25 USDT");
    expect(formatWhen(1_767_225_600)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(resolveHours()).toBe(48);
  });

  it("chancePct 正确四舍五入、夹逼并处理非有限值", () => {
    expect(chancePct(0.654)).toBe(65);
    expect(chancePct(-0.2)).toBe(0);
    expect(chancePct(1.5)).toBe(100);
    expect(chancePct(Number.NaN)).toBe(50);
    expect(chancePct(Number.POSITIVE_INFINITY)).toBe(50);
  });

  it("clusterLabel 映射已知集群并透传未知值", () => {
    setLocale("en");
    expect(clusterLabel("mainnet-beta")).toBe("Mainnet");
    expect(clusterLabel("localnet")).toBe("Local");
    expect(clusterLabel("devnet")).toBe("Devnet");
    expect(clusterLabel("testnet")).toBe("Testnet");
    expect(clusterLabel("custom-rpc")).toBe("custom-rpc");
  });

  it("marketKind / kindLabelKey / kindLabel / kindTone / listSection / isMarketVoided 覆盖全状态", () => {
    setLocale("en");
    const expiry = 10_000;

    const liveM = makeMarket({ status: "open", expiry });
    expect(marketKind(liveM, expiry - 10)).toBe("live");
    expect(kindLabelKey("live", liveM)).toBe("kind.live");
    expect(kindLabel("live", liveM)).toBe("Live");
    expect(kindTone("live", liveM)).toBe("yes");
    expect(listSection("live")).toBe("live");

    expect(marketKind(liveM, expiry + 10)).toBe("awaiting");
    expect(kindLabelKey("awaiting", liveM)).toBe("kind.awaiting");
    expect(kindTone("awaiting", liveM)).toBe("accent");
    expect(listSection("awaiting")).toBe("ended");

    expect(marketKind(liveM, expiry + RESOLVE_WINDOW + 1)).toBe("voidable");
    expect(kindLabelKey("voidable", liveM)).toBe("kind.voidable");
    expect(kindTone("voidable", liveM)).toBe("ink");

    const yesWon = makeMarket({ status: "resolved", winner: "yes" });
    const noWon = makeMarket({ status: "resolved", winner: "no" });
    expect(marketKind(yesWon, expiry)).toBe("resolved");
    expect(kindLabelKey("resolved", yesWon)).toBe("kind.yesWon");
    expect(kindLabelKey("resolved", noWon)).toBe("kind.noWon");
    expect(kindTone("resolved", yesWon)).toBe("yes");
    expect(kindTone("resolved", noWon)).toBe("no");

    const stale = makeMarket({ status: "staleBurn" });
    const winVoid = makeMarket({ status: "windowBurn" });
    expect(marketKind(stale, expiry)).toBe("staleVoid");
    expect(marketKind(winVoid, expiry)).toBe("windowVoid");
    expect(kindLabelKey("staleVoid", stale)).toBe("kind.staleVoid");
    expect(kindLabelKey("windowVoid", winVoid)).toBe("kind.windowVoid");
    expect(kindTone("staleVoid", stale)).toBe("no");
    expect(kindTone("windowVoid", winVoid)).toBe("no");
    expect(isMarketVoided(stale)).toBe(true);
    expect(isMarketVoided(winVoid)).toBe(true);
    expect(isMarketVoided(yesWon)).toBe(false);
  });

  it("timeCopy 与 hasBet", () => {
    setLocale("en");
    const m = makeMarket({ status: "open", expiry: 20_000 });
    expect(timeCopy(m, 19_900)).toBe("00:01:40");
    expect(timeCopy(m, 20_100)).toContain("Closed ");
    expect(timeCopy(makeMarket({ status: "resolved", expiry: 20_000 }), 20_100)).toBe(
      formatWhen(20_000)
    );

    expect(hasBet(EMPTY_POSITION)).toBe(false);
    expect(hasBet({ ...EMPTY_POSITION, yes: 1n })).toBe(true);
    expect(hasBet({ ...EMPTY_POSITION, no: 1n })).toBe(true);
  });
});
