import * as assert from "assert";
import { PublicKey } from "@solana/web3.js";
import {
  assertTxFails,
  ataOf,
  createCollateralMint,
  eqAmount,
  getHouse,
  getTestEnv,
  makeOpenMarket,
  mintSupply,
  newFundedUser,
  openTokenAccount,
  readPosition,
  sendGetCollateral,
  sendResolveMarket,
  sendUserBetOn,
  sendVoidMarket,
  sameJson,
  fetchMarket,
  TestEnv,
  tokens,
  User,
  waitUntilExpired,
} from "./helpers";

describe("兑奖 get_collateral", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  // 建一个已裁决、赢家为 Yes、玩家持有获胜代币的盘口
  async function resolvedYesMarket(
    collateralAmount = tokens(80),
    expireInSeconds = 20
  ) {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount,
      expireInSeconds,
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(10));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(10),
      tokenType: "yes",
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");
    return { market, trader };
  }

  it("赢家烧掉获胜代币，按 1:1 从金库兑抵押物", async () => {
    const { market, trader } = await resolvedYesMarket();
    const before = await readPosition(env, market, trader.pubkey);
    const claim = before.yes;
    assert.ok(claim > 0n, "用例前提：玩家应持有 Yes");
    await sendGetCollateral(env, trader, market, market.yesMint, claim);
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.yes, 0n, "获胜代币应烧完");
    eqAmount(after.collateral, before.collateral + claim, "兑出等额抵押物");
    eqAmount(after.vault, before.vault - claim, "金库减少等额抵押物");
    eqAmount(
      await mintSupply(env, market.yesMint),
      after.vault,
      "赢家币供给应与金库同步减少"
    );
    eqAmount(
      await mintSupply(env, market.noMint),
      before.vault,
      "输家币供给不受兑奖影响，仍等于兑奖前金库"
    );
  });

  it("还没裁决时不能兑奖", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(20),
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(2));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(2),
      tokenType: "yes",
    });
    const pos = await readPosition(env, market, trader.pubkey);
    assert.ok(pos.yes > 0n, "用例前提：玩家应持有 Yes");
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, market.yesMint, pos.yes),
      "MarketNotResolved"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "失败的兑奖不能烧掉代币");
    eqAmount(after.vault, pos.vault, "金库不受影响");
  });

  it("输家代币不能兑奖", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(40),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(4));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(4),
      tokenType: "yes",
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "no");
    const pos = await readPosition(env, market, trader.pubkey);
    assert.ok(pos.yes > 0n, "用例前提：玩家应持有 Yes");
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, market.yesMint, pos.yes),
      "NotWinnerMint"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "失败的兑奖不能烧掉代币");
    eqAmount(after.no, pos.no, "输家币余额不受影响");
  });

  it("赢家为 No 时，No 持有者同样能按 1:1 兑出抵押物", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(80),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(10));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(10),
      tokenType: "no",
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "no");

    const before = await readPosition(env, market, trader.pubkey);
    const claim = before.no;
    assert.ok(claim > 0n, "本用例需要玩家手里持有 No");
    await sendGetCollateral(env, trader, market, market.noMint, claim);
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.no, 0n, "获胜的 No 应烧完");
    eqAmount(after.collateral, before.collateral + claim, "兑出等额抵押物");
    eqAmount(after.vault, before.vault - claim, "金库减少等额抵押物");
    eqAmount(
      await mintSupply(env, market.noMint),
      after.vault,
      "No 供给应与金库同步减少"
    );
    eqAmount(
      await mintSupply(env, market.yesMint),
      before.vault,
      "Yes 供给不受兑奖影响，仍等于兑奖前金库"
    );
  });

  it("只兑一部分，剩余可继续兑（部分兑奖两步守恒）", async () => {
    const { market, trader } = await resolvedYesMarket();
    const before = await readPosition(env, market, trader.pubkey);
    const half = before.yes / 2n;
    assert.ok(half > 0n, "用例前提：Yes 数量应足够拆两半");
    await sendGetCollateral(env, trader, market, market.yesMint, half);
    const mid = await readPosition(env, market, trader.pubkey);
    eqAmount(mid.yes, before.yes - half, "第一半兑完，剩余一半仍在");
    eqAmount(mid.collateral, before.collateral + half, "第一半换回等额抵押物");
    eqAmount(mid.vault, before.vault - half, "金库扣掉第一半");
    eqAmount(await mintSupply(env, market.yesMint), mid.vault, "兑一半后供给仍等于金库");

    await sendGetCollateral(env, trader, market, market.yesMint, mid.yes);
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, 0n, "第二半兑完清零");
    eqAmount(after.vault, before.vault - before.yes, "金库最终扣除全额");
    eqAmount(after.collateral, before.collateral + before.yes, "抵押物最终全额到账");
  });

  it("超额兑奖被拒：amount = 余额 + 1", async () => {
    const { market, trader } = await resolvedYesMarket();
    const pos = await readPosition(env, market, trader.pubkey);
    await assertTxFails(
      () =>
        sendGetCollateral(env, trader, market, market.yesMint, pos.yes + 1n),
      "InsufficientBalance"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "失败的超额兑奖不能烧掉代币");
    eqAmount(after.vault, pos.vault, "金库不受影响");
    eqAmount(after.collateral, pos.collateral, "抵押物不受影响");
  });

  it("amount = 0 被拒", async () => {
    const { market, trader } = await resolvedYesMarket();
    const pos = await readPosition(env, market, trader.pubkey);
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, market.yesMint, 0n),
      "InvalidAmount"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "amount=0 不能烧掉代币");
  });

  it("全额兑完后再次兑奖被拒", async () => {
    const { market, trader } = await resolvedYesMarket();
    const pos = await readPosition(env, market, trader.pubkey);
    await sendGetCollateral(env, trader, market, market.yesMint, pos.yes);
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, market.yesMint, 1n),
      "InsufficientBalance"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, 0n, "已兑空的代币余额保持为零");
    eqAmount(after.vault, pos.vault - pos.yes, "金库已扣除第一次兑奖，不再变化");
  });

  it("拿别的盘口的金库兑奖被 seeds 约束拦下", async () => {
    const { market: marketA, trader } = await resolvedYesMarket();
    const marketB = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(20),
    });
    assert.ok(
      !marketA.collateralVault.equals(marketB.collateralVault),
      "两个盘口的金库地址必须不同，否则本用例无意义"
    );
    const pos = await readPosition(env, marketA, trader.pubkey);
    await assertTxFails(
      () =>
        sendGetCollateral(env, trader, marketA, marketA.yesMint, pos.yes, {
          collateralVault: marketB.collateralVault,
        }),
      "ConstraintSeeds"
    );
    const after = await readPosition(env, marketA, trader.pubkey);
    eqAmount(after.yes, pos.yes, "跨盘口兑奖失败，代币不能被烧");
    eqAmount(after.vault, pos.vault, "跨盘口兑奖失败，金库不受影响");
    const marketBVault = await readPosition(env, marketB, house.pubkey);
    eqAmount(marketBVault.vault, tokens(20), "另一个盘口的金库也分文未动");
  });

  it("拿别的盘口的代币来兑奖被拒", async () => {
    const { market: marketA, trader } = await resolvedYesMarket();
    const marketB = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(20),
    });
    assert.ok(
      !marketA.yesMint.equals(marketB.yesMint),
      "两个盘口的 Yes 代币地址必须不同，否则本用例无意义"
    );
    await openTokenAccount(env, marketB.yesMint, trader.pubkey);
    const pos = await readPosition(env, marketA, trader.pubkey);
    await assertTxFails(
      () =>
        sendGetCollateral(env, trader, marketA, marketB.yesMint, pos.yes),
      "InvalidMint"
    );
    const after = await readPosition(env, marketA, trader.pubkey);
    eqAmount(after.yes, pos.yes, "跨盘口代币兑奖失败，代币不能被烧");
  });

  it("传一个不相干的第三方代币被拒", async () => {
    const { market, trader } = await resolvedYesMarket();
    const thirdMint = await createCollateralMint(env);
    await openTokenAccount(env, thirdMint, trader.pubkey);
    const pos = await readPosition(env, market, trader.pubkey);
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, thirdMint, pos.yes),
      "InvalidMint"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "第三方代币兑奖失败，代币不能被烧");
  });

  it("不能拿别人的代币账户冒领", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(80),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(10));
    const stranger = await newFundedUser(env, "路人", mint, tokens(1));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(10),
      tokenType: "yes",
    });
    await sendUserBetOn(env, stranger, market, {
      collateralAmount: tokens(1),
      tokenType: "yes",
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");
    const strangerPos = await readPosition(env, market, stranger.pubkey);
    assert.ok(strangerPos.yes > 0n, "用例前提：路人应持有自己的 Yes");
    await assertTxFails(
      () =>
        sendGetCollateral(env, trader, market, market.yesMint, strangerPos.yes, {
          tokenAta: ataOf(market.yesMint, stranger.pubkey),
        }),
      "ConstraintTokenOwner"
    );
    const strangerAfter = await readPosition(env, market, stranger.pubkey);
    eqAmount(strangerAfter.yes, strangerPos.yes, "路人的代币不能被冒领");
    eqAmount(strangerAfter.collateral, strangerPos.collateral, "路人的抵押物不能被冒领");
  });

  it("无持仓的玩家兑不出抵押物", async () => {
    const { market } = await resolvedYesMarket();
    const stranger = await newFundedUser(env, "路人", mint, tokens(1));
    await openTokenAccount(env, market.yesMint, stranger.pubkey);
    await assertTxFails(
      () => sendGetCollateral(env, stranger, market, market.yesMint, 1n),
      "InsufficientBalance"
    );
    const after = await readPosition(env, market, stranger.pubkey);
    eqAmount(after.collateral, tokens(1), "路人的抵押物不能凭空变多");
  });

  it("decimals=0 的抵押物兑奖同样守恒", async () => {
    const mint0 = await createCollateralMint(env, 0);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint0,
      collateralAmount: tokens(8, 0),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "玩家", mint0, tokens(2, 0));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(2, 0),
      tokenType: "yes",
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");

    const before = await readPosition(env, market, trader.pubkey);
    const claim = before.yes;
    assert.ok(claim > 0n, "用例前提：玩家应持有 Yes");
    await sendGetCollateral(env, trader, market, market.yesMint, claim);
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, 0n, "获胜代币应烧完");
    eqAmount(after.collateral, before.collateral + claim, "兑出等额抵押物");
    eqAmount(after.vault, before.vault - claim, "金库减少等额抵押物");
  });

  it("作废后 Yes/No 都能按半价兑抵押物", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(80),
      expireInSeconds: 20,
    });
    const yesTrader = await newFundedUser(env, "Yes玩家", mint, tokens(10));
    const noTrader = await newFundedUser(env, "No玩家", mint, tokens(10));
    await sendUserBetOn(env, yesTrader, market, {
      collateralAmount: tokens(10),
      tokenType: "yes",
    });
    await sendUserBetOn(env, noTrader, market, {
      collateralAmount: tokens(10),
      tokenType: "no",
    });
    await waitUntilExpired(env, market);
    await sendVoidMarket(env, house, market);
    const onchain = await fetchMarket(env, market);
    sameJson(onchain.status, { burn: {} }, "本用例应已作废");

    const yesBefore = await readPosition(env, market, yesTrader.pubkey);
    const yesClaim = yesBefore.yes - (yesBefore.yes % 2n);
    assert.ok(yesClaim >= 2n, "用例前提：Yes 玩家应有至少 2 个可兑");
    await sendGetCollateral(env, yesTrader, market, market.yesMint, yesClaim);
    const yesAfter = await readPosition(env, market, yesTrader.pubkey);
    eqAmount(yesAfter.yes, yesBefore.yes - yesClaim, "作废兑奖应烧掉 Yes");
    eqAmount(
      yesAfter.collateral,
      yesBefore.collateral + yesClaim / 2n,
      "Yes 应按半价兑出"
    );
    eqAmount(yesAfter.vault, yesBefore.vault - yesClaim / 2n, "金库按半价减少");

    const noBefore = await readPosition(env, market, noTrader.pubkey);
    const noClaim = noBefore.no - (noBefore.no % 2n);
    assert.ok(noClaim >= 2n, "用例前提：No 玩家应有至少 2 个可兑");
    await sendGetCollateral(env, noTrader, market, market.noMint, noClaim);
    const noAfter = await readPosition(env, market, noTrader.pubkey);
    eqAmount(noAfter.no, noBefore.no - noClaim, "作废兑奖应烧掉 No");
    eqAmount(
      noAfter.collateral,
      noBefore.collateral + noClaim / 2n,
      "No 应按半价兑出"
    );
  });

  it("作废后兑 1 个代币会失败", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(40),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(4));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(4),
      tokenType: "yes",
    });
    await waitUntilExpired(env, market);
    await sendVoidMarket(env, house, market);
    const pos = await readPosition(env, market, trader.pubkey);
    assert.ok(pos.yes >= 1n, "用例前提：玩家应持有 Yes");
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, market.yesMint, 1n),
      "InvalidAmount"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "失败的半价兑不能烧币");
    eqAmount(after.vault, pos.vault, "金库不受影响");
  });
});