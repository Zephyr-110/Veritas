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
  newFundedUser,
  readPosition,
  sendMergeToken,
  sendResolveMarket,
  sendVoidMarket,
  sendGetLiquidity,
  openTokenAccount,
  sendSwap,
  sendUserBetOn,
  TestEnv,
  tokens,
  User,
  waitUntilExpired,
} from "./helpers";

describe("merge tokens merge_token", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("burn 1 Yes + 1 No together, vault returns collateral 1:1", async () => {
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
    await sendSwap(env, trader, market, {
      amountIn: tokens(6),
      tokenType: "no",
    });

    const before = await readPosition(env, market, trader.pubkey);
    const mergeAmount =
      before.yes < before.no ? before.yes : before.no;
    assertEnoughBoth(before.yes, before.no);

    await sendMergeToken(env, trader, market, mergeAmount);
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(after.yes, before.yes - mergeAmount, "Yes burned equals the merge amount");
    eqAmount(after.no, before.no - mergeAmount, "No burned equals the merge amount");
    eqAmount(
      after.collateral,
      before.collateral + mergeAmount,
      "trader gets equal collateral back"
    );
    eqAmount(after.vault, before.vault - mergeAmount, "vault decreases by equal collateral");
    eqAmount(
      await mintSupply(env, market.yesMint),
      await mintSupply(env, market.noMint),
      "after merge, both supplies stay equal"
    );
    eqAmount(
      after.vault,
      await mintSupply(env, market.yesMint),
      "vault should equal one-side total supply"
    );
  });

  it("cannot merge with only one side", async () => {
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
      () => sendMergeToken(env, trader, market, tokens(1)),
      "InsufficientBalance"
    );
  });

  it("merge still works after resolve: burn one of each, return one collateral", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(50),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "trader", mint, tokens(10));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(10),
      tokenType: "yes",
    });
    await sendSwap(env, trader, market, {
      amountIn: tokens(4),
      tokenType: "no",
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");

    const before = await readPosition(env, market, trader.pubkey);
    const mergeAmount =
      before.yes < before.no ? before.yes : before.no;
    assertEnoughBoth(before.yes, before.no);
    const yesSupplyBefore = await mintSupply(env, market.yesMint);
    const noSupplyBefore = await mintSupply(env, market.noMint);

    await sendMergeToken(env, trader, market, mergeAmount);
    const after = await readPosition(env, market, trader.pubkey);

    eqAmount(
      after.collateral,
      before.collateral + mergeAmount,
      "merge after resolve still returns equal collateral"
    );
    eqAmount(after.vault, before.vault - mergeAmount, "vault decreases by the same amount");
    eqAmount(
      await mintSupply(env, market.yesMint),
      yesSupplyBefore - mergeAmount,
      "Yes supply decreases in lockstep"
    );
    eqAmount(
      await mintSupply(env, market.noMint),
      noSupplyBefore - mergeAmount,
      "No supply decreases in lockstep"
    );
  });
  it("after void, a complete set still merges: 1 Yes + 1 No for 1 collateral", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(20),
      alreadyExpired: true,
    });
    await sendVoidMarket(env, house, market);
    await openTokenAccount(env, market.yesMint, house.pubkey);
    await openTokenAccount(env, market.noMint, house.pubkey);
    const beforeWithdraw = await readPosition(env, market, house.pubkey);
    await sendGetLiquidity(env, house, market, beforeWithdraw.lp);
    const before = await readPosition(env, market, house.pubkey);
    const mergeAmount = before.yes < before.no ? before.yes : before.no;
    assert.ok(mergeAmount > 0n, "after LP withdraw there should be a complete set to merge");
    await sendMergeToken(env, house, market, mergeAmount);
    const after = await readPosition(env, market, house.pubkey);
    eqAmount(after.yes, before.yes - mergeAmount, "Yes should be burned");
    eqAmount(after.no, before.no - mergeAmount, "No should be burned");
    eqAmount(
      after.collateral,
      before.collateral + mergeAmount,
      "merge should return equal collateral"
    );
  });
});

function assertEnoughBoth(yes: bigint, no: bigint) {
  if (yes === 0n || no === 0n) {
    throw new Error("after swap the trader should hold both Yes and No, or merge cannot be tested");
  }
}
