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

describe("withdraw liquidity get_liquidity", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("withdraw Yes/No from pools by LP share, not collateral from the vault", async () => {
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

    eqAmount(after.lp, before.lp - withdraw, "LP decreases");
    eqAmount(after.lpSupply, before.lpSupply - withdraw, "LP supply decreases");
    eqAmount(after.yes, before.yes + quote.yesOut, "withdraw Yes");
    eqAmount(after.no, before.no + quote.noOut, "withdraw No");
    eqAmount(after.yesPool, before.yesPool - quote.yesOut, "Yes pool decreases");
    eqAmount(after.noPool, before.noPool - quote.noOut, "No pool decreases");
    eqAmount(after.vault, before.vault, "withdrawing LP does not move the vault");
    eqAmount(
      await mintSupply(env, market.yesMint),
      await mintSupply(env, market.noMint),
      "withdrawing LP does not change either token supply"
    );
    eqAmount(
      after.vault,
      await mintSupply(env, market.yesMint),
      "vault still equals one-side total supply"
    );
  });

  it("withdraw fails when LP amount is 0", async () => {
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

  it("withdraw fails when LP is insufficient", async () => {
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

  it("LP can still withdraw after resolve; they get both tokens, not collateral", async () => {
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
    assert.ok(before.lp > 0n, "house should hold the full initial LP");
    const quote = quoteWithdrawLiquidity(
      before.yesPool,
      before.noPool,
      before.lpSupply,
      before.lp
    );

    await sendGetLiquidity(env, house, market, before.lp);
    const after = await readPosition(env, market, house.pubkey);

    eqAmount(after.lp, 0n, "LP should be fully withdrawn");
    eqAmount(after.yes, before.yes + quote.yesOut, "withdraw Yes");
    eqAmount(after.no, before.no + quote.noOut, "withdraw No");
    eqAmount(after.yesPool, 0n, "Yes pool should be empty after a full withdraw");
    eqAmount(after.noPool, 0n, "No pool should be empty after a full withdraw");
    eqAmount(after.vault, before.vault, "withdrawing LP after resolve also leaves the vault untouched");
  });
  it("LP can still withdraw after void; they get both tokens, not collateral", async () => {
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
    assert.ok(before.lp > 0n, "house should hold the full initial LP");
    const quote = quoteWithdrawLiquidity(
      before.yesPool,
      before.noPool,
      before.lpSupply,
      before.lp
    );

    await sendGetLiquidity(env, house, market, before.lp);
    const after = await readPosition(env, market, house.pubkey);

    eqAmount(after.lp, 0n, "LP should be fully withdrawn");
    eqAmount(after.yes, before.yes + quote.yesOut, "withdraw Yes");
    eqAmount(after.no, before.no + quote.noOut, "withdraw No");
    eqAmount(after.vault, before.vault, "withdrawing LP after void also leaves the vault untouched");
  });
});
