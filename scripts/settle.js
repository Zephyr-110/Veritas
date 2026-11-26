#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { AnchorProvider, Program, Wallet, utils } = require("@coral-xyz/anchor");
const { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } = require("@solana/spl-token");
const { WAKE_SEC, WATCH_AFTER_SEC, tryLock, watchReports } = require(
  fs.existsSync(path.join(__dirname, "sandbox", "expiry-watch.js"))
    ? "./sandbox/expiry-watch"
    : "./expiry-watch"
);

function loadOptionalModule(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return require(p);
      } catch {
        return null;
      }
    }
  }
  return null;
}
const dbLib = loadOptionalModule([
  path.join(__dirname, "db.js"),
  path.join(__dirname, "..", "db.js"),
]);
const indexerLib = loadOptionalModule([
  path.join(__dirname, "index-markets.js"),
  path.join(__dirname, "..", "index-markets.js"),
]);
const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_PROGRAM_ID = "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER";
const CHAINLINK_OCR2_PROGRAM_ID = new PublicKey("cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ");

const MARKET_ACCOUNT_SIZE = 409;
const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154];
const MARKET_SNAPSHOT_DISCRIMINATOR = [107, 32, 221, 188, 130, 114, 104, 28];
const OCR2_STATE_DISCRIMINATOR = [216, 146, 107, 94, 104, 75, 182, 177];

const STATE_F_OFFSET = 272;
const STATE_DIGEST_OFFSET = 320;
const STATE_OFFCHAIN_BUF_OFFSET = 376;
const STATE_OFFCHAIN_CAP = 4096;
const STATE_OFFCHAIN_LEN_OFFSET = STATE_OFFCHAIN_BUF_OFFSET + STATE_OFFCHAIN_CAP;
const STATE_MIN_LEN = 6920;

const CONTEXT_LEN = 96;
const REPORT_LEN = 61;
const SIGNATURE_LEN = 65;
const RAW_REPORT_HEADER_LEN = 1 + CONTEXT_LEN + REPORT_LEN;

const MAX_SIGNATURE_PAGES = 20;
const SIGNATURES_PER_PAGE = 500;
const TX_BATCH_SIZE = 8;
const SELF_SETTLE_SLOT_PREFIX = "settle-slot-";
const DEFAULT_SELF_SETTLE_SLOTS = 4;
const DEFAULT_HARD_TIMEOUT_MS = 300_000;
const NORMAL_RPC_TIMEOUT_MS = 15_000;

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/settle.js <MARKET_PUBKEY> [options]

Options:
  --dry-run           Locate straddling OCR2 reports without sending a transaction
  --watch <feed>      Watch the expiry window for a strictly adjacent pair
  --self-settle       Acquire a bounded self-settle slot (settle-slot-0..N) before running
  --keypair <path>    Path to Solana JSON keypair file
  --rpc <url>         Solana RPC endpoint override
  -h, --help          Show this help message

Environment variables:
  SOLANA_RPC / RPC_URL         Solana RPC URL (default: ${DEFAULT_RPC})
  ANCHOR_WALLET / WALLET_PATH  Keypair JSON path (default: ~/.config/solana/id.json)
  PROGRAM_ID                   Prediction market program ID (default: ${DEFAULT_PROGRAM_ID})
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = { market: null, dryRun: false, selfSettle: false, keypair: null, rpc: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage(0);
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--self-settle") {
      opts.selfSettle = true;
    } else if (arg === "--watch") {
      opts.feed = new PublicKey(argv[++i]);
    } else if (arg === "--keypair") {
      opts.keypair = argv[++i];
      if (!opts.keypair) throw new Error("--keypair requires a path");
    } else if (arg === "--rpc") {
      opts.rpc = argv[++i];
      if (!opts.rpc) throw new Error("--rpc requires a URL");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!opts.market) {
      opts.market = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return opts;
}

function defaultWalletPath() {
  return path.join(os.homedir(), ".config", "solana", "id.json");
}

