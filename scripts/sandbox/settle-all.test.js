const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AnchorProvider, utils } = require("@coral-xyz/anchor");
const { Keypair, PublicKey } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const { classifyOpenMarket, runMaintenance } = require("./settle-all");
const idl = require("../../app/src/idl/prediction_market.json");

test("void starts strictly after expiry plus 48 hours, even when endTs differs", () => {
  const market = { status: "open", expiry: 100, endTs: 95 };
  assert.equal(classifyOpenMarket(market, 172900, 4).kind, "ready");
  assert.equal(classifyOpenMarket(market, 172901, 4).kind, "pastWindow");
  assert.equal(classifyOpenMarket({ ...market, status: "resolved" }, 172901, 4), null);
});

test("filters by creator and status, respects both finishTs layouts and continues after a rejected void or burn", async (t) => {
  const owner = Keypair.generate();
  const programId = new PublicKey(idl.address);
  const mint = Keypair.generate().publicKey;
  const rows = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
  const now = 1800000000;
  const cutoff = now - 30 * 86400;
  const cfg = { programId, maxPerRun: 20, walletPath: path.join(os.tmpdir(), owner.publicKey.toBase58() + ".json") };
  fs.writeFileSync(cfg.walletPath, JSON.stringify([...owner.secretKey]), { flag: "wx" });
  t.after(() => fs.unlinkSync(cfg.walletPath));
  t.mock.method(Date, "now", () => now * 1000);
  const account = (i, withWinner, finish) => {
    const data = Buffer.alloc(409);
    mint.toBuffer().copy(data, 130);
    data[162] = Number(withWinner);
    data.writeBigUInt64LE(BigInt(finish), withWinner ? 229 : 228);
    return { pubkey: rows[i], account: { data } };
  };
  const connection = {
    getProgramAccounts: async (pid, { filters, dataSlice }) => {
      assert.ok(pid.equals(programId));
      assert.ok(filters.some(f => f.memcmp?.offset === 16 && f.memcmp.bytes === owner.publicKey.toBase58()));
      const status = utils.bytes.bs58.decode(filters.find(f => f.memcmp?.offset === 129).memcmp.bytes)[0];
      const records = {
        1: [account(0, true, cutoff - 1), account(1, true, cutoff)],
        2: [account(2, false, cutoff - 1), account(3, false, 0)],
        3: [account(4, false, cutoff - 1)],
      }[status];
      return records.map(({ pubkey, account }) => ({ pubkey, account: {
        data: account.data.subarray(dataSlice.offset, dataSlice.offset + dataSlice.length),
      } }));
    },
    getAccountInfo: async () => ({ owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82) }),
  };
  const calls = [];
  t.mock.method(AnchorProvider.prototype, "sendAndConfirm", async tx => {
    const ix = tx.instructions.at(-1);
    const name = idl.instructions.find(i => Buffer.from(i.discriminator).equals(ix.data)).name;
    const market = ix.keys[1].pubkey;
    assert.ok(ix.keys[0].pubkey.equals(owner.publicKey));
    if (name === "burn_account") {
      assert.equal(tx.instructions.length, 3);
      assert.ok(ix.keys[2].pubkey.equals(PublicKey.findProgramAddressSync([Buffer.from("snapshot"), market.toBuffer()], programId)[0]));
      assert.ok(ix.keys[10].pubkey.equals(TOKEN_2022_PROGRAM_ID));
    }
    calls.push([name, rows.findIndex(key => key.equals(market))]);
    if (market.equals(rows[0])) throw new Error("simulated rejection");
    return "offline";
  });
  await runMaintenance(connection, cfg, false, [rows[0], rows[1]].map(address => ({ address })));
  assert.deepEqual(calls, [["void_market", 0], ["void_market", 1], ["burn_account", 0], ["burn_account", 2], ["burn_account", 4]]);
});

