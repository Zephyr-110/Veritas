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
  openTokenAccount,
  quoteSwapOut,
  readPosition,
  sendResolveMarket,
  sendSwap,
  sendUserBetOn,
  TestEnv,
  tokens,
  User,
  waitUntilExpired,
} from "./helpers";

describe("换汇 swap", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("把手里的 Yes 换成 No，数量按恒定乘积公式走", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(20));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(20),
      tokenType: "yes",
    });

    const before = await readPosition(env, market, trader.pubkey);
    const sellYes = tokens(5);
    const out = quoteSwapOut(before.noPool, before.yesPool, sellYes);
    await sendSwap(env, trader, market, {
      amountIn: sellYes,
      tokenType: "no",
    });
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.yes, before.yes - sellYes, "Yes 减少卖出量");
    eqAmount(after.no, before.no + out, "No 增加兑出量");
    eqAmount(after.yesPool, before.yesPool + sellYes, "Yes 池吃进");
    eqAmount(after.noPool, before.noPool - out, "No 池兑出");
  });

  it("0 位精度抵押币下，换汇结果仍与公式一致", async () => {
    const mint0 = await createCollateralMint(env, 0);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint0,
      collateralAmount: tokens(100, 0),
      decimals: 0,
    });
    const trader = await newFundedUser(env, "玩家", mint0, tokens(20, 0));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(20, 0),
      tokenType: "yes",
    });

    const before = await readPosition(env, market, trader.pubkey);
    const sellYes = tokens(5, 0);
    const out = quoteSwapOut(before.noPool, before.yesPool, sellYes);
    assert.ok(out > 0n, "5 个最小单位应兑出非零");
    await sendSwap(env, trader, market, {
      amountIn: sellYes,
      tokenType: "no",
    });
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.no, before.no + out, "兑出量与公式一致");
  });

  it("输入小于手续费粒度时兑出为 0，被滑点保护拦下", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(1));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(1),
      tokenType: "yes",
    });
    const before = await readPosition(env, market, trader.pubkey);
    eqAmount(quoteSwapOut(before.noPool, before.yesPool, 1n), 0n, "1 个最小单位应兑不出");
    await assertTxFails(
      () =>
        sendSwap(env, trader, market, {
          amountIn: 1n,
          tokenType: "no",
        }),
      "SlippageExceeded"
    );
  });

  it("余额不够时换汇失败", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(50),
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(5));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(5),
      tokenType: "yes",
    });
    await assertTxFails(
      () =>
        sendSwap(env, trader, market, {
          amountIn: tokens(1000000),
          tokenType: "no",
        }),
      "InsufficientBalance"
    );
  });

  it("minOut 过大时触发滑点保护", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(50),
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(5));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(5),
      tokenType: "yes",
    });
    await assertTxFails(
      () =>
        sendSwap(env, trader, market, {
          amountIn: tokens(1),
          tokenType: "no",
          minOut: tokens(1000000),
        }),
      "SlippageExceeded"
    );
  });

  it("minOut 恰好等于公式输出时，换汇成功", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(20));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(20),
      tokenType: "yes",
    });

    const before = await readPosition(env, market, trader.pubkey);
    const sellYes = tokens(5);
    const out = quoteSwapOut(before.noPool, before.yesPool, sellYes);
    assert.ok(out > 0n, "本用例需要一个非零兑出量");
    await sendSwap(env, trader, market, {
      amountIn: sellYes,
      tokenType: "no",
      minOut: out,
    });
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.no, before.no + out, "恰好达标的 minOut 应放行");
    eqAmount(after.noPool, before.noPool - out, "No 池兑出");
  });

  it("池子明显倾斜时，兑出量仍与公式一致且不为 0", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(5000),
    });
    const trader = await newFundedUser(env, "小散", mint, tokens(5));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(5),
      tokenType: "yes",
    });

    const before = await readPosition(env, market, trader.pubkey);
    const sellYes = tokens(5);
    const out = quoteSwapOut(before.noPool, before.yesPool, sellYes);
    assert.ok(out > 0n, "小单换汇不应被取整吞没");
    await sendSwap(env, trader, market, {
      amountIn: sellYes,
      tokenType: "no",
    });
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.no, before.no + out, "兑出量与公式一致");
    eqAmount(after.noPool, before.noPool - out, "No 池兑出");
  });

  it("过期但未裁决时不能换汇", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      expireInSeconds: 2,
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(1));
    await openTokenAccount(env, market.yesMint, trader.pubkey);
    await openTokenAccount(env, market.noMint, trader.pubkey);
    await waitUntilExpired(env, market);
    await assertTxFails(
      () =>
        sendSwap(env, trader, market, {
          amountIn: tokens(1),
          tokenType: "no",
        }),
      "MarketExpired"
    );
  });

  it("裁决后不能换汇", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await sendResolveMarket(env, house, market, "yes");
    const trader = await newFundedUser(env, "玩家", mint, tokens(1));
    await openTokenAccount(env, market.yesMint, trader.pubkey);
    await openTokenAccount(env, market.noMint, trader.pubkey);
    await assertTxFails(
      () =>
        sendSwap(env, trader, market, {
          amountIn: tokens(1),
          tokenType: "no",
        }),
      "MarketNotOpen"
    );
  });
});