function loadKeypair(cliPath, allowDummy) {
  const candidate = cliPath || process.env.ANCHOR_WALLET || process.env.WALLET_PATH || defaultWalletPath();
  if (!fs.existsSync(candidate)) {
    if (allowDummy) return { payer: Keypair.generate(), path: null };
    throw new Error(
      `Wallet keypair file not found: ${candidate}\nSet ANCHOR_WALLET / WALLET_PATH, pass --keypair <path>, or create ~/.config/solana/id.json.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`Invalid keypair JSON in ${candidate}`);
  return { payer: Keypair.fromSecretKey(Uint8Array.from(raw)), path: candidate };
}

function loadIdl(programId) {
  const repoRoot = path.resolve(__dirname, "..");
  const candidates = [
    path.join(repoRoot, "app", "src", "idl", "prediction_market.json"),
    path.join(repoRoot, "target", "idl", "prediction_market.json"),
  ];
  const idlPath = candidates.find((p) => fs.existsSync(p));
  if (!idlPath) {
    throw new Error(`Anchor IDL not found. Checked:\n  ${candidates.join("\n  ")}`);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  idl.address = programId.toBase58();
  return idl;
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameDisc(actual, expected) {
  if (actual.length < expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

class Cursor {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.offset = offset;
  }
  take(n) {
    if (this.offset + n > this.buf.length) throw new Error("Unexpected end of account data");
    const slice = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
  u8() {
    return this.take(1)[0];
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    return this.take(2).readUInt16LE(0);
  }
  u32() {
    return this.take(4).readUInt32LE(0);
  }
  u64() {
    return this.take(8).readBigUInt64LE(0);
  }
  i64() {
    return this.take(8).readBigInt64LE(0);
  }
  i128() {
    const lo = this.take(8).readBigUInt64LE(0);
    const hi = this.take(8).readBigInt64LE(0);
    return (hi << 64n) + lo;
  }
  pubkey() {
    return new PublicKey(this.take(32));
  }
  bytes(n) {
    return Array.from(this.take(n));
  }
}

function decodeMarket(data) {
  if (data.length !== MARKET_ACCOUNT_SIZE || !sameDisc(data, MARKET_DISCRIMINATOR)) {
    throw new Error("Account is not a valid PredictionMarket Market account");
  }
  const c = new Cursor(data, 8);
  const expiry = Number(c.u64());
  const creator = c.pubkey();
  const id = c.bytes(16);
  const bump = c.u8();
  const yesMint = c.pubkey();
  const noMint = c.pubkey();
  const statusByte = c.u8();
  const statusMap = ["open", "resolved", "windowBurn", "staleBurn"];
  const status = statusMap[statusByte];
  if (!status) throw new Error(`Unknown market status byte: ${statusByte}`);
  const collateralMint = c.pubkey();
  const winnerTag = c.u8();
  const winner = winnerTag === 0 ? null : winnerTag === 1 ? (c.u8() === 0 ? "yes" : "no") : null;
  const marketCollateralBump = c.u8();
  const predictionRaw = c.bytes(64);
  const finishTs = Number(c.u64());
  c.i128(); // lZero
  c.i64(); // lastAccrualTs
  c.i128(); // cumYesPerShare
  c.i128(); // cumNoPerShare
  c.u16(); // feeBps
  c.i128(); // reserveYes
  c.i128(); // reserveNo
  c.i128(); // totalLpShares
  const endTs = Number(c.i64());
  const ocr2State = c.pubkey();
  const threshold = c.i64();
  const priceDecimals = c.u8();
  const settleAbove = c.bool();
  const settledPrice = c.i64();
  const settledPublishTime = Number(c.i64());

  const titleEnd = predictionRaw.indexOf(0);
  const title = Buffer.from(titleEnd >= 0 ? predictionRaw.slice(0, titleEnd) : predictionRaw).toString("utf8");

  return {
    expiry,
    creator,
    id,
    bump,
    yesMint,
    noMint,
    status,
    collateralMint,
    winner,
    marketCollateralBump,
    title,
    finishTs,
    endTs,
    ocr2State,
    threshold,
    priceDecimals,
    settleAbove,
    settledPrice,
    settledPublishTime,
  };
}

function decodeMarketSnapshot(data) {
  if (!sameDisc(data, MARKET_SNAPSHOT_DISCRIMINATOR)) return null;
  const c = new Cursor(data, 8);
  const len = c.u32();
  if (len > 16) return null;
  const entries = [];
  for (let i = 0; i < len; i += 1) {
    entries.push({
      epoch: c.u32(),
      round: c.u8(),
      counter: c.u32(),
      price: c.i128(),
      ts: Number(c.i64()),
    });
  }
  return { entries };
}

function snapshotMatches(snapshot, pre, post) {
  for (let i = 0; i < snapshot.entries.length; i += 1) {
    const x = snapshot.entries[i];
    if (x.epoch !== pre.epoch || x.round !== pre.round) continue;
    const next = snapshot.entries[i + 1];
    if (!next) return false;
    return next.counter === x.counter + 1 && next.round === post.round && next.epoch === post.epoch;
  }
  return false;
}

function readVarint(buf, pos) {
  let value = 0n;
  for (let shiftIdx = 0; shiftIdx < 10; shiftIdx += 1) {
    if (pos.i >= buf.length) throw new Error("Invalid OCR2 offchain config varint");
    const b = buf[pos.i];
    pos.i += 1;
    const bits = BigInt(b & 0x7f);
    if (shiftIdx === 9 && bits > 1n) throw new Error("Invalid OCR2 offchain config varint overflow");
    value |= bits << BigInt(7 * shiftIdx);
    if ((b & 0x80) === 0) return value;
  }
  throw new Error("Invalid OCR2 offchain config varint");
}

function readRMax(stateData) {
  if (stateData.length < STATE_MIN_LEN || !sameDisc(stateData, OCR2_STATE_DISCRIMINATOR)) {
    throw new Error("Invalid Chainlink OCR2 state account");
  }
  const lenBig = stateData.readBigUInt64LE(STATE_OFFCHAIN_LEN_OFFSET);
  if (lenBig > BigInt(STATE_OFFCHAIN_CAP)) throw new Error("Invalid OCR2 offchain config length");
  const cfg = stateData.subarray(STATE_OFFCHAIN_BUF_OFFSET, STATE_OFFCHAIN_BUF_OFFSET + Number(lenBig));
  const pos = { i: 0 };
  let rMax = null;
  while (pos.i < cfg.length) {
    const tag = readVarint(cfg, pos);
    const wire = Number(tag & 7n);
    const field = tag >> 3n;
    if (wire === 0) {
      const v = readVarint(cfg, pos);
      if (field === 6n) {
        if (rMax !== null || v < 1n || v > 255n) throw new Error("Invalid OCR2 rMax field");
        rMax = Number(v);
      }
    } else if (wire === 1) {
      pos.i += 8;
    } else if (wire === 2) {
      const l = Number(readVarint(cfg, pos));
      pos.i += l;
    } else if (wire === 5) {
      pos.i += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire} in OCR2 config`);
    }
  }
  if (rMax === null) throw new Error("OCR2 rMax missing from offchain config");
  return rMax;
}

