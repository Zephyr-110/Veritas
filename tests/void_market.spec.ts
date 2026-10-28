import { PublicKey } from "@solana/web3.js";
import {
  assertTxFails,
  createCollateralMint,
  fetchMarket,
  getHouse,
  getTestEnv,
  makeOpenMarket,
  newUser,
  sameJson,
  sendResolveMarket,
  sendVoidMarket,
  TestEnv,
  tokens,
  User,
} from "./helpers";

describe("作废 void_market", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("未到期不能作废", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      expireInSeconds: 3600,
    });
    await assertTxFails(
      () => sendVoidMarket(env, house, market),
      "MarketNotOpen"
    );
  });

  it("窗内只有 oracle 可以作废", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    const stranger = await newUser(env, "路人");
    await assertTxFails(
      () => sendVoidMarket(env, stranger, market),
      "MarketNotOpen"
    );
    await sendVoidMarket(env, house, market);
    const onchain = await fetchMarket(env, market);
    sameJson(onchain.status, { burn: {} }, "窗内 oracle 作废后应是 Burn");
  });

  it.skip("窗后任何人都可以作废（建盘禁止过去的 expiry 后，100000 秒窗口测不了）", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      windowClosed: true,
    });
    const stranger = await newUser(env, "路人");
    await sendVoidMarket(env, stranger, market);
    const onchain = await fetchMarket(env, market);
    sameJson(onchain.status, { burn: {} }, "窗后路人作废后应是 Burn");
  });

  it("已裁决的盘口不能再作废", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await sendResolveMarket(env, house, market, "yes");
    await assertTxFails(
      () => sendVoidMarket(env, house, market),
      "MarketNotOpen"
    );
  });

  it("作废后不能再裁决", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await sendVoidMarket(env, house, market);
    await assertTxFails(
      () => sendResolveMarket(env, house, market, "yes"),
      "MarketNotOpen"
    );
  });
});
