const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

const walletPath = process.env.WALLET_PATH;
const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";
if (!walletPath) {
  console.error("WALLET_PATH required");
  process.exit(1);
}

const secret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(rpcUrl, "confirmed");

const addrs = {
  wallet: payer.publicKey.toBase58(),
  program: "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER",
  token: "2Ztk1WhiRrFqZZktipzPEQghJFNJbA8C1LL1v3LsWCiP",
  vault: "HtRpBk4gyy13xiNW8bUGZ2H58yd5JmSopnLALNWM81r4",
  usdt: "CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG",
  buffer: "55tNCfRT74aeTU1EaupvqwNTTrW46XfdEdLdt9HRbEWh",
  oldBuffer: "8adkn3AxWpfUcPikDcxx9sgvKiec2dxXRbRMEmoPfaEU",
};

(async () => {
  console.log("rpc", rpcUrl.split("?")[0]);
  console.log("wallet_file", path.basename(walletPath));
  console.log("wallet_pubkey", addrs.wallet);
  const version = await connection.getVersion();
  console.log("version", JSON.stringify(version));
  const bal = await connection.getBalance(payer.publicKey);
  console.log("wallet_lamports", bal);
  console.log("wallet_sol", bal / 1e9);
  for (const [name, addr] of Object.entries(addrs)) {
    if (name === "wallet") continue;
    const info = await connection.getAccountInfo(new PublicKey(addr));
    if (!info) {
      console.log(name, addr, "MISSING");
      continue;
    }
    console.log(
      name,
      addr,
      "lamports",
      info.lamports,
      "owner",
      info.owner.toBase58(),
      "exec",
      info.executable,
      "len",
      info.data.length
    );
  }
  const soPath = path.join(__dirname, "..", "target", "deploy", "prediction_market.so");
  if (fs.existsSync(soPath)) {
    console.log("so_bytes", fs.statSync(soPath).size);
  }
})().catch((err) => {
  console.error("PROBE_FAIL", err && err.stack ? err.stack : err);
  process.exit(1);
});