function parseOcr2State(stateData) {
  return {
    f: stateData[STATE_F_OFFSET],
    latestConfigDigest: Buffer.from(stateData.subarray(STATE_DIGEST_OFFSET, STATE_DIGEST_OFFSET + 32)),
    rMax: readRMax(stateData),
  };
}

function readI128BE(buf, offset) {
  const hi = buf.readBigInt64BE(offset);
  const lo = buf.readBigUInt64BE(offset + 8);
  return (hi << 64n) + lo;
}

function parseOcr2Transmit(rawBytes, expectedDigest, expectedF) {
  const raw = Buffer.from(rawBytes);
  if (raw.length <= RAW_REPORT_HEADER_LEN) return null;
  const sigBytes = raw.length - RAW_REPORT_HEADER_LEN;
  if (sigBytes % SIGNATURE_LEN !== 0) return null;
  const sigCount = sigBytes / SIGNATURE_LEN;
  if (expectedF != null && sigCount !== expectedF + 1) return null;

  const configDigest = Buffer.from(raw.subarray(1, 33));
  if (expectedDigest && !configDigest.equals(expectedDigest)) return null;

  const epoch = raw.readUInt32BE(1 + 59);
  const round = raw[1 + 63];
  const rawReportOffset = 1 + CONTEXT_LEN;
  const observationsTimestamp = raw.readUInt32BE(rawReportOffset);
  const observerCount = raw[rawReportOffset + 4];
  if (expectedF != null && expectedF >= observerCount) return null;
  const median = readI128BE(raw, rawReportOffset + 37);

  return { raw, configDigest, epoch, round, observationsTimestamp, observerCount, median };
}

function areReportsAdjacent(pre, post, rMax) {
  if (pre.round === rMax && post.round === 1 && pre.epoch + 1 === post.epoch) return true;
  if (pre.round < rMax && post.round === pre.round + 1 && pre.epoch === post.epoch) return true;
  return false;
}

function decodeIxData(raw) {
  if (typeof raw === "string") return Buffer.from(utils.bytes.bs58.decode(raw));
  return Buffer.from(raw);
}

function extractOcr2Instructions(tx) {
  if (!tx) return [];
  const message = tx.transaction.message;
  const accountKeys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta && tx.meta.loadedAddresses ? tx.meta.loadedAddresses : undefined,
  });
  const out = [];
  for (const ix of message.compiledInstructions) {
    const pid = accountKeys.get(ix.programIdIndex);
    if (pid && pid.equals(CHAINLINK_OCR2_PROGRAM_ID)) {
      out.push(decodeIxData(ix.data));
    }
  }
  if (tx.meta && tx.meta.innerInstructions) {
    for (const group of tx.meta.innerInstructions) {
      for (const ix of group.instructions) {
        const pid = accountKeys.get(ix.programIdIndex);
        if (pid && pid.equals(CHAINLINK_OCR2_PROGRAM_ID)) {
          out.push(decodeIxData(ix.data));
        }
      }
    }
  }
  return out;
}

async function fetchTxBatch(connection, signatures) {
  if (!signatures.length) return [];
  try {
    return await connection.getTransactions(signatures, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    const out = [];
    for (const sig of signatures) {
      try {
        out.push(
          await connection.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
        );
      } catch {
        out.push(null);
      }
      await pause(120);
    }
    return out;
  }
}

async function collectSignaturesAround(connection, ocr2State, minTime) {
  const all = [];
  let before;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
    const batch = await connection.getSignaturesForAddress(
      ocr2State,
      { limit: SIGNATURES_PER_PAGE, before },
      "confirmed"
    );
    if (!batch.length) break;
    all.push(...batch);
    const oldest = batch[batch.length - 1];
    if (oldest.blockTime != null && oldest.blockTime < minTime) break;
    if (batch.length < SIGNATURES_PER_PAGE) break;
    before = oldest.signature;
    await pause(80);
  }
  return all;
}

function pickStraddlingPair(reports, endTs, rMax, snapshot) {
  if (!reports.length) return null;
  const sorted = [...reports].sort((a, b) => {
    if (a.epoch !== b.epoch) return a.epoch - b.epoch;
    if (a.round !== b.round) return a.round - b.round;
    return a.observationsTimestamp - b.observationsTimestamp;
  });
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const pre = sorted[i];
    const post = sorted[i + 1];
    if (pre.observationsTimestamp < endTs && post.observationsTimestamp >= endTs) {
      const adjacent = areReportsAdjacent(pre, post, rMax);
      const certified = snapshot ? snapshotMatches(snapshot, pre, post) : false;
      if (adjacent || certified) {
        return { pre, post, adjacent, certified, hasSnapshot: Boolean(snapshot) };
      }
    }
  }
  return null;
}

