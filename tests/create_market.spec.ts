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

describe("建盘 create_market", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("庄家注资后，盘口、币池、份额都按抵押数量开出来", async () => {
    const startCollateral = tokens(100);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: startCollateral,
      title: "Will BUC hit 100k?",
    });

    const onchain = await fetchMarket(env, market);
    const pos = await readPosition(env, market, house.pubkey);

    assert.deepStrictEqual(Array.from(onchain.id), market.id, "盘口 ID");
    assert.deepStrictEqual(
      Array.from(onchain.prediction),
      market.prediction,
      "盘口标题"
    );
    sameJson(onchain.status, { open: {} }, "盘口状态应是 Open");
    assert.ok(onchain.creator.equals(house.pubkey), "庄家应是 creator");
    assert.ok(onchain.oracle.equals(house.pubkey), "默认 oracle 是庄家自己");
    assert.ok(onchain.yesMint.equals(market.yesMint), "Yes mint");
    assert.ok(onchain.noMint.equals(market.noMint), "No mint");
    assert.ok(
      onchain.collateralMint.equals(mint),
      "抵押物 mint 应是测试代币"
    );
    eqAmount(onchain.expiry, market.expiry, "过期时间");
    eqAmount(pos.vault, startCollateral, "金库抵押物");
    eqAmount(pos.yesPool, startCollateral, "Yes 池");
    eqAmount(pos.noPool, startCollateral, "No 池");
    eqAmount(pos.lp, startCollateral, "庄家拿到的份额");
    eqAmount(pos.lpSupply, startCollateral, "份额总供给");
  });

  it("可以指定另一把钥匙当 oracle，建盘必须副署", async () => {
    const oracle = await newUser(env, "预言机");
    const market = await makeOpenMarket(env, {
      creator: house,
      oracle,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });
    const onchain = await fetchMarket(env, market);
    assert.ok(onchain.creator.equals(house.pubkey), "开盘人应是庄家");
    assert.ok(onchain.oracle.equals(oracle.pubkey), "oracle 应是指定的钥匙");
    assert.ok(
      !onchain.creator.equals(onchain.oracle),
      "本用例开盘人和裁判不是同一人"
    );
  });

  it("oracle 不签名时建盘失败", async () => {
    const oracle = await newUser(env, "预言机");
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

  it("抵押币精度原样传给三个子币", async () => {
    const mint9 = await createCollateralMint(env, 9);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint9,
      collateralAmount: tokens(100, 9),
      decimals: 9,
    });

    const onchain = await fetchMarket(env, market);
    assert.ok(onchain.collateralMint.equals(mint9), "抵押物 mint");
    for (const [name, mintKey] of [
      ["Yes", market.yesMint],
      ["No", market.noMint],
      ["LP", market.lpMint],
    ] as const) {
      const info = await fetchMint(env, mintKey);
      assert.strictEqual(info.decimals, 9, `${name} mint 精度应等于抵押币精度`);
    }
    const pos = await readPosition(env, market, house.pubkey);
    eqAmount(pos.vault, tokens(100, 9), "金库按 9 位精度入账");
  });

  it("金库与三个铸币厂的权限都归属盘口 PDA", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(10),
    });

    const vault = await fetchTokenAccount(env, market.collateralVault);
    assert.ok(vault.owner.equals(market.market), "金库 owner 应是盘口 PDA");
    for (const mintKey of [market.yesMint, market.noMint, market.lpMint]) {
      const info = await fetchMint(env, mintKey);
      assert.ok(
        info.mintAuthority?.equals(market.market),
        "铸币权应归盘口 PDA"
      );
      assert.ok(
        info.freezeAuthority?.equals(market.market),
        "冻结权应归盘口 PDA"
      );
    }
  });

  it("抵押数量为 0 时建盘失败", async () => {
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

  it("同一个盘口 ID 不能建两次", async () => {
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

  it("庄家抵押物余额不足时建盘失败", async () => {
    const poor = await newFundedUser(env, "穷庄家", mint, 0n);
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

  it("抵押物 ATA 不属于签名者时被约束拦下", async () => {
    const other = await newFundedUser(env, "路人", mint, tokens(10));
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

  it("过期时间已过去时不能建盘", async () => {
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

  it("到期时间不能是 u64::MAX", async () => {
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

  it("prediction 支持空串与满 64 字节", async () => {
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
        `prediction 应原样保存：${JSON.stringify(text)}`
      );
    }
  });
});
