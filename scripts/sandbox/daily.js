#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AnchorProvider, Program, Wallet } = require("@coral-xyz/anchor");
const { TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

const {
  DEFAULT_ASSETS,
  DEFAULT_COLLATERAL_MINT,
  DEFAULT_PROGRAM_ID,
  DEFAULT_RPC,
  FEED_ANSWER_OFFSET,
  FEED_COUNTER_OFFSET,
  FEED_DECIMALS_OFFSET,
  FEED_MIN_LEN,
  FEED_TS_OFFSET,
  MARKET_ID_BYTES,
  ataOf,
  batchSyncOpenMarkets,
  buildCreateMarketIxs,
  buildUserBetOnIxs,
  decodeChainlinkFeed,
  defaultTitleForAsset,
  encodePrediction,
  envBool,
  envNum,
  envStr,
  fetchMintMeta,
  isActiveWindowOpen,
  loadIdl,
  loadKeypair,
  loadState,
  parseAssets,
  persistCreatedMarketToDb,
  recycleFinalizedEntries,
  resolveSettleScript,
  safeTokenAmount,
  saveState,
  scheduleExpiredSettlements,
  scheduleWatches,
  selectWatchEntries,
  sendAndConfirm,
  utcDayKey,
} = require("./tick");

const DAILY_DURATION_SEC = 86_400;

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/sandbox/daily.js [options]

Options:
  --self-check     Verify dependencies, IDL, settle.js path, 4-asset daily rotation, and tx encoding offline
  --force-open     Allow opening the current day's slot outside DAILY_OPEN_WINDOW_SEC (still prevents duplicates)
  -h, --help       Show this help message

Environment variables:
  SOLANA_RPC / RPC_URL         Solana RPC endpoint (default: ${DEFAULT_RPC})
  WALLET_PATH / ANCHOR_WALLET  Operator JSON keypair path (default: ~/.config/solana/id.json)
  PROGRAM_ID                   Program ID (default: ${DEFAULT_PROGRAM_ID})
  COLLATERAL_MINT              Collateral mint (default: ${DEFAULT_COLLATERAL_MINT})
  DAILY_ASSETS                 Daily rotating feed list (default: ${DEFAULT_ASSETS})
  DAILY_DURATION_SEC           Market duration in seconds (default: ${DAILY_DURATION_SEC} = 24 hours)
  DAILY_OPEN_HOUR_UTC          Fixed daily opening hour in UTC, 0..23 (default: 0)
  DAILY_OPEN_MINUTE_UTC        Fixed daily opening minute in UTC, 0..59 (default: 0)
  DAILY_OPEN_WINDOW_SEC        Opening window width after fixed time in seconds (default: 600)
  DAILY_SEED_USDT              Initial seed liquidity in USDT (default: 150)
  DAILY_BET_USDT               Opening bot bet size in USDT, 0 to skip (default: 2)
  DAILY_STATE_PATH             State JSON file path (default: scripts/sandbox/state-daily.json)
  SANDBOX_SETTLE_MAX_PER_TICK  Max expired daily markets woken per tick (default: 4)
  SANDBOX_RECYCLE_FUNDS        Recycle settled LP + winnings + empty ATAs (default: true)
  SANDBOX_MIN_SOL_LAMPORTS     Minimum operator SOL balance guard (default: 30000000)
  SANDBOX_ACTIVE_FILE          Optional JSON file {lastActiveTs} gating creation to active windows
  SANDBOX_ACTIVE_WINDOW_SEC    Active window duration in seconds (default: 1800)
  SETTLE_SCRIPT_PATH           Optional explicit path to scripts/settle.js
  IDL_PATH                     Optional explicit path to prediction_market.json
`);
  process.exit(exitCode);
}

function clampInt(n, min, max) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function getDailyConfig() {
  const durationSec = Math.max(3600, Math.round(envNum("DAILY_DURATION_SEC", DAILY_DURATION_SEC)));
  const openHourUtc = clampInt(envNum("DAILY_OPEN_HOUR_UTC", 0), 0, 23);
  const openMinuteUtc = clampInt(envNum("DAILY_OPEN_MINUTE_UTC", 0), 0, 59);
  const openWindowSec = Math.max(60, Math.round(envNum("DAILY_OPEN_WINDOW_SEC", 600)));
  return {
    rpcUrl: envStr(["SOLANA_RPC", "RPC_URL"], DEFAULT_RPC),
    walletPath: envStr(
      ["WALLET_PATH", "ANCHOR_WALLET"],
      path.join(os.homedir(), ".config", "solana", "id.json")
    ),
    programId: new PublicKey(envStr(["PROGRAM_ID"], DEFAULT_PROGRAM_ID)),
    collateralMint: new PublicKey(envStr(["COLLATERAL_MINT"], DEFAULT_COLLATERAL_MINT)),
    assets: parseAssets(envStr(["DAILY_ASSETS"], DEFAULT_ASSETS)),
    statePath: envStr(["DAILY_STATE_PATH"], path.join(__dirname, "state-daily.json")),
    durationSec,
    openHourUtc,
    openMinuteUtc,
    openWindowSec,
    seedUsdt: Math.max(1.01, envNum("DAILY_SEED_USDT", 150)),
    betUsdt: Math.max(0, envNum("DAILY_BET_USDT", 2)),
    settleMaxPerTick: Math.max(1, Math.round(envNum("SANDBOX_SETTLE_MAX_PER_TICK", 4))),
    recycleFunds: envBool("SANDBOX_RECYCLE_FUNDS", true),
    minSolLamports: Math.max(0, Math.round(envNum("SANDBOX_MIN_SOL_LAMPORTS", 30_000_000))),
    activeFile: envStr(["SANDBOX_ACTIVE_FILE"], ""),
    activeWindowSec: Math.max(60, Math.round(envNum("SANDBOX_ACTIVE_WINDOW_SEC", 1800))),
  };
}

function computeDailySlot(
  nowSec,
  openHourUtc,
  openMinuteUtc,
  assets,
  durationSec = DAILY_DURATION_SEC
) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error("DAILY_ASSETS must contain at least one asset");
  }
  const anchorOffsetSec = openHourUtc * 3600 + openMinuteUtc * 60;
  const slotIndex = Math.floor((nowSec - anchorOffsetSec) / durationSec);
  const slotStartSec = slotIndex * durationSec + anchorOffsetSec;
  const expiry = slotStartSec + durationSec - 5;
  const startIso = new Date(slotStartSec * 1000).toISOString();
  const slotKey = `${startIso.slice(0, 10)}@${startIso.slice(11, 16)}Z`;
  const assetIndex = ((slotIndex % assets.length) + assets.length) % assets.length;
  return {
    slotIndex,
    slotKey,
    slotStartSec,
    expiry,
    asset: assets[assetIndex],
  };
}

function shouldOpenDailySlot({ nowSec, slot, openWindowSec, state, forceOpen = false }) {
  const markets = state?.markets || [];
  if (markets.some((m) => m.dailySlot === slot.slotKey)) {
    return { open: false, reason: "slot_already_opened" };
  }
  if (markets.some((m) => m.status === "open" && Number(m.expiry) > nowSec)) {
    return { open: false, reason: "market_still_live" };
  }
  if (!forceOpen) {
    if (nowSec < slot.slotStartSec || nowSec >= slot.slotStartSec + openWindowSec) {
      return { open: false, reason: "outside_open_window" };
    }
  }
  if (slot.expiry - nowSec < 3600) {
    return { open: false, reason: "too_close_to_expiry" };
  }
  return { open: true, reason: "due" };
}

async function runSelfCheck() {
  const cfg = getDailyConfig();
  const { idl, idlPath } = loadIdl(cfg.programId);
  const settleScriptPath = resolveSettleScript();

  const baseTs = Date.UTC(2026, 10, 24, cfg.openHourUtc, cfg.openMinuteUtc, 5) / 1000;
  const rotated = [];
  for (let d = 0; d < cfg.assets.length + 1; d += 1) {
    const ts = baseTs + d * cfg.durationSec;
    const slot = computeDailySlot(ts, cfg.openHourUtc, cfg.openMinuteUtc, cfg.assets, cfg.durationSec);
    const title = defaultTitleForAsset(slot.asset.symbol, cfg.durationSec);
    encodePrediction(title);
    rotated.push({ slotKey: slot.slotKey, asset: slot.asset.key, expiry: slot.expiry, title });
  }
  const uniqueFirstCycle = new Set(rotated.slice(0, cfg.assets.length).map((r) => r.asset));
  if (uniqueFirstCycle.size !== cfg.assets.length || rotated[cfg.assets.length].asset !== rotated[0].asset) {
    throw new Error(`Daily rotation check failed: ${rotated.map((r) => r.asset).join(" -> ")}`);
  }

  const slot0 = computeDailySlot(baseTs, cfg.openHourUtc, cfg.openMinuteUtc, cfg.assets, cfg.durationSec);
  const windowCheck = shouldOpenDailySlot({
    nowSec: baseTs,
    slot: slot0,
    openWindowSec: cfg.openWindowSec,
    state: { markets: [] },
  });
  const offWindowCheck = shouldOpenDailySlot({
    nowSec: baseTs + cfg.openWindowSec + 60,
    slot: slot0,
    openWindowSec: cfg.openWindowSec,
    state: { markets: [] },
  });
  if (!windowCheck.open || offWindowCheck.open) {
    throw new Error("Daily fixed-time open window check failed");
  }

  const synthFeed = Buffer.alloc(FEED_MIN_LEN);
  synthFeed[FEED_DECIMALS_OFFSET] = 8;
  synthFeed.writeUInt32LE(42, FEED_COUNTER_OFFSET);
  synthFeed.writeBigInt64LE(BigInt(Math.floor(baseTs)), FEED_TS_OFFSET);
  const expectedPrice = 95_123_45678900n;
  synthFeed.writeBigUInt64LE(expectedPrice & ((1n << 64n) - 1n), FEED_ANSWER_OFFSET);
  synthFeed.writeBigInt64LE(expectedPrice >> 64n, FEED_ANSWER_OFFSET + 8);
  const decoded = decodeChainlinkFeed(synthFeed);

  const dummyPayer = Keypair.generate();
  const dummyConn = new Connection(cfg.rpcUrl, "confirmed");
  const program = new Program(
    idl,
    new AnchorProvider(dummyConn, new Wallet(dummyPayer), { commitment: "confirmed" })
  );
  const marketId = Array.from(crypto.randomBytes(MARKET_ID_BYTES));
  const createRes = await buildCreateMarketIxs(program, {
    creator: dummyPayer.publicKey,
    collateralMint: cfg.collateralMint,
    ocr2State: slot0.asset.ocr2State,
    marketId,
    prediction: encodePrediction(rotated[0].title),
    expiry: slot0.expiry,
    collateralAmount: 150_000_000n,
    threshold: decoded.answer,
    settleAbove: true,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  if (cfg.betUsdt > 0) {
    await buildUserBetOnIxs(program, {
      market: createRes.pdas.market,
      pdas: createRes.pdas,
      signer: dummyPayer.publicKey,
      collateralMint: cfg.collateralMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      collateralAmount: 2_000_000n,
      side: "yes",
      minOut: 1_000_000n,
    });
  }

  console.log("DAILY_SELF_CHECK_OK", {
    node: process.version,
    idlPath,
    settleScriptPath,
    openUtc: `${String(cfg.openHourUtc).padStart(2, "0")}:${String(cfg.openMinuteUtc).padStart(2, "0")}Z`,
    durationSec: cfg.durationSec,
    seedUsdt: cfg.seedUsdt,
    rotation: rotated.map((r) => `${r.slotKey}:${r.asset}`),
  });
}

async function runDailyTick({ forceOpen = false } = {}) {
  const cfg = getDailyConfig();
  const { idl } = loadIdl(cfg.programId);
  const settleScriptPath = resolveSettleScript();
  const payer = loadKeypair(cfg.walletPath);
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const state = loadState(cfg.statePath);
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Sync existing open daily markets and run immediate self-sweep settlement
  await batchSyncOpenMarkets(connection, state, nowSec);
  saveState(cfg.statePath, state);
  const watchDue = selectWatchEntries(state.markets, nowSec);
  scheduleWatches(cfg, settleScriptPath, watchDue, nowSec);
  const watchedAddrs = new Set(watchDue.map((e) => e.address));
  scheduleExpiredSettlements(cfg, settleScriptPath, state.markets, nowSec, watchedAddrs);

  // 2. Check whether today's fixed-time 24h slot should open
  const slot = computeDailySlot(
    nowSec,
    cfg.openHourUtc,
    cfg.openMinuteUtc,
    cfg.assets,
    cfg.durationSec
  );
  const gate = shouldOpenDailySlot({
    nowSec,
    slot,
    openWindowSec: cfg.openWindowSec,
    state,
    forceOpen,
  });

  if (!gate.open) {
    console.log(`[daily] slot=${slot.slotKey} asset=${slot.asset.key} skipped (${gate.reason}).`);
  } else if (!isActiveWindowOpen(cfg, nowSec)) {
    console.log("[daily] Outside SANDBOX_ACTIVE_FILE activity window; skipping creation.");
  } else {
    const mintMeta = await fetchMintMeta(connection, cfg.collateralMint);
    const scale = 10 ** mintMeta.decimals;
    const seedAtoms = BigInt(Math.round(cfg.seedUsdt * scale));
    const betAtoms = cfg.betUsdt > 0 ? BigInt(Math.round(cfg.betUsdt * scale)) : 0n;
    if (seedAtoms <= 1_000_000n) {
      throw new Error("DAILY_SEED_USDT must produce > 1,000,000 raw collateral units");
    }

    const creatorCollateralAta = ataOf(cfg.collateralMint, payer.publicKey, mintMeta.tokenProgram);
    let [solLamports, usdtBal] = await Promise.all([
      connection.getBalance(payer.publicKey, "confirmed"),
      safeTokenAmount(connection, creatorCollateralAta, mintMeta.tokenProgram),
    ]);

    if (
      cfg.recycleFunds &&
      (usdtBal.amount < seedAtoms + betAtoms || solLamports < cfg.minSolLamports)
    ) {
      await recycleFinalizedEntries(connection, program, payer, cfg, state);
      [solLamports, usdtBal] = await Promise.all([
        connection.getBalance(payer.publicKey, "confirmed"),
        safeTokenAmount(connection, creatorCollateralAta, mintMeta.tokenProgram),
      ]);
    }

    if (solLamports < cfg.minSolLamports) {
      console.warn(
        `[daily] Operator SOL balance ${solLamports} lamports is below SANDBOX_MIN_SOL_LAMPORTS (${cfg.minSolLamports}); skipping creation.`
      );
    } else if (usdtBal.amount < seedAtoms + betAtoms) {
      console.warn(
        `[daily] Collateral balance ${usdtBal.amount} below ${seedAtoms + betAtoms}; cannot open ${slot.asset.symbol}.`
      );
    } else {
      const feedInfo = await connection.getAccountInfo(slot.asset.feed, "confirmed");
      if (!feedInfo) {
        console.warn(`[daily] Chainlink feed account not found for ${slot.asset.symbol}`);
      } else {
        const feed = decodeChainlinkFeed(Buffer.from(feedInfo.data));
        const title = defaultTitleForAsset(slot.asset.symbol, cfg.durationSec);
        const marketId = Array.from(crypto.randomBytes(MARKET_ID_BYTES));
        const prediction = encodePrediction(title);

        const { pdas, ixs: createIxs } = await buildCreateMarketIxs(program, {
          creator: payer.publicKey,
          collateralMint: cfg.collateralMint,
          ocr2State: slot.asset.ocr2State,
          marketId,
          prediction,
          expiry: slot.expiry,
          collateralAmount: seedAtoms,
          threshold: feed.answer,
          settleAbove: true,
          tokenProgram: mintMeta.tokenProgram,
        });

        const createSig = await sendAndConfirm(connection, payer, createIxs);
        const marketAddr = pdas.market.toBase58();
        const entry = {
          address: marketAddr,
          asset: slot.asset.key,
          dailySlot: slot.slotKey,
          idHex: Buffer.from(marketId).toString("hex"),
          title,
          expiry: slot.expiry,
          threshold: feed.answer.toString(),
          priceDecimals: feed.decimals,
          status: "open",
          winner: null,
          createdAt: nowSec,
          createTx: createSig,
          betSide: null,
          betTx: null,
          recycled: false,
        };
        state.markets.push(entry);
        const today = utcDayKey(nowSec);
        state.dailyCounts[today] = Number(state.dailyCounts[today] || 0) + 1;
        saveState(cfg.statePath, state);
        console.log(
          `[daily:create] slot=${slot.slotKey} (${slot.asset.symbol}) ${marketAddr} expiry=${slot.expiry} seed=${cfg.seedUsdt} USDT tx=${createSig}`
        );
        await persistCreatedMarketToDb(connection, cfg.programId, pdas.market, nowSec);

        if (betAtoms > 0n) {
          const side = state.nextBetSide === "no" ? "no" : "yes";
          const betIxs = await buildUserBetOnIxs(program, {
            market: pdas.market,
            pdas,
            signer: payer.publicKey,
            collateralMint: cfg.collateralMint,
            tokenProgram: mintMeta.tokenProgram,
            collateralAmount: betAtoms,
            side,
            minOut: betAtoms / 2n,
          });
          const betSig = await sendAndConfirm(connection, payer, betIxs);
          entry.betSide = side;
          entry.betTx = betSig;
          state.nextBetSide = side === "yes" ? "no" : "yes";
          saveState(cfg.statePath, state);
          console.log(`[daily:bet] (${slot.asset.symbol}) ${marketAddr} side=${side} amount=${cfg.betUsdt} USDT tx=${betSig}`);
          await persistCreatedMarketToDb(connection, cfg.programId, pdas.market, nowSec);
        }
      }
    }
  }

  if (cfg.recycleFunds) {
    await recycleFinalizedEntries(connection, program, payer, cfg, state);
  }

  if (state.markets.length > 200) {
    const activeEntries = state.markets.filter((m) => m.status === "open" || !m.recycled);
    const archivedEntries = state.markets
      .filter((m) => m.status !== "open" && m.recycled)
      .slice(-200);
    state.markets = [...archivedEntries, ...activeEntries];
    saveState(cfg.statePath, state);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) usage(0);
  if (args.includes("--self-check")) {
    await runSelfCheck();
    return;
  }
  await runDailyTick({ forceOpen: args.includes("--force-open") });
}

if (require.main === module) main().catch((err) => {
  console.error("SANDBOX_DAILY_FAIL:", err && err.stack ? err.stack : err);
  process.exit(1);
});

module.exports = {
  DAILY_DURATION_SEC,
  getDailyConfig,
  computeDailySlot,
  shouldOpenDailySlot,
};