async function findStraddlingReports(connection, ocr2State, endTs, snapshot) {
  const stateInfo = await connection.getAccountInfo(ocr2State, "confirmed");
  if (!stateInfo) throw new Error(`OCR2 state account not found: ${ocr2State.toBase58()}`);
  const state = parseOcr2State(Buffer.from(stateInfo.data));

  const lookbackStart = endTs - 900;
  const sigs = await collectSignaturesAround(connection, ocr2State, lookbackStart);
  if (!sigs.length) throw new Error("No OCR2 transactions found in RPC history window");

  const sigToReport = new Map();
  const seenKey = new Set();
  const collected = [];

  const absorbTxs = async (list) => {
    for (let i = 0; i < list.length; i += TX_BATCH_SIZE) {
      const chunk = list.slice(i, i + TX_BATCH_SIZE).filter((s) => !sigToReport.has(s.signature));
      if (!chunk.length) continue;
      const txs = await fetchTxBatch(
        connection,
        chunk.map((c) => c.signature)
      );
      txs.forEach((tx, idx) => {
        const sig = chunk[idx].signature;
        for (const ixData of extractOcr2Instructions(tx)) {
          const parsed = parseOcr2Transmit(ixData, state.latestConfigDigest, state.f);
          if (!parsed) continue;
          parsed.pushSignature = sig;
          sigToReport.set(sig, parsed);
          const id = `${parsed.epoch}:${parsed.round}`;
          if (!seenKey.has(id)) {
            seenKey.add(id);
            collected.push(parsed);
          }
        }
      });
      const hit = pickStraddlingPair(collected, endTs, state.rMax, snapshot);
      if (hit) return hit;
      if (i + TX_BATCH_SIZE < list.length) await pause(90);
    }
    return null;
  };

  const tight = sigs
    .filter((s) => s.blockTime == null || (s.blockTime >= endTs - 120 && s.blockTime <= endTs + 120))
    .sort((a, b) => Math.abs((a.blockTime ?? endTs) - endTs) - Math.abs((b.blockTime ?? endTs) - endTs));
  const hitTight = await absorbTxs(tight);
  if (hitTight) return hitTight;

  const tightSet = new Set(tight.map((s) => s.signature));
  const wide = sigs
    .filter(
      (s) =>
        !tightSet.has(s.signature) &&
        (s.blockTime == null || (s.blockTime >= endTs - 900 && s.blockTime <= endTs + 3600))
    )
    .sort((a, b) => Math.abs((a.blockTime ?? endTs) - endTs) - Math.abs((b.blockTime ?? endTs) - endTs))
    .slice(0, 64);
  const hitWide = await absorbTxs(wide);
  if (hitWide) return hitWide;

  const hasPre = collected.some((r) => r.observationsTimestamp < endTs);
  const hasPost = collected.some((r) => r.observationsTimestamp >= endTs);
  if (!hasPost) throw new Error("No post-expiry Chainlink OCR2 report found in RPC history");
  if (!hasPre) throw new Error("No pre-expiry Chainlink OCR2 report found in RPC history");
  throw new Error("Could not find an adjacent or snapshot-certified OCR2 report pair straddling expiry");
}

function formatPrice(rawMedian, decimals) {
  return (Number(rawMedian) / 10 ** decimals).toFixed(decimals > 4 ? 4 : decimals);
}

async function resolveTx(program, payer, marketPubkey, market, pair, snapshot) {
  const ix = await program.methods.resolveMarket({ rawPre: pair.pre.raw, rawPost: pair.post.raw })
    .accountsPartial({ signer: payer.publicKey, market: marketPubkey, snapshot,
      ocr2State: market.ocr2State, clock: SYSVAR_CLOCK_PUBKEY }).instruction();
  return new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix);
}

const SNAPSHOT_PRE_LEAD_SEC = 8;
const SNAPSHOT_MAX_ENTRIES = 16;
const SNAPSHOT_MAX_SUBMISSIONS = 10;
const SNAPSHOT_RETRY_MS = 1500;
const SNAPSHOT_POLL_MS = 650;
const SNAPSHOT_FAST_POLL_MS = 300;
const SNAPSHOT_WAIT_POST_MS = 2800;

function createSnapshotCoordinator(endTs, { maxWaitMs = SNAPSHOT_WAIT_POST_MS } = {}) {
  let postRecorded = false;
  let finished = false;
  let stopped = false;
  let lastChainNow = 0;
  let wakePoll = null;
  const waiters = new Set();

  const notifyWaiters = () => {
    for (const notify of [...waiters]) notify();
  };

  return {
    get postRecorded() {
      return postRecorded;
    },
    get finished() {
      return finished;
    },
    get stopped() {
      return stopped;
    },
    get isWaiting() {
      return waiters.size > 0;
    },
    get lastChainNow() {
      return lastChainNow;
    },
    updateChainNow(chainNow) {
      lastChainNow = chainNow;
      if (chainNow >= endTs + 9) notifyWaiters();
    },
    markPostRecorded() {
      postRecorded = true;
      notifyWaiters();
      if (wakePoll) wakePoll();
    },
    finish() {
      finished = true;
      notifyWaiters();
    },
    stop() {
      stopped = true;
      if (wakePoll) wakePoll();
      notifyWaiters();
    },
    nudge() {
      if (wakePoll) wakePoll();
    },
    sleep(ms) {
      if (ms <= 0 || stopped || finished || postRecorded) return Promise.resolve();
      return new Promise((resolve) => {
        let timer = null;
        const done = () => {
          if (timer) clearTimeout(timer);
          timer = null;
          if (wakePoll === done) wakePoll = null;
          resolve();
        };
        wakePoll = done;
        timer = setTimeout(done, ms);
      });
    },
    async waitForPost(deadlineMs) {
      if (postRecorded || finished || stopped) return postRecorded;
      if (lastChainNow >= endTs + 9) return false;
      this.nudge();
      const now = Date.now();
      const capMs = Math.min(now + maxWaitMs, (endTs + 9) * 1000, deadlineMs ?? Infinity);
      const remaining = capMs - now;
      if (remaining <= 0) return postRecorded;
      await new Promise((resolve) => {
        let timer = null;
        const check = () => {
          if (!postRecorded && !finished && !stopped && lastChainNow < endTs + 9) return;
          cleanup();
        };
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          timer = null;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        timer = setTimeout(cleanup, remaining);
        check();
      });
      return postRecorded;
    },
  };
}

