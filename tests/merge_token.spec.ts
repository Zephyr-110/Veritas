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

describe("合并代币 merge_token", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("同时烧掉 1 Yes + 1 No，金库按 1:1 退抵押物", async () => {
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

    eqAmount(after.yes, before.yes - mergeAmount, "Yes 烧掉合并量");
    eqAmount(after.no, before.no - mergeAmount, "No 烧掉合并量");
    eqAmount(
      after.collateral,
      before.collateral + mergeAmount,
      "玩家拿回等额抵押物"
    );
    eqAmount(after.vault, before.vault - mergeAmount, "金库减少等额抵押物");
    eqAmount(
      await mintSupply(env, market.yesMint),
      await mintSupply(env, market.noMint),
      "合并后两币供给仍相等"
    );
    eqAmount(
      after.vault,
      await mintSupply(env, market.yesMint),
      "金库应等于单边总供给"
    );
  });

  it("只有单边代币时不能合并", async () => {
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
      () => sendMergeToken(env, trader, market, tokens(1)),
      "InsufficientBalance"
    );
  });

  it("裁决后仍可合并：两种币各烧一枚，退回一份抵押物", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(50),
      expireInSeconds: 20,
    });
    const trader = await newFundedUser(env, "玩家", mint, tokens(10));
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
      "裁决后合并仍退回等额抵押物"
    );
    eqAmount(after.vault, before.vault - mergeAmount, "金库减少等额");
    eqAmount(
      await mintSupply(env, market.yesMint),
      yesSupplyBefore - mergeAmount,
      "Yes 供给同步减少"
    );
    eqAmount(
      await mintSupply(env, market.noMint),
      noSupplyBefore - mergeAmount,
      "No 供给同步减少"
    );
  });
  it("作废后仍可合并完整套，1 Yes + 1 No 换 1 抵押物", async () => {
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
    assert.ok(mergeAmount > 0n, "撤份额后应有可合并的完整套");
    await sendMergeToken(env, house, market, mergeAmount);
    const after = await readPosition(env, market, house.pubkey);
    eqAmount(after.yes, before.yes - mergeAmount, "Yes 应烧掉");
    eqAmount(after.no, before.no - mergeAmount, "No 应烧掉");
    eqAmount(
      after.collateral,
      before.collateral + mergeAmount,
      "合并应兑出等额抵押物"
    );
  });
});

function assertEnoughBoth(yes: bigint, no: bigint) {
  if (yes === 0n || no === 0n) {
    throw new Error("换汇后玩家应该同时持有 Yes 和 No，才能测合并");
  }
}
