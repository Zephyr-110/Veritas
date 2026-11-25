#!/usr/bin/env node
"use strict";

const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Keypair } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const dbLib = require("./db");

function cleanupDb(filePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = filePath + suffix;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore transient file lock
      }
    }
  }
}

function seedSyntheticDb(dbPath, marketCount) {
  cleanupDb(dbPath);
  const db = dbLib.openDb(dbPath);
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const creator = Keypair.generate().publicKey.toBase58();
    const collateralMint = Keypair.generate().publicKey.toBase58();
    const wallet = Keypair.generate().publicKey.toBase58();
    const specs = [
      { sec: 120, bucket: "2m", title: "BTC/USD at or above opening price in 2 min?" },
      { sec: 900, bucket: "15m", title: "ETH/USD at or above opening price in 15 min?" },
      { sec: 86_400, bucket: "24h", title: "SOL/USD at or above opening price in 24 hours?" },
    ];

    const insertMarket = db.prepare(`
      INSERT INTO markets (
        address, program_id, id_hex, bump, creator, title, feed_key, feed_symbol,
        ocr2_state, collateral_mint, token_program, decimals, yes_mint, no_mint,
        opened_at, expiry, end_ts, finish_ts, duration_sec, duration_bucket,
        status, winner, threshold, price_decimals, settle_above, settled_price,
        settled_publish_time, fee_bps, l_zero, last_accrual_ts, cum_yes_per_share,
        cum_no_per_share, reserve_yes, reserve_no, total_lp_shares, yes_pool,
        no_pool, vault, yes_price, no_price, updated_at
      ) VALUES (
        @address, @program_id, @id_hex, 254, @creator, @title, @feed_key, @feed_symbol,
        @ocr2_state, @collateral_mint, @token_program, 6, @yes_mint, @no_mint,
        @opened_at, @expiry, @expiry, @finish_ts, @duration_sec, @duration_bucket,
        @status, @winner, '9500000000000', 8, 1, @settled_price,
        @settled_publish_time, 30, '0', 0, '0',
        '0', '150000000', '150000000', '150000000', '150000000',
        '150000000', '152000000', 0.52, 0.48, @updated_at
      )
    `);
    const insertEv = db.prepare(`
      INSERT INTO settlement_evidence (
        market_address, program_id, feed_address, snapshot_address,
        resolve_signature, resolve_tx_url, settled_price, price_decimals,
        winner, status, pre_epoch, pre_round, pre_counter, pre_price,
        pre_timestamp, pre_push_signature, pre_push_tx_url,
        post_epoch, post_round, post_counter, post_price,
        post_timestamp, post_push_signature, post_push_tx_url,
        missing_count, created_at
      ) VALUES (
        @market_address, @program_id, @feed_address, @snapshot_address,
        @resolve_signature, @resolve_tx_url, '9600000000000', 8,
        'yes', 'resolved', 100, 1, 10, '9490000000000',
        @pre_ts, @pre_sig, @pre_url,
        100, 2, 11, '9600000000000',
        @post_ts, @post_sig, @post_url,
        0, @created_at
      )
    `);
    const insertPos = db.prepare(`
      INSERT INTO wallet_positions (
        wallet, market_address, program_id, yes_amount, no_amount, lp_shares,
        pending_yes, pending_no, claimable_amount, can_claim, collateral_amount, updated_at
      ) VALUES (?, ?, ?, '2000000', '0', '0', '0', '0', '2000000', 1, '25000000', ?)
    `);

    const seedTx = db.transaction(() => {
      for (let i = 0; i < marketCount; i += 1) {
        const addr = Keypair.generate().publicKey.toBase58();
        const isLive = i < 20;
        const spec = specs[i % specs.length];
        const feed = dbLib.FEEDS[i % 4];
        const expiry = isLive ? nowSec + (i + 1) * 60 : nowSec - (i + 1) * 60;
        insertMarket.run({
          address: addr,
          program_id: dbLib.DEFAULT_PROGRAM_ID,
          id_hex: i.toString(16).padStart(32, "0"),
          creator,
          title: spec.title,
          feed_key: feed.key,
          feed_symbol: feed.symbol,
          ocr2_state: feed.state,
          collateral_mint: collateralMint,
          token_program: TOKEN_PROGRAM_ID.toBase58(),
          yes_mint: Keypair.generate().publicKey.toBase58(),
          no_mint: Keypair.generate().publicKey.toBase58(),
          opened_at: expiry - spec.sec,
          expiry,
          finish_ts: isLive ? 0 : expiry + 3,
          duration_sec: spec.sec,
          duration_bucket: spec.bucket,
          status: isLive ? "open" : "resolved",
          winner: isLive ? null : "yes",
          settled_price: isLive ? "0" : "9600000000000",
          settled_publish_time: isLive ? 0 : expiry + 1,
          updated_at: nowSec,
        });
        if (!isLive) {
          insertEv.run({
            market_address: addr,
            program_id: dbLib.DEFAULT_PROGRAM_ID,
            feed_address: feed.feed,
            snapshot_address: Keypair.generate().publicKey.toBase58(),
            resolve_signature: `resolve-${i}`,
            resolve_tx_url: `https://solscan.io/tx/resolve-${i}?cluster=devnet`,
            pre_ts: expiry - 2,
            pre_sig: `pre-${i}`,
            pre_url: `https://solscan.io/tx/pre-${i}?cluster=devnet`,
            post_ts: expiry + 1,
            post_sig: `post-${i}`,
            post_url: `https://solscan.io/tx/post-${i}?cluster=devnet`,
            created_at: nowSec,
          });
          if (i < 45) {
            insertPos.run(wallet, addr, dbLib.DEFAULT_PROGRAM_ID, nowSec);
          }
        }
      }
      db.prepare(
        "INSERT INTO wallet_sync_state (wallet, program_id, synced_at) VALUES (?, ?, ?)"
      ).run(wallet, dbLib.DEFAULT_PROGRAM_ID, nowSec);
    });
    seedTx();

    const planLive = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM markets WHERE program_id = ? AND status = 'open' AND expiry > ? ORDER BY expiry ASC LIMIT 20 OFFSET 0"
      )
      .all(dbLib.DEFAULT_PROGRAM_ID, nowSec)
      .map((r) => r.detail)
      .join(" | ");
    const planEnded = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM markets WHERE program_id = ? AND (status != 'open' OR expiry <= ?) ORDER BY expiry DESC LIMIT 30 OFFSET 0"
      )
      .all(dbLib.DEFAULT_PROGRAM_ID, nowSec)
      .map((r) => r.detail)
      .join(" | ");
    return { wallet, planLive, planEnded };
  } finally {
    if (db.open) db.close();
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function getProcessRssBytes(pid) {
  if (process.platform === "linux") {
    const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
    return Number(statm[1]) * 4096;
  }
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
      { encoding: "utf8" }
    ).trim();
    return Number(out);
  }
  const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
  return Number(out) * 1024;
}