// Snapshot writes run alongside the report watcher. Read the feed, clock and existing
// witnesses at one bank slot so a browser or an earlier worker's write counts too.
async function recordExpirySnapshots(
  connection,
  program,
  payer,
  address,
  market,
  feed,
  coord = null,
  { pollMs = SNAPSHOT_POLL_MS, fastPollMs = SNAPSHOT_FAST_POLL_MS, retryAfterMs = SNAPSHOT_RETRY_MS } = {}
) {
  try {
    const { endTs } = market;
    const waitMs = (endTs - WAKE_SEC) * 1000 - Date.now();
    if (waitMs > 75_000) return;
    if (waitMs > 0) await (coord ? coord.sleep(waitMs) : pause(waitMs));
    const deadline = (endTs + 12) * 1000;
    const [snapshot] = PublicKey.findProgramAddressSync([Buffer.from("snapshot"), address.toBuffer()], program.programId);
    const attempted = new Map();
    let submissions = 0;
    let lastSubmittedAt = 0;
    while (Date.now() < deadline && !coord?.stopped) {
      try {
        const [head, saved, clock] = await connection.getMultipleAccountsInfo([feed, snapshot, SYSVAR_CLOCK_PUBKEY], "processed");
        if (!head || !saved || !clock) return;
        const chainNow = Number(clock.data.readBigInt64LE(32));
        const counter = head.data.readUInt32LE(143);
        const publishTime = Number(head.data.readBigInt64LE(208));
        const entries = decodeMarketSnapshot(saved.data)?.entries;
        if (!entries) return;
        if (entries.at(-1)?.ts >= endTs) {
          coord?.markPostRecorded();
          return;
        }
        coord?.updateChainNow(chainNow);
        if (entries.length >= SNAPSHOT_MAX_ENTRIES || chainNow >= endTs + 10) return;
        if (submissions >= SNAPSHOT_MAX_SUBMISSIONS && Date.now() - lastSubmittedAt >= retryAfterMs) return;
        const nowMs = Date.now();
        if (shouldRecordSnapshot({ endTs, chainNow, counter, publishTime, entries, attempted, submissions, nowMs, retryAfterMs })) {
          const ix = await program.methods.takeSnapshot().accountsPartial({
            caller: payer.publicKey, market: address, snapshot, ocr2State: market.ocr2State,
            feed, clock: SYSVAR_CLOCK_PUBKEY, systemProgram: SystemProgram.programId,
          }).instruction();
          const { blockhash } = await connection.getLatestBlockhash("confirmed");
          const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(ix);
          tx.sign(payer);
          if (coord?.stopped || Date.now() >= deadline) return;
          const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
          const sentAt = Date.now();
          submissions += 1;
          lastSubmittedAt = sentAt;
          attempted.set(counter, sentAt);
          console.log(`[snapshot] ${address} submitted counter=${counter} tx=${sig}`);
        }
      } catch (err) {
        console.warn(`[snapshot] ${address}: ${err.message}`);
      }
      if (Date.now() < deadline && !coord?.stopped) {
        const delay = coord?.isWaiting ? fastPollMs : pollMs;
        await (coord ? coord.sleep(delay) : pause(delay));
      }
    }
  } finally {
    coord?.finish();
  }
}

function shouldRecordSnapshot({
  endTs,
  chainNow,
  counter,
  publishTime,
  entries,
  attempted,
  submissions = 0,
  nowMs = Date.now(),
  retryAfterMs = SNAPSHOT_RETRY_MS,
}) {
  if (chainNow < endTs - SNAPSHOT_PRE_LEAD_SEC || chainNow >= endTs + 10) return false;
  if (publishTime <= 0 || entries.length >= SNAPSHOT_MAX_ENTRIES || submissions >= SNAPSHOT_MAX_SUBMISSIONS) {
    return false;
  }
  const last = entries.at(-1);
  if (last && (last.ts >= endTs || last.counter >= counter)) return false;
  if (attempted instanceof Map) {
    const sentAt = attempted.get(counter);
    if (sentAt != null && nowMs - sentAt < retryAfterMs) return false;
  } else if (attempted && typeof attempted.has === "function") {
    if (attempted.has(counter)) return false;
  }
  return true;
}

