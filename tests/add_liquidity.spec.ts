import * as assert from "assert";
import { PublicKey } from "@solana/web3.js";
import {
  assertTxFails,
  createCollateralMint,
  eqAmount,
  getHouse,
  getTestEnv,
  makeOpenMarket,
  mintSupply,
  mintToUser,
  newFundedUser,
  quoteAddLiquidity,
  readPosition,
  sendAddLiquidity,
  sendResolveMarket,
  sendUserBetOn,
  TestEnv,
  tokens,
  User,
} from "./helpers";

describe("add liquidity add_liquidity", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("when pools are balanced, LP deposits 1:1 and receives matching shares", async () => {
    const start = tokens(100);
    const add = tokens(40);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: start,
    });
    const lp = await newFundedUser(env, "LP", mint, add);

    const before = await readPosition(env, market, lp.pubkey);
    const quote = quoteAddLiquidity(
      before.yesPool,
      before.noPool,
      before.lpSupply,
      add
    );
    await sendAddLiquidity(env, lp, market, add);
    const after = await readPosition(env, market, lp.pubkey);

    eqAmount(after.vault, before.vault + add, "vault should increase by the LP collateral");
    eqAmount(after.yesPool, before.yesPool + quote.yesIn, "Yes pool");
    eqAmount(after.noPool, before.noPool + quote.noIn, "No pool");
    eqAmount(after.lp, quote.lpOut, "LP shares");
    eqAmount(after.yes, add - quote.yesIn, "Yes not deposited stays with the LP");
    eqAmount(after.no, add - quote.noIn, "No not deposited stays with the LP");
  });

  it("when pools are skewed, both sides deposit pro rata and LP is minted from the Yes increment", async () => {
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

    const lp = await newFundedUser(env, "LP", mint, tokens(40));
    const add = tokens(40);
    const before = await readPosition(env, market, lp.pubkey);
    assert.ok(before.yesPool !== before.noPool, "this case needs skewed pools");
    const quote = quoteAddLiquidity(
      before.yesPool,
      before.noPool,
      before.lpSupply,
      add
    );
    assert.ok(quote.yesIn < add, "when skewed, both sides should not deposit in full");
    assert.ok(quote.noIn <= add, "deposit amount must not exceed tokens the LP holds");

    await sendAddLiquidity(env, lp, market, add);
    const after = await readPosition(env, market, lp.pubkey);

    eqAmount(after.yesPool, before.yesPool + quote.yesIn, "Yes deposited into the pool");
    eqAmount(after.noPool, before.noPool + quote.noIn, "No deposited into the pool");
    eqAmount(after.lp, quote.lpOut, "LP is minted from the Yes pool increment");
    eqAmount(after.yes, add - quote.yesIn, "Yes not deposited stays with the LP");
    eqAmount(after.no, add - quote.noIn, "No not deposited stays with the LP");

    const idealNoPool = (after.yesPool * before.noPool) / before.yesPool;
    const drift =
      after.noPool > idealNoPool
        ? after.noPool - idealNoPool
        : idealNoPool - after.noPool;
    assert.ok(drift <= 1n, `pool ratio drift after deposit should be at most 1 unit, got ${drift}`);

    const yesSupply = await mintSupply(env, market.yesMint);
    const noSupply = await mintSupply(env, market.noMint);
    eqAmount(yesSupply, noSupply, "deposit should mint equal Yes/No");
    eqAmount(after.vault, yesSupply, "vault should equal one-side total supply");
  });

  it("add liquidity fails when collateral amount is 0", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });
    await mintToUser(env, mint, house.pubkey, tokens(1));
    await assertTxFails(
      () => sendAddLiquidity(env, house, market, 0n),
      "InvalidAmount"
    );
  });

  it("cannot add liquidity after the market is resolved", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await sendResolveMarket(env, house, market, "yes");
    await mintToUser(env, mint, house.pubkey, tokens(10));
    await assertTxFails(
      () => sendAddLiquidity(env, house, market, tokens(10)),
      "MarketNotOpen"
    );
  });
});
