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

describe("bet user_bet_on", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("buy Yes: split a complete set, then sell No into the pool", async () => {
    const start = tokens(100);
    const bet = tokens(10);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: start,
    });
    const trader = await newFundedUser(env, "trader", mint, bet);

    const before = await readPosition(env, market, trader.pubkey);
    const out = quoteSwapOut(before.yesPool, before.noPool, bet);
    await sendUserBetOn(env, trader, market, {
      collateralAmount: bet,
      tokenType: "yes",
    });
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.collateral, before.collateral - bet, "trader collateral decreases");
    eqAmount(after.vault, before.vault + bet, "vault increases");
    eqAmount(after.no, 0n, "all No should be sold into the pool");
    eqAmount(after.yes, bet + out, "trader Yes = split amount + swap output");
    eqAmount(after.yesPool, before.yesPool - out, "Yes pool decreases by the output");
    eqAmount(after.noPool, before.noPool + bet, "No pool takes in the sold No");
  });

  it("buy No: the symmetric path holds", async () => {
    const start = tokens(100);
    const bet = tokens(8);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: start,
    });
    const trader = await newFundedUser(env, "trader", mint, bet);
    const before = await readPosition(env, market, trader.pubkey);
    const out = quoteSwapOut(before.noPool, before.yesPool, bet);

    await sendUserBetOn(env, trader, market, {
      collateralAmount: bet,
      tokenType: "no",
    });
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.yes, 0n, "all Yes should be sold into the pool");
    eqAmount(after.no, bet + out, "trader No balance");
    eqAmount(after.noPool, before.noPool - out, "No pool decreases by the output");
    eqAmount(after.yesPool, before.yesPool + bet, "Yes pool takes in the sold Yes");
  });

  it("a zero bet fails", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(1));
    await assertTxFails(
      () =>
        sendUserBetOn(env, trader, market, {
          collateralAmount: 0n,
          tokenType: "yes",
        }),
      "InvalidAmount"
    );
  });

  it("minOut too high triggers slippage protection", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(50),
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(5));
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

  it("cannot bet after the market is resolved", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await sendResolveMarket(env, house, market, "yes");
    const trader = await newFundedUser(env, "trader", mint, tokens(1));
    await assertTxFails(
      () =>
        sendUserBetOn(env, trader, market, {
          collateralAmount: tokens(1),
          tokenType: "yes",
        }),
      "MarketNotOpen"
    );
  });

  it("cannot bet after expiry if unresolved", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      expireInSeconds: 2,
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(1));
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

  it("betting with another market's vault is rejected by seeds", async () => {
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
      "vaults of the two markets must differ, otherwise this case is meaningless"
    );
    const trader = await newFundedUser(env, "trader", mint, tokens(1));
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
  it("oracle cannot bet; creator can", async () => {
    const oracle = await newFundedUser(env, "oracle", mint, tokens(2));
    const creator = await newFundedUser(env, "creator", mint, tokens(30));
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
    assert.ok(pos.yes > 0n, "creator should receive Yes");
  });
});
