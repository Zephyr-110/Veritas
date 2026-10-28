import * as assert from "assert";
import { PublicKey } from "@solana/web3.js";
import {
  createCollateralMint,
  eqAmount,
  fetchMarket,
  getHouse,
  getTestEnv,
  makeOpenMarket,
  mintSupply,
  newFundedUser,
  openTokenAccount,
  readPosition,
  sameJson,
  sendAddLiquidity,
  sendGetCollateral,
  sendGetLiquidity,
  sendMergeToken,
  sendResolveMarket,
  sendSwap,
  sendUserBetOn,
  TestEnv,
  tokens,
  User,
  waitUntilExpired,
} from "./helpers";

describe("全流程 full_round", () => {
  let env: TestEnv;
  let house: User;
  let mint: PublicKey;

  before(async () => {
    env = getTestEnv();
    house = getHouse(env);
    mint = await createCollateralMint(env);
  });

  it("建盘 → 做市 → 下注 → 换汇 → 合并 → 到期裁决 → 兑奖 → 撤份额", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
      expireInSeconds: 40,
      title: "full round market",
    });

    const lp = await newFundedUser(env, "做市商", mint, tokens(30));
    await sendAddLiquidity(env, lp, market, tokens(30));

    const trader = await newFundedUser(env, "玩家", mint, tokens(20));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(20),
      tokenType: "yes",
    });
    await sendSwap(env, trader, market, {
      amountIn: tokens(4),
      tokenType: "no",
    });

    const beforeMerge = await readPosition(env, market, trader.pubkey);
    const mergeAmount =
      beforeMerge.yes < beforeMerge.no ? beforeMerge.yes : beforeMerge.no;
    assert.ok(mergeAmount > 0n, "本局应存在可合并的完整套");
    await sendMergeToken(env, trader, market, mergeAmount);

    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");

    const resolved = await fetchMarket(env, market);
    sameJson(resolved.status, { resolved: {} }, "全流程结束时应已裁决");
    sameJson(resolved.winner, { yes: {} }, "本局赢家是 Yes");

    const beforeClaim = await readPosition(env, market, trader.pubkey);
    assert.ok(beforeClaim.yes > 0n, "本局应存在可兑的赢家代币");
    await sendGetCollateral(env, trader, market, market.yesMint, beforeClaim.yes);
    const afterClaim = await readPosition(env, market, trader.pubkey);
    eqAmount(afterClaim.yes, 0n, "玩家 Yes 应兑完");

    const lpBeforeExit = await readPosition(env, market, lp.pubkey);
    assert.ok(lpBeforeExit.lp > 0n, "本局应存在可撤的份额");
    await sendGetLiquidity(env, lp, market, lpBeforeExit.lp);
    const lpAfterExit = await readPosition(env, market, lp.pubkey);
    eqAmount(lpAfterExit.lp, 0n, "做市商份额应撤完");
  });

  it("全程对账：金库余额恒等于单边代币总供给", async () => {
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
      expireInSeconds: 40,
    });

    const check = async (stage: string) => {
      const pos = await readPosition(env, market, house.pubkey);
      const yesSupply = await mintSupply(env, market.yesMint);
      const noSupply = await mintSupply(env, market.noMint);
      eqAmount(yesSupply, noSupply, `${stage}：Yes/No 总供给应相等`);
      eqAmount(pos.vault, yesSupply, `${stage}：金库应等于单边总供给`);
    };

    await check("建盘后");

    const lp = await newFundedUser(env, "做市商", mint, tokens(30));
    await sendAddLiquidity(env, lp, market, tokens(30));
    await check("做市后");

    const trader = await newFundedUser(env, "玩家", mint, tokens(20));
    await sendUserBetOn(env, trader, market, {
      collateralAmount: tokens(20),
      tokenType: "yes",
    });
    await check("下注后");

    await sendSwap(env, trader, market, {
      amountIn: tokens(4),
      tokenType: "no",
    });
    await check("换汇后");

    const beforeMerge = await readPosition(env, market, trader.pubkey);
    const mergeAmount =
      beforeMerge.yes < beforeMerge.no ? beforeMerge.yes : beforeMerge.no;
    assert.ok(mergeAmount > 0n, "应存在可合并的完整套");
    await sendMergeToken(env, trader, market, mergeAmount);
    await check("合并后");

    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");
    await check("裁决后");

    const beforeClaim = await readPosition(env, market, trader.pubkey);
    assert.ok(beforeClaim.yes > 0n, "应存在可兑的赢家代币");
    await sendGetCollateral(env, trader, market, market.yesMint, beforeClaim.yes);
    const afterClaim = await readPosition(env, market, trader.pubkey);
    eqAmount(afterClaim.yes, 0n, "玩家 Yes 应兑完");
    const yesLeft = await mintSupply(env, market.yesMint);
    eqAmount(afterClaim.vault, yesLeft, "兑奖后金库应等于剩余赢家代币");

    const lpBeforeExit = await readPosition(env, market, lp.pubkey);
    assert.ok(lpBeforeExit.lp > 0n, "应存在可撤的份额");
    const vaultBeforeExit = lpBeforeExit.vault;
    await sendGetLiquidity(env, lp, market, lpBeforeExit.lp);
    const lpAfterExit = await readPosition(env, market, lp.pubkey);
    eqAmount(lpAfterExit.lp, 0n, "份额应撤完");
    eqAmount(lpAfterExit.vault, vaultBeforeExit, "撤份额不动金库");
  });

  it("多方对赌后全员清算：发行总量守恒，金库最终归零", async () => {
    const mint = await createCollateralMint(env);
    const market = await makeOpenMarket(env, {
      creator: house,
      collateralMint: mint,
      collateralAmount: tokens(100),
      expireInSeconds: 40,
    });

    const lp = await newFundedUser(env, "做市商", mint, tokens(30));
    await sendAddLiquidity(env, lp, market, tokens(30));
    const bull = await newFundedUser(env, "多头", mint, tokens(20));
    const bear = await newFundedUser(env, "空头", mint, tokens(15));
    await sendUserBetOn(env, bull, market, {
      collateralAmount: tokens(20),
      tokenType: "yes",
    });
    await sendUserBetOn(env, bear, market, {
      collateralAmount: tokens(15),
      tokenType: "no",
    });

    const totalSupply = await mintSupply(env, mint);
    const holders = [house, lp, bull, bear];

    const audit = async (stage: string) => {
      const positions = await Promise.all(
        holders.map((u) => readPosition(env, market, u.pubkey))
      );
      const held = positions.reduce((sum, p) => sum + p.collateral, 0n);
      eqAmount(
        positions[0].vault + held,
        totalSupply,
        `${stage}：金库加所有持币人应等于发行总量`
      );
    };

    await audit("建仓后");
    await sendSwap(env, bull, market, {
      amountIn: tokens(5),
      tokenType: "no",
    });
    await audit("换汇后");

    await waitUntilExpired(env, market);
    await sendResolveMarket(env, house, market, "yes");
    await audit("裁决后");

    const bullBefore = await readPosition(env, market, bull.pubkey);
    assert.ok(bullBefore.yes > 0n, "多头应持有赢家代币");
    await sendGetCollateral(env, bull, market, market.yesMint, bullBefore.yes);

    const lpBefore = await readPosition(env, market, lp.pubkey);
    assert.ok(lpBefore.lp > 0n, "做市商应持有份额");
    await sendGetLiquidity(env, lp, market, lpBefore.lp);
    const lpAfter = await readPosition(env, market, lp.pubkey);
    assert.ok(lpAfter.yes > 0n, "做市商撤出的 Yes 是赢家代币");
    await sendGetCollateral(env, lp, market, market.yesMint, lpAfter.yes);

    const houseBefore = await readPosition(env, market, house.pubkey);
    assert.ok(houseBefore.lp > 0n, "庄家应持有开盘份额");
    await openTokenAccount(env, market.yesMint, house.pubkey);
    await openTokenAccount(env, market.noMint, house.pubkey);
    await sendGetLiquidity(env, house, market, houseBefore.lp);
    const houseAfter = await readPosition(env, market, house.pubkey);
    assert.ok(houseAfter.yes > 0n, "庄家撤出的 Yes 是赢家代币");
    await sendGetCollateral(env, house, market, market.yesMint, houseAfter.yes);

    await audit("全员清算后");

    const final = await readPosition(env, market, house.pubkey);
    eqAmount(await mintSupply(env, market.yesMint), 0n, "赢家代币应全部烧完");
    eqAmount(final.vault, 0n, "金库应清零，没有抵押物被锁死");
    assert.ok(
      (await mintSupply(env, market.noMint)) > 0n,
      "输家代币仍在流通，但已无对应抵押物"
    );
  });
});
