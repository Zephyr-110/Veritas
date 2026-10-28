import * as assert from "assert";
import { PublicKey } from "@solana/web3.js";
import {
  assertTxFails,
  createCollateralMint,
  eqAmount,
  getHouse,
  getTestEnv,
  makeOpenMarket,
  newFundedUser,
  quoteSwapOut,
  readPosition,
  sendResolveMarket,
  sendUserBetOn,
  TestEnv,
  tokens,
  User,
  waitUntilExpired,
} from "./helpers";

describe("下注 user_bet_on", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("买 Yes：先拆成完整套，再把 No 卖进池子", async () => {
    const start = tokens(100);
    const bet = tokens(10);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: start,
    });
    const trader = await newFundedUser(env, "玩家", mint, bet);

    const before = await readPosition(env, market, trader.pubkey);
    const out = quoteSwapOut(before.yesPool, before.noPool, bet);
    await sendUserBetOn(env, trader, market, {
      collateralAmount: bet,
      tokenType: "yes",
    });
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.collateral, before.collateral - bet, "玩家抵押物减少");
    eqAmount(after.vault, before.vault + bet, "金库增加");
    eqAmount(after.no, 0n, "No 应全部卖进池子");
    eqAmount(after.yes, bet + out, "玩家手里的 Yes = 拆套数量 + 换出数量");
    eqAmount(after.yesPool, before.yesPool - out, "Yes 池减少兑出量");
    eqAmount(after.noPool, before.noPool + bet, "No 池吃进卖出的 No");
  });

  it("买 No：对称路径成立", async () => {
    const start = tokens(100);
    const bet = tokens(8);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: start,
    });
    const trader = await newFundedUser(env, "玩家", mint, bet);
    const before = await readPosition(env, market, trader.pubkey);
    const out = quoteSwapOut(before.noPool, before.yesPool, bet);

    await sendUserBetOn(env, trader, market, {
      collateralAmount: bet,
      tokenType: "no",
    });
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.yes, 0n, "Yes 应全部卖进池子");
    eqAmount(after.no, bet + out, "玩家手里的 No");
    eqAmount(after.noPool, before.noPool - out, "No 池减少兑出量");
    eqAmount(after.yesPool, before.yesPool + bet, "Yes 池吃进卖出的 Yes");
  });

  it("下注数量为 0 会失败", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(1));
    await assertTxFails(
      () =>
        sendUserBetOn(env, trader, market, {
          collateralAmount: 0n,
          tokenType: "yes",
        }),
      "InvalidAmount"
    );
  });

  it("minOut 过大时触发滑点保护", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(50),
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(5));
    await assertTxFails(
      () =>
        sendUserBetOn(env, trader, market, {
          collateralAmount: tokens(5),
          tokenType: "yes",
          minOut: tokens(1000000),
        }),
      "SlippageExceeded"
    );
  });

  it("盘口已裁决后不能再下注", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await sendResolveMarket(env, house, market, "yes");
    const trader = await newFundedUser(env, "玩家", mint, tokens(1));
    await assertTxFails(
      () =>
        sendUserBetOn(env, trader, market, {
          collateralAmount: tokens(1),
          tokenType: "yes",
        }),
      "MarketNotOpen"
    );
  });

  it("过期但未裁决时不能下注", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      expireInSeconds: 2,
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(1));
    await waitUntilExpired(env, market);
    await assertTxFails(
      () =>
        sendUserBetOn(env, trader, market, {
          collateralAmount: tokens(1),
          tokenType: "yes",
        }),
      "MarketExpired"
    );
  });

  it("拿别的盘口的金库来下注会被 seeds 约束拦下", async () => {
    const marketA = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });
    const marketB = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });
    assert.ok(
      !marketA.collateralVault.equals(marketB.collateralVault),
      "两个盘口的金库地址必须不同，否则本用例无意义"
    );
    const trader = await newFundedUser(env, "玩家", mint, tokens(1));
    await assertTxFails(
      () =>
        sendUserBetOn(env, trader, marketA, {
          collateralAmount: tokens(1),
          tokenType: "yes",
          collateralVault: marketB.collateralVault,
        }),
      "ConstraintSeeds"
    );
  });
  it("预言机不能下注，开盘人可以", async () => {
    const oracle = await newFundedUser(env, "预言机", mint, tokens(2));
    const creator = await newFundedUser(env, "开盘人", mint, tokens(30));
    const market = await makeOpenMarket(env, {
      creator,
      oracle,
      collateralMint: mint,
      collateralAmount: tokens(20),
    });
    await assertTxFails(
      () =>
        sendUserBetOn(env, oracle, market, {
          collateralAmount: tokens(1),
          tokenType: "yes",
        }),
      "AuthorityCannotTrade"
    );
    await sendUserBetOn(env, creator, market, {
      collateralAmount: tokens(1),
      tokenType: "yes",
    });
    const pos = await readPosition(env, market, creator.pubkey);
    assert.ok(pos.yes > 0n, "开盘人应能拿到 Yes");
  });
});
