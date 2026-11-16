# Veritas client

Next.js 15 UI for the on-chain program. The browser talks to Solana over RPC.
The only HTTP route is the optional Devnet faucet (`POST /api/faucet`).

Protocol rules live in the [root README](../README.md). This file is how to run the UI.

| | |
| :--- | :--- |
| Program (devnet) | [`CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER`](https://explorer.solana.com/address/CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER?cluster=devnet) |
| Collateral (devnet USDT) | [`CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG`](https://explorer.solana.com/address/CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG?cluster=devnet) |

## Run

```bash
cd app
npm install
cp .env.example .env.local   # if you do not already have one
npm run dev
```

Open http://localhost:3000

1. Phantom (or any Solana wallet): Developer Mode → network **Devnet**.
2. Header should show `devnet`. If it still says `localnet`, open Settings → Reset → Save, then restart `npm run dev`.
3. Get Devnet SOL from the official Solana faucet (transaction fees).
4. Connect the wallet and claim 100 test USDT on **Help** (once per day). The trade desk also offers the claim when the collateral balance is zero.
5. Open a live market, or create one. Creating a market makes you the LP / house, not an oracle. That wallet **can** trade. After expiry, anyone may resolve or void.

Suggested walkthrough: create a short-dated market → buy YES or NO → after expiry, anyone posts the first Pyth print to settle → redeem on the same market page. Claims stay open for 30 days after finalization; then the creator may close the market and sweep leftovers.

## Settlement (what the UI expects)

- After expiry, `resolve_market` is permissionless. The program accepts the first Pyth print with `publish_time >= end_ts`.
- Print within 10 seconds of expiry → the market resolves. Winners redeem 1:1.
- Print later than 10 seconds → `StaleBurn`. Both tokens redeem at 1/2.
- No successful resolve within 48 hours → anyone may `void_market` (`WindowBurn`). Same 1/2 redemption.
- Charts are Coinbase candles for reference only. They never settle a market.
- On Devnet, Pyth prints less often than mainnet, so a displayed price can be minutes old. The age next to a print is that print's own age.

## Localnet

Terminal 1, repo root:

```bash
solana-test-validator
```

Terminal 2:

```bash
solana config set --url http://127.0.0.1:8899
anchor deploy
```

Phantom: Developer Mode → add RPC `http://127.0.0.1:8899`. Fund two accounts:

```bash
node app/scripts/seed-local.js <walletA> <walletB>
```

The script prints a mint. Put that mint in Settings. Validator resets wipe the mint; run the script again.

CLI airdrop of the Devnet collateral mint is optional (`bash scripts/airdrop-meme.sh` from the repo root). The in-app faucet is the usual path.

## Notes

- Cannot reach the node: RPC is down, or Phantom / Settings is not on the cluster you think.
- Create fails with missing mint: Settings collateral mint is wrong.
- Create fails with insufficient balance: claim test USDT on Help, or fund the wallet.
- Transaction lands but the page does not update: wait for `confirmed`, or refresh.

Rebuild the IDL only after program instruction changes: `cd app && npm run copy-idl`.
