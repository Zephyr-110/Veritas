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

describe("swap", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("swap Yes for No; amount follows the constant-product formula", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(20));
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

    eqAmount(after.yes, before.yes - sellYes, "Yes decreases by the sold amount");
    eqAmount(after.no, before.no + out, "No increases by the output");
    eqAmount(after.yesPool, before.yesPool + sellYes, "Yes pool takes in");
    eqAmount(after.noPool, before.noPool - out, "No pool output");
  });

  it("with 0-decimal collateral, swap output still matches the formula", async () => {
    const mint0 = await createCollateralMint(env, 0);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint0,
      collateralAmount: tokens(100, 0),
      decimals: 0,
    });
    const trader = await newFundedUser(env, "trader", mint0, tokens(20, 0));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(20, 0),
      tokenType: "yes",
    });

    const before = await readPosition(env, market, trader.pubkey);
    const sellYes = tokens(5, 0);
    const out = quoteSwapOut(before.noPool, before.yesPool, sellYes);
    assert.ok(out > 0n, "5 units should yield a non-zero output");
    await sendSwap(env, trader, market, {
      amountIn: sellYes,
      tokenType: "no",
    });
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.no, before.no + out, "output matches the formula");
  });

  it("input below fee granularity yields 0 and is blocked by slippage", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(1));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(1),
      tokenType: "yes",
    });
    const before = await readPosition(env, market, trader.pubkey);
    eqAmount(quoteSwapOut(before.noPool, before.yesPool, 1n), 0n, "1 unit should not redeem anything");
    await assertTxFails(
      () =>
        sendSwap(env, trader, market, {
          amountIn: 1n,
          tokenType: "no",
        }),
      "SlippageExceeded"
    );
  });

  it("swap fails when balance is insufficient", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(50),
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(5));
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

  it("minOut too high triggers slippage protection", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(50),
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(5));
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

  it("swap succeeds when minOut equals the formula output exactly", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(20));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(20),
      tokenType: "yes",
    });

    const before = await readPosition(env, market, trader.pubkey);
    const sellYes = tokens(5);
    const out = quoteSwapOut(before.noPool, before.yesPool, sellYes);
    assert.ok(out > 0n, "this case needs a non-zero output");
    await sendSwap(env, trader, market, {
      amountIn: sellYes,
      tokenType: "no",
      minOut: out,
    });
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.no, before.no + out, "minOut that exactly matches should pass");
    eqAmount(after.noPool, before.noPool - out, "No pool output");
  });

  it("when pools are clearly skewed, output still matches the formula and is non-zero", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(5000),
    });
    const trader = await newFundedUser(env, "retail", mint, tokens(5));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(5),
      tokenType: "yes",
    });

    const before = await readPosition(env, market, trader.pubkey);
    const sellYes = tokens(5);
    const out = quoteSwapOut(before.noPool, before.yesPool, sellYes);
    assert.ok(out > 0n, "a tiny swap should not be rounded to zero");
    await sendSwap(env, trader, market, {
      amountIn: sellYes,
      tokenType: "no",
    });
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.no, before.no + out, "output matches the formula");
    eqAmount(after.noPool, before.noPool - out, "No pool output");
  });

  it("cannot swap after expiry if unresolved", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      expireInSeconds: 2,
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(1));
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

  it("cannot swap after resolve", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await sendResolveMarket(env, house, market, "yes");
    const trader = await newFundedUser(env, "trader", mint, tokens(1));
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
