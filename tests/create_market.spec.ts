import * as assert from "assert";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  assertTxFails,
  ataOf,
  chainUnixTime,
  createCollateralMint,
  eqAmount,
  fetchMarket,
  fetchMint,
  fetchTokenAccount,
  findMarketPdas,
  getHouse,
  getTestEnv,
  makeOpenMarket,
  mintToUser,
  newFundedUser,
  newUser,
  randomMarketId,
  readPosition,
  sameJson,
  sendCreateMarket,
  TestEnv,
  tokens,
  toPredictionBytes,
  User,
} from "./helpers";

describe("create market create_market", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("after the house seeds, market, pools, and LP open at the collateral amount", async () => {
    const startCollateral = tokens(100);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: startCollateral,
      title: "Will BUC hit 100k?",
    });

    const onchain = await fetchMarket(env, market);
    const pos = await readPosition(env, market, house.pubkey);

    assert.deepStrictEqual(Array.from(onchain.id), market.id, "market id");
    assert.deepStrictEqual(
      Array.from(onchain.prediction),
      market.prediction,
      "market title"
    );
    sameJson(onchain.status, { open: {} }, "market status should be Open");
    assert.ok(onchain.creator.equals(house.pubkey), "house should be creator");
    assert.ok(onchain.oracle.equals(house.pubkey), "default oracle is the house itself");
    assert.ok(onchain.yesMint.equals(market.yesMint), "Yes mint");
    assert.ok(onchain.noMint.equals(market.noMint), "No mint");
    assert.ok(
      onchain.collateralMint.equals(mint),
      "collateral mint should be the test token"
    );
    eqAmount(onchain.expiry, market.expiry, "expiry");
    eqAmount(pos.vault, startCollateral, "vault collateral");
    eqAmount(pos.yesPool, startCollateral, "Yes pool");
    eqAmount(pos.noPool, startCollateral, "No pool");
    eqAmount(pos.lp, startCollateral, "LP received by the house");
    eqAmount(pos.lpSupply, startCollateral, "LP supply");
  });

  it("another key can be oracle; create_market requires co-sign", async () => {
    const oracle = await newUser(env, "oracle");
    const market = await makeOpenMarket(env, {
      creator: house,
      oracle,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });
    const onchain = await fetchMarket(env, market);
    assert.ok(onchain.creator.equals(house.pubkey), "creator should be the house");
    assert.ok(onchain.oracle.equals(oracle.pubkey), "oracle should be the designated key");
    assert.ok(
      !onchain.creator.equals(onchain.oracle),
      "in this case creator and resolver are not the same person"
    );
  });

  it("create_market fails when oracle does not sign", async () => {
    const oracle = await newUser(env, "oracle");
    await mintToUser(env, mint, house.pubkey, tokens(10));
    await assertTxFails(
      () =>
        sendCreateMarket(env, house, {
          collateralMint: mint,
          marketId: randomMarketId(),
          prediction: toPredictionBytes("missing oracle sig"),
          expiry: new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          collateralAmount: tokens(1),
          oracle,
          omitOracleSignature: true,
        }),
      "signature"
    );
  });

  it("collateral decimals are copied to the three child mints", async () => {
    const mint9 = await createCollateralMint(env, 9);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint9,
      collateralAmount: tokens(100, 9),
      decimals: 9,
    });

    const onchain = await fetchMarket(env, market);
    assert.ok(onchain.collateralMint.equals(mint9), "collateral mint");
    for (const [name, mintKey] of [
      ["Yes", market.yesMint],
      ["No", market.noMint],
      ["LP", market.lpMint],
    ] as const) {
      const info = await fetchMint(env, mintKey);
      assert.strictEqual(info.decimals, 9, `${name} mint decimals should equal collateral decimals`);
    }
    const pos = await readPosition(env, market, house.pubkey);
    eqAmount(pos.vault, tokens(100, 9), "vault is credited at 9 decimals");
  });

  it("vault and the three mints are all owned/authorized by the market PDA", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });

    const vault = await fetchTokenAccount(env, market.collateralVault);
    assert.ok(vault.owner.equals(market.market), "vault owner should be the market PDA");
    for (const mintKey of [market.yesMint, market.noMint, market.lpMint]) {
      const info = await fetchMint(env, mintKey);
      assert.ok(
        info.mintAuthority?.equals(market.market),
        "mint authority should be the market PDA"
      );
      assert.ok(
        info.freezeAuthority?.equals(market.market),
        "freeze authority should be the market PDA"
      );
    }
  });

  it("create_market fails when collateral amount is 0", async () => {
    await mintToUser(env, mint, house.pubkey, tokens(10));
    await assertTxFails(
      () =>
        sendCreateMarket(env, house, {
          collateralMint: mint,
          marketId: randomMarketId(),
          prediction: toPredictionBytes("zero liquidity"),
          expiry: new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          collateralAmount: 0n,
        }),
      "InvalidAmount"
    );
  });

  it("the same market id cannot be created twice", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });
    await mintToUser(env, mint, house.pubkey, tokens(10));
    await assertTxFails(
      () =>
        sendCreateMarket(env, house, {
          collateralMint: mint,
          marketId: market.id,
          prediction: market.prediction,
          expiry: market.expiry,
          collateralAmount: tokens(10),
        }),
      "already in use"
    );
  });

  it("create_market fails when the house has insufficient collateral", async () => {
    const poor = await newFundedUser(env, "broke house", mint, 0n);
    await assertTxFails(
      () =>
        sendCreateMarket(env, poor, {
          collateralMint: mint,
          marketId: randomMarketId(),
          prediction: toPredictionBytes("poor"),
          expiry: new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          collateralAmount: tokens(10),
        }),
      "insufficient funds"
    );
  });

  it("rejected when the collateral ATA is not owned by the signer", async () => {
    const other = await newFundedUser(env, "stranger", mint, tokens(10));
    await mintToUser(env, mint, house.pubkey, tokens(10));
    await assertTxFails(
      () =>
        sendCreateMarket(env, house, {
          collateralMint: mint,
          marketId: randomMarketId(),
          prediction: toPredictionBytes("wrong ata"),
          expiry: new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          collateralAmount: tokens(1),
          creatorCollateralAta: ataOf(mint, other.pubkey),
        }),
      "ConstraintTokenOwner"
    );
  });

  it("cannot create a market whose expiry is already past", async () => {
    await mintToUser(env, mint, house.pubkey, tokens(1));
    const past = (await chainUnixTime(env.connection)) - 600;
    await assertTxFails(
      () =>
        sendCreateMarket(env, house, {
          collateralMint: mint,
          marketId: randomMarketId(),
          prediction: toPredictionBytes("already expired"),
          expiry: new anchor.BN(past),
          collateralAmount: tokens(1),
        }),
      "InvalidAmount"
    );
  });

  it("expiry cannot be u64::MAX", async () => {
    await mintToUser(env, mint, house.pubkey, tokens(1));
    await assertTxFails(
      () =>
        sendCreateMarket(env, house, {
          collateralMint: mint,
          marketId: randomMarketId(),
          prediction: toPredictionBytes("max expiry"),
          expiry: new anchor.BN("18446744073709551615"),
          collateralAmount: tokens(1),
        }),
      "InvalidAmount"
    );
  });

  it("prediction accepts empty string and a full 64 bytes", async () => {
    await mintToUser(env, mint, house.pubkey, tokens(2));
    for (const text of ["", "A".repeat(64)]) {
      const marketId = randomMarketId();
      await sendCreateMarket(env, house, {
        collateralMint: mint,
        marketId,
        prediction: toPredictionBytes(text),
        expiry: new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
        collateralAmount: tokens(1),
      });
      const onchain = await fetchMarket(
        env,
        findMarketPdas(env.program.programId, marketId)
      );
      assert.deepStrictEqual(
        Array.from(onchain.prediction),
        toPredictionBytes(text),
        `prediction should be stored as-is: ${JSON.stringify(text)}`
      );
    }
  });
});