async function runWatch(connection, program, payer, marketPk, market, opts, coord = null) {
  const endTs = market.endTs;
  const log = msg => console.log(`[wake] ${new Date().toISOString()} ${marketPk} ${msg}`);
  const waitMs = (endTs - WAKE_SEC) * 1000 - Date.now();
  if (waitMs > 75_000) throw new Error("Market outside keeper scheduling range");
  if (waitMs > 0) await pause(waitMs);
  if (Date.now() >= (endTs + WATCH_AFTER_SEC) * 1000) return;
  log(`awake endTs=${endTs}`);
  const stateInfo = await connection.getAccountInfo(market.ocr2State, "confirmed");
  const state = parseOcr2State(stateInfo.data);
  const seen = new Set();
  let newest;
  const pending = new Set();
  await watchReports({
    endTs, log,
    readHead: async () => {
      const [feed, config] = await connection.getMultipleAccountsInfo([opts.feed, market.ocr2State], "confirmed");
      if (!feed || !config) throw new Error("Feed or OCR2 state account unavailable");
      return { counter: feed.data.readUInt32LE(143), id: config.data.readUInt32LE(276) + "/" + config.data[273] };
    },
    collect: async () => {
      const recent = await connection.getSignaturesForAddress(opts.feed, { limit: newest ? 12 : 4, until: newest }, "confirmed");
      for (const item of recent) {
        if (!item.err && !seen.has(item.signature)) pending.add(item.signature);
      }
      if (recent.length) newest = recent[0].signature;
      const collected = [];
      const batch = [...pending].slice(0, 2);
      // Rotate missing bodies so an unindexed signature cannot starve later reports.
      for (const sig of batch) { pending.delete(sig); pending.add(sig); }
      const reads = await Promise.allSettled(batch.map(async signature => {
        const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!tx) return; // Indexed signature without transaction body: retry next pass.
        for (const raw of extractOcr2Instructions(tx)) {
          const r = parseOcr2Transmit(raw, state.latestConfigDigest, state.f);
          if (r) {
            r.pushSignature = signature;
            collected.push(r);
          }
        }
        seen.add(signature);
        pending.delete(signature);
      }));
      if (reads.length && reads.every(r => r.status === "rejected")) throw reads[0].reason;
      return collected;
    },
    pick: reports => pickStraddlingPair(reports, endTs, state.rMax, null),
    onPair: async (pair, deadline) => {
      if (opts.dryRun) return log("dry run; pair ready");
      if (coord) {
        const recorded = await coord.waitForPost(deadline);
        if (!recorded) log("post snapshot wait timed out; resolving anyway");
        coord.stop();
      }
      const tx = await resolveTx(program, payer, marketPk, market, pair, null);
      tx.feePayer = payer.publicKey;
      const latest = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = latest.blockhash;
      tx.sign(payer);
      if (Date.now() >= deadline) return log("submission window ended");
      const signature = utils.bytes.bs58.encode(tx.signature);
      try {
        await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
        log(`submitted ${signature}`);
      } catch (e) { log(`send response uncertain ${signature}: ${e.message}`); }
      // The global sweep re-reads chain state after this worker releases its lock.
      const confirmDeadline = Date.now() + 30_000;
      for (let n = 0; Date.now() < confirmDeadline; n++) {
        try {
          const status = (await connection.getSignatureStatuses([signature])).value[0];
          if (status?.err) return log(`resolve rejected: ${JSON.stringify(status.err)}`);
          if (status && ["confirmed", "finalized"].includes(status.confirmationStatus)) {
            const info = await connection.getAccountInfo(marketPk, "confirmed");
            if (info) {
              const result = decodeMarket(info.data);
              if (result.status !== "open") {
                await persistSettledMarket(connection, program.programId, marketPk, pair, signature, opts.feed);
                return log(`status=${result.status} finishTs=${result.finishTs} expiryToChain=${result.finishTs - endTs}s tx=${signature}`);
              }
            }
          }
          if (n % 5 === 0 && await connection.getBlockHeight("confirmed") > latest.lastValidBlockHeight && !status) break;
        } catch (e) { if (n % 10 === 0) log(`recheck: ${e.message}`); }
        await pause(1200);
      }
      log(`result unavailable; global sweep will recheck ${signature}`);
    },
  });
}

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveHardTimeoutMs() {
  return envPositiveInt("SETTLE_HARD_TIMEOUT_MS", DEFAULT_HARD_TIMEOUT_MS);
}

function resolveSelfSettleSlots() {
  return Math.max(1, envPositiveInt("SETTLE_SLOT_COUNT", DEFAULT_SELF_SETTLE_SLOTS));
}

function resolveNormalRpcTimeoutMs() {
  return envPositiveInt("SETTLE_RPC_TIMEOUT_MS", NORMAL_RPC_TIMEOUT_MS);
}

function fetchWithTimeout(timeoutMs) {
  return (url, init) => {
    const t = AbortSignal.timeout(timeoutMs);
    const signal =
      init?.signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([init.signal, t])
        : t;
    return fetch(url, { ...init, signal });
  };
}

function armHardTimeout({
  isWatch,
  timeoutMs = resolveHardTimeoutMs(),
  log = console.error,
  onTimeout = () => process.exit(1),
} = {}) {
  if (isWatch) return () => {};
  const timer = setTimeout(() => {
    log(`[settle] hard timeout exceeded (${timeoutMs}ms), exiting`);
    onTimeout();
  }, timeoutMs);
  return () => clearTimeout(timer);
}

