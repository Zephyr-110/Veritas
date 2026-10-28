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

describe("加流动性 add_liquidity", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("池子平衡时，做市商按 1:1 注入并拿到对应份额", async () => {
    const start = tokens(100);
    const add = tokens(40);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: start,
    });
    const lp = await newFundedUser(env, "做市商", mint, add);

    const before = await readPosition(env, market, lp.pubkey);
    const quote = quoteAddLiquidity(
      before.yesPool,
      before.noPool,
      before.lpSupply,
      add
    );
    await sendAddLiquidity(env, lp, market, add);
    const after = await readPosition(env, market, lp.pubkey);

    eqAmount(after.vault, before.vault + add, "金库应增加做市商抵押物");
    eqAmount(after.yesPool, before.yesPool + quote.yesIn, "Yes 池");
    eqAmount(after.noPool, before.noPool + quote.noIn, "No 池");
    eqAmount(after.lp, quote.lpOut, "做市商份额");
    eqAmount(after.yes, add - quote.yesIn, "没入池的 Yes 留在做市商手里");
    eqAmount(after.no, add - quote.noIn, "没入池的 No 留在做市商手里");
  });

  it("池子倾斜时两边按比例入池，份额按 Yes 池增量发放", async () => {
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

    const lp = await newFundedUser(env, "做市商", mint, tokens(40));
    const add = tokens(40);
    const before = await readPosition(env, market, lp.pubkey);
    assert.ok(before.yesPool !== before.noPool, "本用例需要倾斜的池子");
    const quote = quoteAddLiquidity(
      before.yesPool,
      before.noPool,
      before.lpSupply,
      add
    );
    assert.ok(quote.yesIn < add, "倾斜时不应两边都全量入池");
    assert.ok(quote.noIn <= add, "入池量不应超过做市商手里的代币");

    await sendAddLiquidity(env, lp, market, add);
    const after = await readPosition(env, market, lp.pubkey);

    eqAmount(after.yesPool, before.yesPool + quote.yesIn, "Yes 池入池量");
    eqAmount(after.noPool, before.noPool + quote.noIn, "No 池入池量");
    eqAmount(after.lp, quote.lpOut, "份额按 Yes 池增量发放");
    eqAmount(after.yes, add - quote.yesIn, "没入池的 Yes 留在做市商手里");
    eqAmount(after.no, add - quote.noIn, "没入池的 No 留在做市商手里");

    const idealNoPool = (after.yesPool * before.noPool) / before.yesPool;
    const drift =
      after.noPool > idealNoPool
        ? after.noPool - idealNoPool
        : idealNoPool - after.noPool;
    assert.ok(drift <= 1n, `入池后两池比例偏差应不超过 1 个最小单位，实际 ${drift}`);

    const yesSupply = await mintSupply(env, market.yesMint);
    const noSupply = await mintSupply(env, market.noMint);
    eqAmount(yesSupply, noSupply, "注资应等量铸造 Yes/No");
    eqAmount(after.vault, yesSupply, "金库应等于单边总供给");
  });

  it("抵押数量为 0 时加流动性失败", async () => {
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

  it("盘口已裁决后不能再加流动性", async () => {
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
