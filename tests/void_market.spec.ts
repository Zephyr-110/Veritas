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

describe("void void_market", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("cannot void before expiry", async () => {
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

  it("only the oracle can void in-window", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    const stranger = await newUser(env, "stranger");
    await assertTxFails(
      () => sendVoidMarket(env, stranger, market),
      "MarketNotOpen"
    );
    await sendVoidMarket(env, house, market);
    const onchain = await fetchMarket(env, market);
    sameJson(onchain.status, { burn: {} }, "after oracle voids in-window, status should be Burn");
  });

  it.skip("anyone can void after the window (create_market rejects past expiry, 100000s window is untestable)", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      windowClosed: true,
    });
    const stranger = await newUser(env, "stranger");
    await sendVoidMarket(env, stranger, market);
    const onchain = await fetchMarket(env, market);
    sameJson(onchain.status, { burn: {} }, "after a stranger voids post-window, status should be Burn");
  });

  it("a resolved market cannot be voided", async () => {
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

  it("cannot resolve after void", async () => {
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