async function acquireSelfSettleSlot(slotCount = resolveSelfSettleSlots(), lockFn = tryLock) {
  for (let i = 0; i < slotCount; i += 1) {
    const rel = await lockFn(`${SELF_SETTLE_SLOT_PREFIX}${i}`);
    if (rel) return rel;
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.market) usage(1);

  let marketPubkey;
  try {
    marketPubkey = new PublicKey(opts.market);
  } catch {
    throw new Error(`Invalid market pubkey: ${opts.market}`);
  }

  const disarmTimeout = armHardTimeout({ isWatch: Boolean(opts.feed) });
  try {
    const release = opts.dryRun ? () => {} : await tryLock(marketPubkey.toBase58());
    if (!release) return console.log(`[settle] ${marketPubkey} already in flight`);
    let releaseSlot;
    try {
      if (opts.feed) {
        releaseSlot = await tryLock("expiry-slot-0") || await tryLock("expiry-slot-1");
        if (!releaseSlot) return console.log("[wake] busy; global sweep will retry");
      } else if (opts.selfSettle && !opts.dryRun) {
        releaseSlot = await acquireSelfSettleSlot();
        if (!releaseSlot) {
          return console.log(`[settle] ${marketPubkey} self-settle slots busy; will retry next tick`);
        }
      }
      await settle(opts, marketPubkey);
    } finally {
      releaseSlot?.();
      release();
    }
  } finally {
    disarmTimeout();
  }
}

async function persistSettledMarket(connection, programId, marketPk, pair, resolveSig, feedPk) {
  if (!dbLib || !pair || !resolveSig) return;
  const db = dbLib.tryOpenDb();
  if (!db) return;
  try {
    const [marketInfo, snapshotPda] = await Promise.all([
      connection.getAccountInfo(marketPk, "confirmed"),
      Promise.resolve(
        PublicKey.findProgramAddressSync(
          [Buffer.from("snapshot"), marketPk.toBuffer()],
          programId
        )[0]
      ),
    ]);
    if (!marketInfo) return;
    const account = dbLib.decodeMarketFull(marketInfo.data);
    const pdas = dbLib.findMarketPdas(programId, account.id);
    const [snapshotInfo, vaultInfo, mintInfo] = await connection.getMultipleAccountsInfo(
      [snapshotPda, pdas.collateralVault, account.collateralMint],
      "confirmed"
    );
    const tp = mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    let decimals = 6;
    if (mintInfo) {
      try { decimals = unpackMint(account.collateralMint, mintInfo, tp).decimals; } catch { /* fallback 6 */ }
    }
    let vault = 0n;
    if (vaultInfo) {
      try { vault = unpackAccount(pdas.collateralVault, vaultInfo, tp).amount; } catch { /* fallback 0n */ }
    }
    const marketRow = dbLib.buildMarketRow({
      programId,
      address: marketPk,
      account,
      tokenProgram: tp,
      decimals,
      vault,
    });
    dbLib.upsertMarkets(db, [marketRow]);
    dbLib.refreshClaimableForMarket(db, marketRow);

    if (account.status === "resolved") {
      const snapshot = snapshotInfo ? dbLib.decodeMarketSnapshot(snapshotInfo.data) : null;
      const preset = dbLib.feedByState(account.ocr2State);
      const feedAddr = feedPk ? feedPk.toBase58() : preset ? preset.feed : null;
      const cluster = indexerLib ? indexerLib.inferCluster(connection.rpcEndpoint) : "devnet";
      let prePush = pair.pre.pushSignature || null;
      let postPush = pair.post.pushSignature || null;
      if ((!prePush || !postPush) && feedAddr && indexerLib?.findPushSignaturesForRuling) {
        try {
          const pushes = await indexerLib.findPushSignaturesForRuling(
            connection,
            new PublicKey(feedAddr),
            { ...pair, signature: resolveSig }
          );
          prePush = prePush || pushes.pre || null;
          postPush = postPush || pushes.post || null;
        } catch {
          // leave partial push links for background backfill
        }
      }
      const counts = dbLib.witnessCounts(snapshot, pair.pre, pair.post);
      dbLib.upsertSettlementEvidence(db, {
        market_address: marketRow.address,
        program_id: marketRow.program_id,
        feed_address: feedAddr,
        snapshot_address: snapshotPda.toBase58(),
        resolve_signature: resolveSig,
        resolve_tx_url: dbLib.explorerTxUrl(resolveSig, cluster),
        settled_price: marketRow.settled_price,
        price_decimals: marketRow.price_decimals,
        winner: marketRow.winner,
        status: marketRow.status,
        pre_epoch: pair.pre.epoch,
        pre_round: pair.pre.round,
        pre_counter: counts ? counts[0] : null,
        pre_price: pair.pre.median.toString(),
        pre_timestamp: pair.pre.observationsTimestamp,
        pre_push_signature: prePush,
        pre_push_tx_url: prePush ? dbLib.explorerTxUrl(prePush, cluster) : null,
        post_epoch: pair.post.epoch,
        post_round: pair.post.round,
        post_counter: counts ? counts[1] : null,
        post_price: pair.post.median.toString(),
        post_timestamp: pair.post.observationsTimestamp,
        post_push_signature: postPush,
        post_push_tx_url: postPush ? dbLib.explorerTxUrl(postPush, cluster) : null,
        missing_count: counts ? counts[1] - counts[0] - 1 : null,
        created_at: Math.floor(Date.now() / 1000),
      });
    }
  } catch (err) {
    console.warn(`[db] settle persist skipped for ${marketPk.toBase58()}: ${err.message}`);
  } finally {
    if (db.open) db.close();
  }
}

