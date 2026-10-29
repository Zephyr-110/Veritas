import * as assert from "assert";
import { PublicKey } from "@solana/web3.js";
import {
  createCollateralMint,
  eqAmount,
  fetchMarket,
  getHouse,
  getTestEnv,
  makeOpenMarket,
  mintSupply,
  newFundedUser,
  openTokenAccount,
  readPosition,
  sameJson,
  sendAddLiquidity,
  sendGetCollateral,
  sendGetLiquidity,
  sendMergeToken,
  sendResolveMarket,
  sendSwap,
  sendUserBetOn,
  TestEnv,
  tokens,
  User,
  waitUntilExpired,
} from "./helpers";

describe("full round full_round", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("create → LP → bet → swap → merge → expire/resolve → redeem → withdraw LP", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
      expireInSeconds: 40,
      title: "full round market",
    });

    const lp = await newFundedUser(env, "LP", mint, tokens(30));
    await sendAddLiquidity(env, lp, market, tokens(30));

    const trader = await newFundedUser(env, "trader", mint, tokens(20));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(20),
      tokenType: "yes",
    });
    await sendSwap(env, trader, market, {
      amountIn: tokens(4),
      tokenType: "no",
    });

    const beforeMerge = await readPosition(env, market, trader.pubkey);
    const mergeAmount =
      beforeMerge.yes < beforeMerge.no ? beforeMerge.yes : beforeMerge.no;
    assert.ok(mergeAmount > 0n, "this round should have a complete set to merge");
    await sendMergeToken(env, trader, market, mergeAmount);

    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");

    const resolved = await fetchMarket(env, market);
    sameJson(resolved.status, { resolved: {} }, "the full round should be resolved at the end");
    sameJson(resolved.winner, { yes: {} }, "winner of this round is Yes");

    const beforeClaim = await readPosition(env, market, trader.pubkey);
    assert.ok(beforeClaim.yes > 0n, "this round should have redeemable winning tokens");
    await sendGetCollateral(env, trader, market, market.yesMint, beforeClaim.yes);
    const afterClaim = await readPosition(env, market, trader.pubkey);
    eqAmount(afterClaim.yes, 0n, "trader Yes should be fully redeemed");

    const lpBeforeExit = await readPosition(env, market, lp.pubkey);
    assert.ok(lpBeforeExit.lp > 0n, "this round should have LP to withdraw");
    await sendGetLiquidity(env, lp, market, lpBeforeExit.lp);
    const lpAfterExit = await readPosition(env, market, lp.pubkey);
    eqAmount(lpAfterExit.lp, 0n, "LP shares should be fully withdrawn");
  });

  it("full reconciliation: vault always equals one-side token supply", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
      expireInSeconds: 40,
    });

    const check = async (stage: string) => {
      const pos = await readPosition(env, market, house.pubkey);
      const yesSupply = await mintSupply(env, market.yesMint);
      const noSupply = await mintSupply(env, market.noMint);
      eqAmount(yesSupply, noSupply, `${stage}: Yes/No total supply should be equal`);
      eqAmount(pos.vault, yesSupply, `${stage}: vault should equal one-side total supply`);
    };

    await check("after create");

    const lp = await newFundedUser(env, "LP", mint, tokens(30));
    await sendAddLiquidity(env, lp, market, tokens(30));
    await check("after LP");

    const trader = await newFundedUser(env, "trader", mint, tokens(20));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(20),
      tokenType: "yes",
    });
    await check("after bet");

    await sendSwap(env, trader, market, {
      amountIn: tokens(4),
      tokenType: "no",
    });
    await check("after swap");

    const beforeMerge = await readPosition(env, market, trader.pubkey);
    const mergeAmount =
      beforeMerge.yes < beforeMerge.no ? beforeMerge.yes : beforeMerge.no;
    assert.ok(mergeAmount > 0n, "there should be a complete set to merge");
    await sendMergeToken(env, trader, market, mergeAmount);
    await check("after merge");

    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");
    await check("after resolve");

    const beforeClaim = await readPosition(env, market, trader.pubkey);
    assert.ok(beforeClaim.yes > 0n, "there should be redeemable winning tokens");
    await sendGetCollateral(env, trader, market, market.yesMint, beforeClaim.yes);
    const afterClaim = await readPosition(env, market, trader.pubkey);
    eqAmount(afterClaim.yes, 0n, "trader Yes should be fully redeemed");
    const yesLeft = await mintSupply(env, market.yesMint);
    eqAmount(afterClaim.vault, yesLeft, "after redeem, vault should equal remaining winning tokens");

    const lpBeforeExit = await readPosition(env, market, lp.pubkey);
    assert.ok(lpBeforeExit.lp > 0n, "there should be LP to withdraw");
    const vaultBeforeExit = lpBeforeExit.vault;
    await sendGetLiquidity(env, lp, market, lpBeforeExit.lp);
    const lpAfterExit = await readPosition(env, market, lp.pubkey);
    eqAmount(lpAfterExit.lp, 0n, "LP should be fully withdrawn");
    eqAmount(lpAfterExit.vault, vaultBeforeExit, "withdrawing LP leaves the vault untouched");
  });

  it("after a multi-party round, everyone settles: supply is conserved, vault ends at zero", async () => {
    const mint = await createCollateralMint(env);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
      expireInSeconds: 40,
    });

    const lp = await newFundedUser(env, "LP", mint, tokens(30));
    await sendAddLiquidity(env, lp, market, tokens(30));
    const bull = await newFundedUser(env, "long", mint, tokens(20));
    const bear = await newFundedUser(env, "short", mint, tokens(15));
    await sendUserBetOn(env, bull, market, {
      collateralAmount: tokens(20),
      tokenType: "yes",
    });
    await sendUserBetOn(env, bear, market, {
      collateralAmount: tokens(15),
      tokenType: "no",
    });

    const totalSupply = await mintSupply(env, mint);
    const holders = [house, lp, bull, bear];

    const audit = async (stage: string) => {
      const positions = await Promise.all(
        holders.map((u) => readPosition(env, market, u.pubkey))
      );
      const held = positions.reduce((sum, p) => sum + p.collateral, 0n);
      eqAmount(
        positions[0].vault + held,
        totalSupply,
        `${stage}: vault plus all holders should equal total supply`
      );
    };

    await audit("after opening the position");
    await sendSwap(env, bull, market, {
      amountIn: tokens(5),
      tokenType: "no",
    });
    await audit("after swap");

    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");
    await audit("after resolve");

    const bullBefore = await readPosition(env, market, bull.pubkey);
    assert.ok(bullBefore.yes > 0n, "long should hold the winning token");
    await sendGetCollateral(env, bull, market, market.yesMint, bullBefore.yes);

    const lpBefore = await readPosition(env, market, lp.pubkey);
    assert.ok(lpBefore.lp > 0n, "LP should hold shares");
    await sendGetLiquidity(env, lp, market, lpBefore.lp);
    const lpAfter = await readPosition(env, market, lp.pubkey);
    assert.ok(lpAfter.yes > 0n, "Yes withdrawn by the LP is the winning token");
    await sendGetCollateral(env, lp, market, market.yesMint, lpAfter.yes);

    const houseBefore = await readPosition(env, market, house.pubkey);
    assert.ok(houseBefore.lp > 0n, "house should hold the initial LP");
    await openTokenAccount(env, market.yesMint, house.pubkey);
    await openTokenAccount(env, market.noMint, house.pubkey);
    await sendGetLiquidity(env, house, market, houseBefore.lp);
    const houseAfter = await readPosition(env, market, house.pubkey);
    assert.ok(houseAfter.yes > 0n, "Yes withdrawn by the house is the winning token");
    await sendGetCollateral(env, house, market, market.yesMint, houseAfter.yes);

    await audit("after everyone settles");

    const final = await readPosition(env, market, house.pubkey);
    eqAmount(await mintSupply(env, market.yesMint), 0n, "winning tokens should be fully burned");
    eqAmount(final.vault, 0n, "vault should be zero; no collateral left locked");
    assert.ok(
      (await mintSupply(env, market.noMint)) > 0n,
      "losing tokens remain in circulation but no longer map to collateral"
    );
  });
});
