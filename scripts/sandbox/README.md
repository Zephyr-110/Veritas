# Veritas Devnet Sandbox Short-Market Cron Bot

Single-tick Node 22 script ([`tick.js`](./tick.js)) that maintains a rolling short-duration `BTC/USD` market on Solana Devnet so sandbox visitors can complete a full live cycle (fund → bet → live position → settlement → redeem) within minutes.

## What Each Tick Does

1. **Settle expired tracked markets**: Inspects every `open` market recorded in the JSON state file. Once expired (with a short optional grace wait near the minute boundary for the first Chainlink OCR2 print), invokes [`../settle.js`](../settle.js) via child process without duplicating settlement logic.
2. **Recycle operator funds (enabled by default)**: After a tracked market finalizes, calls `get_liquidity` to withdraw operator LP shares, calls `get_collateral` to redeem winning or voided tokens, and closes empty operator YES/NO ATAs so the 150 USDT seed, 2 USDT bet, and ~0.004 SOL ATA rent roll into subsequent rounds.
3. **Open a fresh short market if none is live**: Reads the live `BTC/USD` Chainlink Store feed (`6PxBx93S8x3tno1TsFZwT5VqP8drrRCbCXygEXYNkFJe`), sets `Target Price = opening price`, creates a market titled `"BTC/USD at or above opening price in 2 min?"` (default 150 USDT seed, 2 min duration), and persists it immediately to the state file.
4. **Place an alternating 2 USDT trade**: Submits a `user_bet_on` trade alternating `YES` and `NO` across rounds so every new market starts with real on-chain order flow.

## Prerequisites

- **Node.js 22+** (runs directly with `node`, no Next.js build output or TypeScript compilation needed)
- **Root dependencies installed**: run `npm install` at the repository root (uses `@coral-xyz/anchor`, `@solana/spl-token`, `@solana/web3.js`)
- **Required repository files**: `scripts/sandbox/tick.js`, `scripts/settle.js`, and `app/src/idl/prediction_market.json`
- **Operator Devnet keypair**: funded with Devnet SOL (for transaction fees and market account rent) and test USDT (`CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG`)

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `SOLANA_RPC` / `RPC_URL` | `https://api.devnet.solana.com` | Solana Devnet RPC endpoint |
| `WALLET_PATH` / `ANCHOR_WALLET` | `~/.config/solana/id.json` | Operator JSON keypair path |
| `PROGRAM_ID` | `CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER` | Prediction market program ID |
| `COLLATERAL_MINT` | `CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG` | Collateral token mint (6 decimals) |
| `BTC_FEED_ACCOUNT` | `6PxBx93S8x3tno1TsFZwT5VqP8drrRCbCXygEXYNkFJe` | Chainlink Store feed account |
| `BTC_OCR2_STATE` | `HCKJKQ8xFfqm5BxTA6LaUCWYXNShYXF4eAwC7NhBYXkj` | Chainlink OCR2 state account |
| `SANDBOX_STATE_PATH` | `scripts/sandbox/state.json` | Persistent JSON state file |
| `SANDBOX_DURATION_SEC` | `120` | Market duration in seconds (minimum `30`) |
| `SANDBOX_SEED_USDT` | `150` | Seed liquidity in USDT (`> 1`) |
| `SANDBOX_BET_USDT` | `2` | Opening alternating bet size in USDT |
| `SANDBOX_TITLE` | `BTC/USD at or above opening price in 2 min?` | Market title (`<= 64` UTF-8 bytes) |
| `SANDBOX_SETTLE_GRACE_SEC` | `12` | Max seconds to wait near expiry for first OCR2 print (`0` disables waiting) |
| `SANDBOX_RECYCLE_FUNDS` | `true` | Withdraw LP, redeem winnings, and close empty operator ATAs after settlement (`false` disables) |
| `SANDBOX_DAILY_MAX_MARKETS` | `0` | Max markets created per UTC day (`0` = unlimited) |
| `SANDBOX_MIN_SOL_LAMPORTS` | `30000000` | Safety floor (0.03 SOL); skips opening new markets below this balance |
| `SANDBOX_ACTIVE_FILE` | *(unset)* | Optional path to JSON `{ "lastActiveTs": <unix_sec> }` written by `/api/faucet/sandbox` |
| `SANDBOX_ACTIVE_WINDOW_SEC` | `1800` | Active window in seconds when `SANDBOX_ACTIVE_FILE` is configured |
| `SETTLE_SCRIPT_PATH` | *(auto-detected)* | Optional override for `scripts/settle.js` |
| `IDL_PATH` | *(auto-detected)* | Optional override for `prediction_market.json` |

## Self-Check (Offline)

Before enabling cron on a new machine, verify dependencies, IDL, `settle.js`, feed decoding, and instruction encoding offline:

```bash
node scripts/sandbox/tick.js --self-check
```

Expected output ends with `SANDBOX_SELF_CHECK_OK`.

## Example Crontab (Ubuntu + `flock`)

Use `flock -n` so overlapping minute ticks are safely skipped if Devnet RPC latency spikes:

```cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

* * * * * cd /opt/veritas && WALLET_PATH=/opt/veritas/keys/bot.json SOLANA_RPC=https://api.devnet.solana.com /usr/bin/flock -n /tmp/veritas-sandbox-tick.lock /usr/bin/node /opt/veritas/scripts/sandbox/tick.js >> /var/log/veritas-sandbox-tick.log 2>&1
```

If running standalone outside the full repo checkout, place `tick.js`, `settle.js`, `prediction_market.json` (in `app/src/idl/prediction_market.json` so `settle.js` locates it), and root `node_modules` under `/opt/veritas` (or set `NODE_PATH` accordingly).

## State File Schema (`state.json`)

The script persists state atomically (`.tmp` write + rename) after each step:

```json
{
  "version": 1,
  "nextBetSide": "no",
  "dailyCounts": {
    "2026-11-23": 12
  },
  "markets": [
    {
      "address": "<market_pubkey>",
      "idHex": "<32-char_hex>",
      "title": "BTC/USD at or above opening price in 2 min?",
      "expiry": 1763900115,
      "threshold": "9512345678900",
      "priceDecimals": 8,
      "status": "open",
      "winner": null,
      "createdAt": 1763900000,
      "createTx": "<tx_sig>",
      "betSide": "yes",
      "betTx": "<tx_sig>",
      "recycled": false
    }
  ]
}
```

- `status` transitions from `"open"` → `"resolved"` / `"windowBurn"` / `"staleBurn"` / `"closed"`.
- `recycled` flips to `true` once operator LP shares, redemptions, and empty ATAs have been reclaimed.
- Settled & recycled entries beyond the most recent 200 are automatically pruned.
