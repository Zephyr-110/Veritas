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

describe("redeem get_collateral", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });


  // build a resolved market, Yes wins, trader holds the winning token
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
    const trader = await newFundedUser(env, "trader", mint, tokens(10));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(10),
      tokenType: "yes",
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");
    return { market, trader };
  }

  it("winner burns the winning token and redeems collateral 1:1 from the vault", async () => {
    const { market, trader } = await resolvedYesMarket();
    const before = await readPosition(env, market, trader.pubkey);
    const claim = before.yes;
    assert.ok(claim > 0n, "precondition: trader should hold Yes");
    await sendGetCollateral(env, trader, market, market.yesMint, claim);
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.yes, 0n, "winning tokens should be burned");
    eqAmount(after.collateral, before.collateral + claim, "redeem equal collateral");
    eqAmount(after.vault, before.vault - claim, "vault decreases by equal collateral");
    eqAmount(
      await mintSupply(env, market.yesMint),
      after.vault,
      "winning-token supply should decrease in lockstep with the vault"
    );
    eqAmount(
      await mintSupply(env, market.noMint),
      before.vault,
      "losing-token supply is unaffected by redeem and still equals the pre-redeem vault"
    );
  });

  it("cannot redeem before resolve", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(20),
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(2));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(2),
      tokenType: "yes",
    });
    const pos = await readPosition(env, market, trader.pubkey);
    assert.ok(pos.yes > 0n, "precondition: trader should hold Yes");
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, market.yesMint, pos.yes),
      "MarketNotResolved"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "a failed redeem must not burn tokens");
    eqAmount(after.vault, pos.vault, "vault is unaffected");
  });

  it("losing tokens cannot be redeemed", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(40),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(4));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(4),
      tokenType: "yes",
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "no");
    const pos = await readPosition(env, market, trader.pubkey);
    assert.ok(pos.yes > 0n, "precondition: trader should hold Yes");
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, market.yesMint, pos.yes),
      "NotWinnerMint"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "a failed redeem must not burn tokens");
    eqAmount(after.no, pos.no, "losing-token balance is unaffected");
  });

  it("when No wins, No holders also redeem collateral 1:1", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(80),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(10));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(10),
      tokenType: "no",
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "no");

    const before = await readPosition(env, market, trader.pubkey);
    const claim = before.no;
    assert.ok(claim > 0n, "this case needs the trader to hold No");
    await sendGetCollateral(env, trader, market, market.noMint, claim);
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.no, 0n, "winning No should be fully burned");
    eqAmount(after.collateral, before.collateral + claim, "redeem equal collateral");
    eqAmount(after.vault, before.vault - claim, "vault decreases by equal collateral");
    eqAmount(
      await mintSupply(env, market.noMint),
      after.vault,
      "No supply should decrease in lockstep with the vault"
    );
    eqAmount(
      await mintSupply(env, market.yesMint),
      before.vault,
      "Yes supply is unaffected by redeem and still equals the pre-redeem vault"
    );
  });

  it("redeem only part; the rest can still be redeemed (two-step conservation)", async () => {
    const { market, trader } = await resolvedYesMarket();
    const before = await readPosition(env, market, trader.pubkey);
    const half = before.yes / 2n;
    assert.ok(half > 0n, "precondition: Yes amount should be enough to split in half");
    await sendGetCollateral(env, trader, market, market.yesMint, half);
    const mid = await readPosition(env, market, trader.pubkey);
    eqAmount(mid.yes, before.yes - half, "first half redeemed, the remaining half is still there");
    eqAmount(mid.collateral, before.collateral + half, "first half returns equal collateral");
    eqAmount(mid.vault, before.vault - half, "vault deducts the first half");
    eqAmount(await mintSupply(env, market.yesMint), mid.vault, "after redeeming half, supply still equals the vault");

    await sendGetCollateral(env, trader, market, market.yesMint, mid.yes);
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, 0n, "second half redeems to zero");
    eqAmount(after.vault, before.vault - before.yes, "vault finally deducts the full amount");
    eqAmount(after.collateral, before.collateral + before.yes, "collateral is fully received in the end");
  });

  it("over-redeem rejected: amount = balance + 1", async () => {
    const { market, trader } = await resolvedYesMarket();
    const pos = await readPosition(env, market, trader.pubkey);
    await assertTxFails(
      () =>
        sendGetCollateral(env, trader, market, market.yesMint, pos.yes + 1n),
      "InsufficientBalance"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "a failed over-redeem must not burn tokens");
    eqAmount(after.vault, pos.vault, "vault is unaffected");
    eqAmount(after.collateral, pos.collateral, "collateral is unaffected");
  });

  it("amount = 0 is rejected", async () => {
    const { market, trader } = await resolvedYesMarket();
    const pos = await readPosition(env, market, trader.pubkey);
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, market.yesMint, 0n),
      "InvalidAmount"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "amount=0 must not burn tokens");
  });

  it("a second redeem after a full redeem is rejected", async () => {
    const { market, trader } = await resolvedYesMarket();
    const pos = await readPosition(env, market, trader.pubkey);
    await sendGetCollateral(env, trader, market, market.yesMint, pos.yes);
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, market.yesMint, 1n),
      "InsufficientBalance"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, 0n, "fully redeemed token balance stays at zero");
    eqAmount(after.vault, pos.vault - pos.yes, "vault already deducted the first redeem and must not change");
  });

  it("redeeming against another market's vault is rejected by seeds", async () => {
    const { market: marketA, trader } = await resolvedYesMarket();
    const marketB = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(20),
    });
    assert.ok(
      !marketA.collateralVault.equals(marketB.collateralVault),
      "vaults of the two markets must differ, otherwise this case is meaningless"
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
    eqAmount(after.yes, pos.yes, "cross-market redeem fails; tokens must not be burned");
    eqAmount(after.vault, pos.vault, "cross-market redeem fails; vault is unchanged");
    const marketBVault = await readPosition(env, marketB, house.pubkey);
    eqAmount(marketBVault.vault, tokens(20), "the other market's vault is also untouched");
  });

  it("redeeming another market's token is rejected", async () => {
    const { market: marketA, trader } = await resolvedYesMarket();
    const marketB = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(20),
    });
    assert.ok(
      !marketA.yesMint.equals(marketB.yesMint),
      "Yes mints of the two markets must differ, otherwise this case is meaningless"
    );
    await openTokenAccount(env, marketB.yesMint, trader.pubkey);
    const pos = await readPosition(env, marketA, trader.pubkey);
    await assertTxFails(
      () =>
        sendGetCollateral(env, trader, marketA, marketB.yesMint, pos.yes),
      "InvalidMint"
    );
    const after = await readPosition(env, marketA, trader.pubkey);
    eqAmount(after.yes, pos.yes, "cross-market token redeem fails; tokens must not be burned");
  });

  it("an unrelated third-party token is rejected", async () => {
    const { market, trader } = await resolvedYesMarket();
    const thirdMint = await createCollateralMint(env);
    await openTokenAccount(env, thirdMint, trader.pubkey);
    const pos = await readPosition(env, market, trader.pubkey);
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, thirdMint, pos.yes),
      "InvalidMint"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "third-party token redeem fails; tokens must not be burned");
  });

  it("cannot redeem using someone else's token account", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(80),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(10));
    const stranger = await newFundedUser(env, "stranger", mint, tokens(1));
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
    assert.ok(strangerPos.yes > 0n, "precondition: stranger should hold their own Yes");
    await assertTxFails(
      () =>
        sendGetCollateral(env, trader, market, market.yesMint, strangerPos.yes, {
          tokenAta: ataOf(market.yesMint, stranger.pubkey),
        }),
      "ConstraintTokenOwner"
    );
    const strangerAfter = await readPosition(env, market, stranger.pubkey);
    eqAmount(strangerAfter.yes, strangerPos.yes, "stranger tokens cannot be stolen");
    eqAmount(strangerAfter.collateral, strangerPos.collateral, "stranger collateral cannot be stolen");
  });

  it("a trader with no position cannot redeem collateral", async () => {
    const { market } = await resolvedYesMarket();
    const stranger = await newFundedUser(env, "stranger", mint, tokens(1));
    await openTokenAccount(env, market.yesMint, stranger.pubkey);
    await assertTxFails(
      () => sendGetCollateral(env, stranger, market, market.yesMint, 1n),
      "InsufficientBalance"
    );
    const after = await readPosition(env, market, stranger.pubkey);
    eqAmount(after.collateral, tokens(1), "stranger collateral cannot increase out of nowhere");
  });

  it("redeem with 0-decimal collateral is still conserved", async () => {
    const mint0 = await createCollateralMint(env, 0);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint0,
      collateralAmount: tokens(8, 0),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "trader", mint0, tokens(2, 0));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(2, 0),
      tokenType: "yes",
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");

    const before = await readPosition(env, market, trader.pubkey);
    const claim = before.yes;
    assert.ok(claim > 0n, "precondition: trader should hold Yes");
    await sendGetCollateral(env, trader, market, market.yesMint, claim);
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, 0n, "winning tokens should be burned");
    eqAmount(after.collateral, before.collateral + claim, "redeem equal collateral");
    eqAmount(after.vault, before.vault - claim, "vault decreases by equal collateral");
  });

  it("after void, both Yes and No redeem collateral at half price", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(80),
      expireInSeconds: 20,
    });
    const yesTrader = await newFundedUser(env, "Yes trader", mint, tokens(10));
    const noTrader = await newFundedUser(env, "No trader", mint, tokens(10));
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
    sameJson(onchain.status, { burn: {} }, "this case should already be voided");

    const yesBefore = await readPosition(env, market, yesTrader.pubkey);
    const yesClaim = yesBefore.yes - (yesBefore.yes % 2n);
    assert.ok(yesClaim >= 2n, "precondition: Yes trader should have at least 2 to redeem");
    await sendGetCollateral(env, yesTrader, market, market.yesMint, yesClaim);
    const yesAfter = await readPosition(env, market, yesTrader.pubkey);
    eqAmount(yesAfter.yes, yesBefore.yes - yesClaim, "void redeem should burn Yes");
    eqAmount(
      yesAfter.collateral,
      yesBefore.collateral + yesClaim / 2n,
      "Yes should redeem at half price"
    );
    eqAmount(yesAfter.vault, yesBefore.vault - yesClaim / 2n, "vault decreases at half price");

    const noBefore = await readPosition(env, market, noTrader.pubkey);
    const noClaim = noBefore.no - (noBefore.no % 2n);
    assert.ok(noClaim >= 2n, "precondition: No trader should have at least 2 to redeem");
    await sendGetCollateral(env, noTrader, market, market.noMint, noClaim);
    const noAfter = await readPosition(env, market, noTrader.pubkey);
    eqAmount(noAfter.no, noBefore.no - noClaim, "void redeem should burn No");
    eqAmount(
      noAfter.collateral,
      noBefore.collateral + noClaim / 2n,
      "No should redeem at half price"
    );
  });

  it("redeeming 1 token after void should fail", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(40),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(4));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(4),
      tokenType: "yes",
    });
    await waitUntilExpired(env, market);
    await sendVoidMarket(env, house, market);
    const pos = await readPosition(env, market, trader.pubkey);
    assert.ok(pos.yes >= 1n, "precondition: trader should hold Yes");
    await assertTxFails(
      () => sendGetCollateral(env, trader, market, market.yesMint, 1n),
      "InvalidAmount"
    );
    const after = await readPosition(env, market, trader.pubkey);
    eqAmount(after.yes, pos.yes, "a failed half-price redeem must not burn tokens");
    eqAmount(after.vault, pos.vault, "vault is unaffected");
  });
});