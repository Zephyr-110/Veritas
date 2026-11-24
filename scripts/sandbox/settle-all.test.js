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
