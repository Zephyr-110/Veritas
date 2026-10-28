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
  TestEnv,
  tokens,
  User,
} from "./helpers";

describe("裁决 resolve_market", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("过期后 oracle 可以公布赢家", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await sendResolveMarket(env, house, market, "no");
    const onchain = await fetchMarket(env, market);
    sameJson(onchain.status, { resolved: {} }, "状态应是 Resolved");
    sameJson(onchain.winner, { no: {} }, "赢家应是 No");
  });

  it("没到过期时间不能裁决", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      expireInSeconds: 3600,
    });
    await assertTxFails(
      () => sendResolveMarket(env, house, market, "yes"),
      "MarketNotExpired"
    );
  });

  it("不是 oracle 不能裁决", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    const stranger = await newUser(env, "路人");
    await assertTxFails(
      () => sendResolveMarket(env, stranger, market, "yes"),
      "Unauthorized"
    );
  });

  it("开盘人不是 oracle 时不能裁决，指定的 oracle 可以", async () => {
    const oracle = await newUser(env, "预言机");
    const market = await makeOpenMarket(env, {
      creator: house,
      oracle,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await assertTxFails(
      () => sendResolveMarket(env, house, market, "yes"),
      "Unauthorized"
    );
    await sendResolveMarket(env, oracle, market, "yes");
    const onchain = await fetchMarket(env, market);
    sameJson(onchain.status, { resolved: {} }, "oracle 应能裁决");
    sameJson(onchain.winner, { yes: {} }, "赢家应是 Yes");
  });

  it.skip("裁决窗关闭后不能再判 Yes/No（建盘禁止过去的 expiry 后，100000 秒窗口测不了）", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      windowClosed: true,
    });
    await assertTxFails(
      () => sendResolveMarket(env, house, market, "yes"),
      "MarketNotExpired"
    );
  });

  it("已经裁决过的盘口不能再裁决", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await sendResolveMarket(env, house, market, "yes");
    await assertTxFails(
      () => sendResolveMarket(env, house, market, "no"),
      "MarketNotOpen"
    );
  });
});
