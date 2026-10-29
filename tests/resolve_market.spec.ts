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

describe("resolve resolve_market", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("after expiry the oracle can publish the winner", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    await sendResolveMarket(env, house, market, "no");
    const onchain = await fetchMarket(env, market);
    sameJson(onchain.status, { resolved: {} }, "status should be Resolved");
    sameJson(onchain.winner, { no: {} }, "winner should be No");
  });

  it("cannot resolve before expiry", async () => {
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

  it("non-oracle cannot resolve", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
      alreadyExpired: true,
    });
    const stranger = await newUser(env, "stranger");
    await assertTxFails(
      () => sendResolveMarket(env, stranger, market, "yes"),
      "Unauthorized"
    );
  });

  it("creator cannot resolve unless they are oracle; the designated oracle can", async () => {
    const oracle = await newUser(env, "oracle");
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
    sameJson(onchain.status, { resolved: {} }, "oracle should be able to resolve");
    sameJson(onchain.winner, { yes: {} }, "winner should be Yes");
  });

  it.skip("cannot resolve Yes/No after the window (create_market rejects past expiry, 100000s window is untestable)", async () => {
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

  it("an already resolved market cannot be resolved again", async () => {
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
