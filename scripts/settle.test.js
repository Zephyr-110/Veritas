"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Keypair } = require("@solana/web3.js");
const {
  armHardTimeout,
  SELF_SETTLE_SLOT_PREFIX,
  DEFAULT_SELF_SETTLE_SLOTS,
} = require("./settle");
const { tryLock } = require("./sandbox/expiry-watch");
const {
  MAX_SIGNATURE_PAGES,
  fetchRulingForMarket,
  findPushSignaturesForRuling,
} = require("./index-markets");

const SETTLE_PATH = path.resolve(__dirname, "settle.js");

function releaseLock(rel) {
  if (typeof rel !== "function") return Promise.resolve();
  const ret = rel();
  if (ret && typeof ret.once === "function") {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
      ret.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return Promise.resolve();
}

test("armHardTimeout skips --watch mode, fires in normal mode, and supports disarm", async () => {
  let watchFired = false;
  const watchLogs = [];
  const disarmWatch = armHardTimeout({
    isWatch: true,
    timeoutMs: 20,
    log: (m) => watchLogs.push(m),
    onTimeout: () => {
      watchFired = true;
    },
  });
  await new Promise((r) => setTimeout(r, 70));
  disarmWatch();
  assert.equal(watchFired, false);
  assert.equal(watchLogs.length, 0);

  let disarmedFired = false;
  const disarmEarly = armHardTimeout({
    isWatch: false,
    timeoutMs: 40,
    log: () => {},
    onTimeout: () => {
      disarmedFired = true;
    },
  });
  disarmEarly();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(disarmedFired, false);

  let normalFired = 0;
  const normalLogs = [];
  armHardTimeout({
    isWatch: false,
    timeoutMs: 25,
    log: (m) => normalLogs.push(m),
    onTimeout: () => {
      normalFired += 1;
    },
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(normalFired, 1);
  assert.ok(normalLogs.some((m) => m.includes("hard timeout exceeded")));
});

test("ordinary settle.js exits non-zero with timeout marker when hard timeout is exceeded", async (t) => {
  const preloadPath = path.join(os.tmpdir(), `veritas-hang-fetch-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(
    preloadPath,
    `globalThis.fetch = () => new Promise(() => {});\n`,
    "utf8"
  );
  t.after(() => {
    if (fs.existsSync(preloadPath)) fs.unlinkSync(preloadPath);
  });

  const marketPk = Keypair.generate().publicKey.toBase58();
  const startedAt = Date.now();
  const res = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-r", preloadPath, SETTLE_PATH, marketPk, "--dry-run", "--rpc", "http://127.0.0.1:8899"],
      {
        env: {
          ...process.env,
          SETTLE_HARD_TIMEOUT_MS: "250",
          SETTLE_RPC_TIMEOUT_MS: "10000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
  });

  assert.notEqual(res.code, 0);
  assert.ok(res.elapsedMs < 5000, `expected quick exit, took ${res.elapsedMs}ms`);
  assert.match(res.stderr + res.stdout, /hard timeout exceeded/);
});

test("settle.js --self-settle exits cleanly without hitting RPC when all slots are held", async (t) => {
  const held = [];
  t.after(async () => {
    for (const rel of held) await releaseLock(rel);
  });
  for (let i = 0; i < DEFAULT_SELF_SETTLE_SLOTS; i += 1) {
    const rel = await tryLock(`${SELF_SETTLE_SLOT_PREFIX}${i}`);
    assert.ok(rel, `expected to acquire ${SELF_SETTLE_SLOT_PREFIX}${i}`);
    held.push(rel);
  }

  const marketPk = Keypair.generate().publicKey.toBase58();
  const res = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SETTLE_PATH, marketPk, "--self-settle", "--rpc", "http://127.0.0.1:1"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /self-settle slots busy/);
});

test("index-markets caps signature pagination at MAX_SIGNATURE_PAGES (20)", async () => {
  assert.equal(MAX_SIGNATURE_PAGES, 20);
  const marketPk = Keypair.generate().publicKey.toBase58();
  const ocr2Pk = Keypair.generate().publicKey.toBase58();
  const feedPk = Keypair.generate().publicKey;
  const finishTs = 1_800_000_000;

  let rulingPages = 0;
  const rulingConn = {
    getSignaturesForAddress: async () => {
      rulingPages += 1;
      return Array.from({ length: 100 }, (_, i) => ({
        signature: `r-${rulingPages}-${i}`,
        err: null,
        blockTime: finishTs + 100,
      }));
    },
  };
  const ruling = await fetchRulingForMarket(rulingConn, Keypair.generate().publicKey, {
    address: marketPk,
    ocr2_state: ocr2Pk,
    finish_ts: finishTs,
    end_ts: finishTs - 5,
    settled_publish_time: finishTs - 2,
    settled_price: "9500000000000",
  });
  assert.equal(ruling, null);
  assert.equal(rulingPages, MAX_SIGNATURE_PAGES);

  let pushPages = 0;
  const pushConn = {
    getSignaturesForAddress: async () => {
      pushPages += 1;
      return Array.from({ length: 250 }, (_, i) => ({
        signature: `p-${pushPages}-${i}`,
        err: null,
        blockTime: finishTs + 200,
      }));
    },
  };
  const pushes = await findPushSignaturesForRuling(pushConn, feedPk, {
    signature: "resolve-sig",
    pre: { observationsTimestamp: finishTs - 10, configDigest: Buffer.alloc(32) },
    post: { observationsTimestamp: finishTs - 2, configDigest: Buffer.alloc(32) },
  });
  assert.deepEqual(pushes, {});
  assert.equal(pushPages, MAX_SIGNATURE_PAGES);
});