async function settle(opts, marketPubkey) {
  const rpcUrl = (opts.rpc || process.env.SOLANA_RPC || process.env.RPC_URL || DEFAULT_RPC).trim();
  const programId = new PublicKey((process.env.PROGRAM_ID || DEFAULT_PROGRAM_ID).trim());
  const { payer, path: walletPath } = loadKeypair(opts.keypair, opts.dryRun);
  const idl = loadIdl(programId);

  const connection = new Connection(
    rpcUrl,
    opts.feed
      ? {
          commitment: "confirmed",
          disableRetryOnRateLimit: true,
          fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(4000) }),
        }
      : {
          commitment: "confirmed",
          fetch: fetchWithTimeout(resolveNormalRpcTimeoutMs()),
        }
  );
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  console.log(`Program:  ${programId.toBase58()}`);
  console.log(`Market:   ${marketPubkey.toBase58()}`);
  if (walletPath) console.log(`Signer:   ${payer.publicKey.toBase58()} (${walletPath})`);

  const marketInfo = await connection.getAccountInfo(marketPubkey, "confirmed");
  if (!marketInfo) throw new Error(`Market account not found: ${marketPubkey.toBase58()}`);
  if (!marketInfo.owner.equals(programId)) {
    throw new Error(
      `Market owner ${marketInfo.owner.toBase58()} does not match program ${programId.toBase58()}`
    );
  }

  const market = decodeMarket(Buffer.from(marketInfo.data));
  console.log(`Title:    ${market.title || "(untitled)"}`);
  console.log(`Status:   ${market.status}`);

  if (market.status === "resolved") {
    console.log(
      `Already resolved: winner=${market.winner}, settledPrice=${formatPrice(
        market.settledPrice,
        market.priceDecimals
      )}`
    );
    return;
  }
  if (market.status === "windowBurn" || market.status === "staleBurn") {
    console.log(`Already voided (${market.status}). Tokens redeem at 0.5 collateral.`);
    return;
  }

  if (opts.feed) {
    const coord = opts.dryRun ? null : createSnapshotCoordinator(market.endTs);
    const witness = opts.dryRun ? null :
      recordExpirySnapshots(connection, program, payer, marketPubkey, market, opts.feed, coord)
        .catch(err => console.warn(`[snapshot] ${marketPubkey}: ${err.message}`));
    try {
      return await runWatch(connection, program, payer, marketPubkey, market, opts, coord);
    } finally {
      coord?.stop();
      await witness;
    }
  }
  const now = Math.floor(Date.now() / 1000);
  if (now < market.endTs) {
    const endIso = new Date(market.endTs * 1000).toISOString();
    throw new Error(`Market has not expired yet (ends at ${endIso}, ${market.endTs - now}s remaining).`);
  }

  const [snapshotPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("snapshot"), marketPubkey.toBuffer()],
    programId
  );
  const snapshotInfo = await connection.getAccountInfo(snapshotPda, "confirmed");
  const snapshot = snapshotInfo ? decodeMarketSnapshot(Buffer.from(snapshotInfo.data)) : null;

  console.log(`Scanning OCR2 state ${market.ocr2State.toBase58()} around endTs=${market.endTs}...`);
  const found = await findStraddlingReports(connection, market.ocr2State, market.endTs, snapshot);

  const deltaSec = found.post.observationsTimestamp - market.endTs;
  console.log(
    `Pre:      epoch=${found.pre.epoch} round=${found.pre.round} ts=${found.pre.observationsTimestamp} price=${formatPrice(
      found.pre.median,
      market.priceDecimals
    )}`
  );
  console.log(
    `Post:     epoch=${found.post.epoch} round=${found.post.round} ts=${found.post.observationsTimestamp} (+${deltaSec}s) price=${formatPrice(
      found.post.median,
      market.priceDecimals
    )}`
  );
  console.log(`Proof:    adjacent=${found.adjacent} snapshotCertified=${found.certified}`);

  if (opts.dryRun) {
    console.log("Dry run complete; no transaction sent.");
    return;
  }

  const lamports = await connection.getBalance(payer.publicKey, "confirmed");
  if (lamports < 10_000) {
    throw new Error(
      `Signer ${payer.publicKey.toBase58()} has insufficient SOL (${lamports} lamports) for transaction fees.`
    );
  }

  const tx = await resolveTx(program, payer, marketPubkey, market, found, found.hasSnapshot ? snapshotPda : null);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  console.log(`Settled tx: ${sig}`);

  await persistSettledMarket(connection, programId, marketPubkey, found, sig, null);

  const updatedInfo = await connection.getAccountInfo(marketPubkey, "confirmed");
  if (updatedInfo) {
    const updated = decodeMarket(Buffer.from(updatedInfo.data));
    console.log(
      `Result:   status=${updated.status}${updated.winner ? ` winner=${updated.winner}` : ""}`
    );
  }
}

if (require.main === module) main().catch((err) => {
  console.error("SETTLE_FAIL:", err && err.message ? err.message : err);
  process.exit(1);
});

module.exports = {
  parseOcr2Transmit,
  areReportsAdjacent,
  pickStraddlingPair,
  shouldRecordSnapshot,
  recordExpirySnapshots,
  createSnapshotCoordinator,
  runWatch,
  parseArgs,
  armHardTimeout,
  acquireSelfSettleSlot,
  fetchWithTimeout,
  DEFAULT_HARD_TIMEOUT_MS,
  NORMAL_RPC_TIMEOUT_MS,
  SELF_SETTLE_SLOT_PREFIX,
  DEFAULT_SELF_SETTLE_SLOTS,
};
