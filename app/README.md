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
5. Open a live market, or create one using a whitelisted Chainlink OCR2 feed (`BTC/USD`, `ETH/USD`, `SOL/USD`, `LINK/USD`, `USDC/USD`, `USDT/USD`). Creating a market makes you the LP / house, not an oracle; resolve, snapshot, and void are permissionless.

## Settlement (what the UI expects)

- Live prices on the UI read directly from Chainlink Store `Transmissions` accounts over Solana RPC, always accompanied by the print's own age.
- After expiry, `resolve_market` is permissionless. The client scans recent transactions on the market's bound `ocr2_state` account to locate the two signed Chainlink OCR2 `transmit` reports straddling `end_ts` (`pre.observations_timestamp < end_ts <= post.observations_timestamp`).
- On-chain verification checks `secp256k1` oracle signatures, the active config digest, and proves that `pre` and `post` are either adjacent OCR2 rounds (via `r_max` from `offchain_config`) or certified by a `MarketSnapshot` recorded via `take_snapshot` within ±10 seconds of `end_ts`.
- Post report within 10 seconds of expiry → the market resolves. Winners redeem 1:1.
- Post report later than 10 seconds → `StaleBurn`. Both tokens redeem at 1/2.
- No successful resolve within 48 hours → anyone may `void_market` (`WindowBurn`). Same 1/2 redemption.
- After the 30-day claim window (`finish_ts + CLAIM_WINDOW`), the creator may `burn_account` to close the market, snapshot, vault, and pools.
- Charts are Coinbase candles for reference only. They never settle a market.

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

## Notes

- Cannot reach the node: RPC is down, or Phantom / Settings is not on the cluster you think.
- Create fails with missing mint: Settings collateral mint is wrong.
- Create fails with insufficient balance: claim test USDT on Help, or fund the wallet.
- Transaction lands but the page does not update: wait for `confirmed`, or refresh.

Regenerate the client IDL from `app/scripts/gen-idl.js` (`node app/scripts/gen-idl.js`) after contract changes.
