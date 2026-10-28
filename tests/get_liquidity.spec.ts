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
  openTokenAccount,
  quoteWithdrawLiquidity,
  readPosition,
  sendGetLiquidity,
  sendResolveMarket,
  sendVoidMarket,
  TestEnv,
  tokens,
  User,
  waitUntilExpired,
} from "./helpers";

describe("撤出流动性 get_liquidity", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("按份额比例从 Yes/No 池取回代币，不直接拿金库抵押物", async () => {
    const start = tokens(100);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: start,
    });
    await openTokenAccount(env, market.yesMint, house.pubkey);
    await openTokenAccount(env, market.noMint, house.pubkey);

    const withdraw = tokens(25);
    const before = await readPosition(env, market, house.pubkey);
    const quote = quoteWithdrawLiquidity(
      before.yesPool,
      before.noPool,
      before.lpSupply,
      withdraw
    );

    await sendGetLiquidity(env, house, market, withdraw);
    const after = await readPosition(env, market, house.pubkey);

    eqAmount(after.lp, before.lp - withdraw, "份额减少");
    eqAmount(after.lpSupply, before.lpSupply - withdraw, "份额总供给减少");
    eqAmount(after.yes, before.yes + quote.yesOut, "取回 Yes");
    eqAmount(after.no, before.no + quote.noOut, "取回 No");
    eqAmount(after.yesPool, before.yesPool - quote.yesOut, "Yes 池减少");
    eqAmount(after.noPool, before.noPool - quote.noOut, "No 池减少");
    eqAmount(after.vault, before.vault, "撤份额不会动金库");
    eqAmount(
      await mintSupply(env, market.yesMint),
      await mintSupply(env, market.noMint),
      "撤份额不改变两币供给"
    );
    eqAmount(
      after.vault,
      await mintSupply(env, market.yesMint),
      "金库仍等于单边总供给"
    );
  });

  it("份额为 0 时撤资失败", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });
    await openTokenAccount(env, market.yesMint, house.pubkey);
    await openTokenAccount(env, market.noMint, house.pubkey);
    await assertTxFails(
      () => sendGetLiquidity(env, house, market, 0n),
      "ZeroLp"
    );
  });

  it("份额不足时撤资失败", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });
    await openTokenAccount(env, market.yesMint, house.pubkey);
    await openTokenAccount(env, market.noMint, house.pubkey);
    await assertTxFails(
      () => sendGetLiquidity(env, house, market, tokens(1000000)),
      "InsufficientBalance"
    );
  });

  it("裁决后仍可撤份额，取回的是两种代币而不是抵押物", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(20),
      expireInSeconds: 2,
    });
    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");
    await openTokenAccount(env, market.yesMint, house.pubkey);
    await openTokenAccount(env, market.noMint, house.pubkey);

    const before = await readPosition(env, market, house.pubkey);
    assert.ok(before.lp > 0n, "庄家应持有全部开盘份额");
    const quote = quoteWithdrawLiquidity(
      before.yesPool,
      before.noPool,
      before.lpSupply,
      before.lp
    );

    await sendGetLiquidity(env, house, market, before.lp);
    const after = await readPosition(env, market, house.pubkey);

    eqAmount(after.lp, 0n, "份额应撤完");
    eqAmount(after.yes, before.yes + quote.yesOut, "取回 Yes");
    eqAmount(after.no, before.no + quote.noOut, "取回 No");
    eqAmount(after.yesPool, 0n, "全额撤出后 Yes 池应清空");
    eqAmount(after.noPool, 0n, "全额撤出后 No 池应清空");
    eqAmount(after.vault, before.vault, "裁决后撤份额同样不动金库");
  });
  it("作废后仍可撤份额，取回的是两种代币而不是抵押物", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(20),
      alreadyExpired: true,
    });
    await sendVoidMarket(env, house, market);
    await openTokenAccount(env, market.yesMint, house.pubkey);
    await openTokenAccount(env, market.noMint, house.pubkey);

    const before = await readPosition(env, market, house.pubkey);
    assert.ok(before.lp > 0n, "庄家应持有全部开盘份额");
    const quote = quoteWithdrawLiquidity(
      before.yesPool,
      before.noPool,
      before.lpSupply,
      before.lp
    );

    await sendGetLiquidity(env, house, market, before.lp);
    const after = await readPosition(env, market, house.pubkey);

    eqAmount(after.lp, 0n, "份额应撤完");
    eqAmount(after.yes, before.yes + quote.yesOut, "取回 Yes");
    eqAmount(after.no, before.no + quote.noOut, "取回 No");
    eqAmount(after.vault, before.vault, "作废后撤份额同样不动金库");
  });
});
