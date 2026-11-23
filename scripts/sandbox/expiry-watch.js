"use strict";

const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");

const WAKE_SEC = 10;
const WATCH_AFTER_SEC = 25; // Allows time for confirmed transaction history to catch up.
const MAX_SETTLE_DELAY = 10; // programs/prediction_market/src/constants.rs

// Shared by cron invocations and settle-all's settle.js. The kernel releases the
// Linux abstract socket / Windows pipe even if a worker dies during a send.
async function tryLock(name) {
  const label = "veritas-" + name;
  const endpoint = process.platform === "linux" ? "\0" + label :
    process.platform === "win32" ? "\\\\.\\pipe\\" + label : path.join(os.tmpdir(), label + ".sock");
  const server = net.createServer(socket => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once("error", e => e.code === "EADDRINUSE" ? resolve(null) : reject(e));
    server.listen(endpoint, () => resolve(() => server.close()));
  });
}

async function watchReports({ endTs, readHead, collect, pick, onPair, log }) {
  const deadline = (endTs + WATCH_AFTER_SEC) * 1000;
  let head, done = false;
  const reports = new Map();
  let lastError;
  const active = () => !done && Date.now() < deadline;
  const headLoop = async () => {
    while (active()) {
      try {
        const next = await readHead();
        if (next.counter !== head?.counter) log(`feed counter=${next.counter} report=${next.id}`);
        head = next;
      } catch (err) { lastError = err; }
      if (active()) await sleep(900);
    }
  };
  const reportLoop = async () => {
    let lastLagCounter;
    while (active()) {
      let rateLimited = false;
      try {
        for (const report of await collect()) reports.set(report.epoch + "/" + report.round, report);
      } catch (err) { lastError = err; rateLimited = /429|rate limit/i.test(err.message); }
      const pair = pick([...reports.values()]);
      if (active() && pair && pair.adjacent && pair.post.observationsTimestamp - endTs <= MAX_SETTLE_DELAY) {
        done = true; // Set before the first await in the submission path.
        log(`pair=${pair.pre.epoch}/${pair.pre.round},${pair.post.epoch}/${pair.post.round} ts=${pair.pre.observationsTimestamp},${pair.post.observationsTimestamp}`);
        return onPair(pair, deadline);
      }
      const lag = head && !reports.has(head.id);
      if (lag && head.counter !== lastLagCounter) {
        lastLagCounter = head.counter;
        log(`counter=${head.counter} awaiting report body; fast poll`);
      }
      if (active()) await sleep(rateLimited ? 1500 : lag ? 300 : 900);
    }
    log("window ended; global sweep will retry" + (lastError ? " (" + lastError.message + ")" : ""));
  };
  await Promise.all([headLoop(), reportLoop()]);
}

module.exports = { WAKE_SEC, WATCH_AFTER_SEC, tryLock, watchReports };