function toMb(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

async function waitForServer(baseUrl, child, getLogs, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "none";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Next.js exited early (code=${child.exitCode}): ${getLogs()}`
      );
    }
    try {
      const res = await fetch(`${baseUrl}/api/markets?section=live&page=1&pageSize=1`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}: ${await res.text()}`;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `Next.js server did not become ready in time (lastError=${lastError}): ${getLogs()}`
  );
}

async function measurePageTraffic(baseUrl, pid, label, steps, iterations = 30) {
  // Warmup 3 iterations so first-hit compilation isn't counted as row scaling
  for (let w = 0; w < 3; w += 1) {
    for (const step of steps) {
      const res = await fetch(`${baseUrl}${step.path}`);
      if (!res.ok) throw new Error(`${label} warmup ${step.path} returned ${res.status}`);
      await res.arrayBuffer();
    }
  }

  const rssBefore = getProcessRssBytes(pid);
  let maxSingleDelta = 0;
  let prevRss = rssBefore;
  const returnedCounts = new Set();

  for (let i = 0; i < iterations; i += 1) {
    for (const step of steps) {
      const res = await fetch(`${baseUrl}${step.path}`);
      if (!res.ok) throw new Error(`${label} ${step.path} returned ${res.status}`);
      if (step.expectCount != null) {
        const json = await res.json();
        returnedCounts.add(`${step.tag}:${json.items.length}`);
        if (json.items.length !== step.expectCount) {
          throw new Error(
            `${label} ${step.path} expected ${step.expectCount} rows, got ${json.items.length}`
          );
        }
      } else {
        await res.arrayBuffer();
      }
    }
    if ((i + 1) % 5 === 0) {
      const curr = getProcessRssBytes(pid);
      maxSingleDelta = Math.max(maxSingleDelta, (curr - prevRss) / 5);
      prevRss = curr;
    }
  }

  const rssAfter = getProcessRssBytes(pid);
  return {
    page: label,
    iterations,
    rssBeforeMB: toMb(rssBefore),
    rssAfterMB: toMb(rssAfter),
    totalDeltaMB: toMb(rssAfter - rssBefore),
    avgPerRequestDeltaMB: toMb((rssAfter - rssBefore) / iterations),
    maxPerRequestDeltaMB: toMb(maxSingleDelta),
    returnedCounts: [...returnedCounts],
  };
}