test("runMaintenance degrades to chain scan without throwing when SQLite DB is corrupted or schema-drifted", async (t) => {
  const Database = require("better-sqlite3");
  const owner = Keypair.generate();
  const programId = new PublicKey(idl.address);
  const mint = Keypair.generate().publicKey;
  const market = Keypair.generate().publicKey;
  const now = 1800000000;
  const cutoff = now - 30 * 86400;
  const cfg = {
    programId,
    maxPerRun: 20,
    walletPath: path.join(os.tmpdir(), `veritas-sa-wallet-${process.pid}-${Date.now()}.json`),
  };
  const dbPath = path.join(os.tmpdir(), `veritas-sa-corrupt-${process.pid}-${Date.now()}.db`);
  const prevDbEnv = process.env.VERITAS_DB_PATH;
  fs.writeFileSync(cfg.walletPath, JSON.stringify([...owner.secretKey]), { flag: "wx" });
  process.env.VERITAS_DB_PATH = dbPath;
  t.after(() => {
    if (prevDbEnv === undefined) delete process.env.VERITAS_DB_PATH;
    else process.env.VERITAS_DB_PATH = prevDbEnv;
    for (const f of [cfg.walletPath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });
  t.mock.method(Date, "now", () => now * 1000);

  const account = () => {
    const data = Buffer.alloc(409);
    mint.toBuffer().copy(data, 130);
    data[162] = 1;
    data.writeBigUInt64LE(BigInt(cutoff - 10), 229);
    return { pubkey: market, account: { data } };
  };
  let rpcScans = 0;
  const connection = {
    getProgramAccounts: async (_pid, { filters, dataSlice }) => {
      rpcScans += 1;
      const status = utils.bytes.bs58.decode(filters.find((f) => f.memcmp?.offset === 129).memcmp.bytes)[0];
      if (status !== 1) return [];
      const row = account();
      return [{ pubkey: row.pubkey, account: { data: row.account.data.subarray(dataSlice.offset, dataSlice.offset + dataSlice.length) } }];
    },
    getAccountInfo: async () => ({ owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82) }),
  };

  const burned = [];
  t.mock.method(AnchorProvider.prototype, "sendAndConfirm", async (tx) => {
    const ix = tx.instructions.at(-1);
    burned.push(ix.keys[1].pubkey.toBase58());
    return "offline-burn";
  });

  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));

  // 1) Corrupted DB bytes
  fs.writeFileSync(dbPath, "not-a-valid-sqlite-database-file");
  await runMaintenance(connection, cfg, false, []);
  assert.equal(burned.length, 1);
  assert.equal(burned[0], market.toBase58());
  assert.equal(rpcScans, 3);
  assert.ok(warnings.some((w) => w.includes("db maintenance degraded to chain scan")));

  // 2) Schema-drifted DB (valid SQLite file missing `markets` table)
  fs.unlinkSync(dbPath);
  const drifted = new Database(dbPath);
  drifted.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
  drifted.close();
  warnings.length = 0;
  burned.length = 0;
  rpcScans = 0;
  await runMaintenance(connection, cfg, false, []);
  assert.equal(burned.length, 1);
  assert.equal(rpcScans, 3);
  assert.ok(warnings.some((w) => w.includes("db maintenance degraded to chain scan")));

  // 3) Healthy DB uses SQLite index and skips on-chain getProgramAccounts scan
  fs.unlinkSync(dbPath);
  const dbLib = require("../db");
  const healthyDb = dbLib.openDb(dbPath);
  healthyDb.prepare(`
    INSERT INTO markets (
      address, program_id, id_hex, bump, creator, title, feed_key, feed_symbol,
      ocr2_state, collateral_mint, token_program, decimals, yes_mint, no_mint,
      opened_at, expiry, end_ts, finish_ts, duration_sec, duration_bucket,
      status, winner, threshold, price_decimals, settle_above, settled_price,
      settled_publish_time, fee_bps, l_zero, last_accrual_ts, cum_yes_per_share,
      cum_no_per_share, reserve_yes, reserve_no, total_lp_shares, yes_pool,
      no_pool, vault, yes_price, no_price, updated_at
    ) VALUES (
      ?, ?, '0102030405060708090a0b0c0d0e0f10', 254, ?, 'BTC/USD test', 'btc', 'BTC/USD',
      ?, ?, ?, 6, ?, ?,
      ?, ?, ?, ?, 900, '15m',
      'resolved', 'yes', '9500000000000', 8, 1, '9600000000000',
      ?, 30, '0', 0, '0',
      '0', '0', '0', '0', '0',
      '0', '0', 1, 0, ?
    )
  `).run(
    market.toBase58(),
    programId.toBase58(),
    owner.publicKey.toBase58(),
    new PublicKey(dbLib.FEEDS[0].state).toBase58(),
    mint.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(),
    Keypair.generate().publicKey.toBase58(),
    Keypair.generate().publicKey.toBase58(),
    cutoff - 1000,
    cutoff - 100,
    cutoff - 100,
    cutoff - 10,
    cutoff - 90,
    now
  );
  healthyDb.close();
  warnings.length = 0;
  burned.length = 0;
  rpcScans = 0;
  await runMaintenance(connection, cfg, false, []);
  assert.equal(burned.length, 1);
  assert.equal(burned[0], market.toBase58());
  assert.equal(rpcScans, 0);
  assert.equal(warnings.length, 0);
});