async function benchmarkDataset(marketCount) {
  const dbPath = path.join(os.tmpdir(), `veritas-bench-${marketCount}-${process.pid}.db`);
  const { wallet, planLive, planEnded } = seedSyntheticDb(dbPath, marketCount);
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const appDir = path.resolve(__dirname, "..", "app");
  const nextBin = path.join(appDir, "node_modules", "next", "dist", "bin", "next");

  const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: appDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      VERITAS_DB_PATH: dbPath,
      VERITAS_DISABLE_ON_DEMAND_SYNC: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  try {
    await waitForServer(baseUrl, child, () => `stdout=${stdout.trim()} stderr=${stderr.trim()}`);
    const idleRssBytes = getProcessRssBytes(child.pid);

    const pages = [];
    pages.push(
      await measurePageTraffic(baseUrl, child.pid, "home", [
        { tag: "html", path: "/" },
        { tag: "live", path: `/api/markets?programId=${dbLib.DEFAULT_PROGRAM_ID}&section=live&duration=all&page=1&pageSize=20`, expectCount: 20 },
        { tag: "ended6", path: `/api/markets?programId=${dbLib.DEFAULT_PROGRAM_ID}&section=ended&duration=all&page=1&pageSize=6`, expectCount: 6 },
      ])
    );
    pages.push(
      await measurePageTraffic(baseUrl, child.pid, "markets", [
        { tag: "html", path: "/markets" },
        { tag: "live", path: `/api/markets?programId=${dbLib.DEFAULT_PROGRAM_ID}&section=live&duration=all&page=1&pageSize=20`, expectCount: 20 },
      ])
    );
    pages.push(
      await measurePageTraffic(baseUrl, child.pid, "history", [
        { tag: "html", path: "/markets" },
        { tag: "ended30", path: `/api/markets?programId=${dbLib.DEFAULT_PROGRAM_ID}&section=ended&duration=all&page=1&pageSize=30`, expectCount: 30 },
      ])
    );
    pages.push(
      await measurePageTraffic(baseUrl, child.pid, "me", [
        { tag: "html", path: "/me" },
        { tag: "pos30", path: `/api/positions?wallet=${wallet}&programId=${dbLib.DEFAULT_PROGRAM_ID}&page=1&pageSize=30`, expectCount: 25 },
      ])
    );

    // Concurrent loaded burst across all pages
    const burstUrls = [
      "/",
      "/markets",
      "/me",
      `/api/markets?programId=${dbLib.DEFAULT_PROGRAM_ID}&section=live&page=1&pageSize=20`,
      `/api/markets?programId=${dbLib.DEFAULT_PROGRAM_ID}&section=ended&page=1&pageSize=30`,
      `/api/positions?wallet=${wallet}&programId=${dbLib.DEFAULT_PROGRAM_ID}&page=1&pageSize=30`,
    ];
    await Promise.all(
      Array.from({ length: 24 }, (_, idx) =>
        fetch(`${baseUrl}${burstUrls[idx % burstUrls.length]}`).then((r) => r.arrayBuffer())
      )
    );
    const loadedRssBytes = getProcessRssBytes(child.pid);

    return {
      marketCount,
      dbSizeMB: toMb(fs.statSync(dbPath).size),
      planLive,
      planEnded,
      idleRssMB: toMb(idleRssBytes),
      loadedRssMB: toMb(loadedRssBytes),
      pages,
      stderr: stderr.trim() || null,
    };
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    cleanupDb(dbPath);
  }
}

async function main() {
  const small = await benchmarkDataset(500);
  const large = await benchmarkDataset(5500);
  console.log(JSON.stringify({ small, large }, null, 2));
}

main().catch((err) => {
  console.error("[bench] failed:", err?.stack || err);
  process.exit(1);
});
