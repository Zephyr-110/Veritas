# Veritas Sandbox Keeper & Settlement Scripts

Standalone Node 22 scripts (`tick.js`, `daily.js`, and `settle-all.js`) for running staggered 15-minute deep devnet markets, a fixed-time daily 24-hour rotating market line, and settling expired markets across the entire Veritas program without Next.js build artifacts or extra npm dependencies.

## Architecture

1. **`tick.js` (15-Minute Market Keeper + Self-Sweep Settler)**
   - Maintains 4 staggered **15-minute** (`900s`) deep devnet markets (`150 USDT` seed + `2 USDT` alternating initial trade) across `BTC/USD`, `ETH/USD`, `SOL/USD`, and `LINK/USD` at `:00`, `:04`, `:08`, and `:12` offsets (`-5s` before the minute boundary).
   - Because each asset resolves in its staggered slot, one deep 15-minute market finishes every **3–4 minutes** while preserving continuous front-page depth.
   - Execution order per tick:
     1. Batch-sync status of all tracked `open` markets (`getMultipleAccountsInfo`), detach pre-expiry `settle.js --watch <feed>` workers (~10s before `endTs`, via `expiry-watch.js`), and immediately **self-sweep** any tracked expired `open` markets via detached `settle.js` workers (targeting ~1 minute post-expiry settlement even if a watch window was missed). Inside the open ±10-second window, a watch worker also witnesses the pre-expiry feed counter and its first post-expiry successor.
     2. Open any missing staggered markets + place `2 USDT` initial bets **first** (zero gap even if settlement RPC calls stall).
     3. Reclaim LP (`get_liquidity`), redeem winning/voided shares (`get_collateral`), and close empty ATAs **last**.

2. **`daily.js` (Daily 24-Hour Rotating Line)**
   - Opens **one 24-hour** (`86400s`) market per day at a fixed UTC time (`DAILY_OPEN_HOUR_UTC:DAILY_OPEN_MINUTE_UTC`, default `00:00Z`), rotating daily across `BTC/USD -> ETH/USD -> SOL/USD -> LINK/USD` with `~150 USDT` initial LP seed (`DAILY_SEED_USDT=150`) and its own state file (`scripts/sandbox/state-daily.json`), leaving the 15-minute keeper cadence untouched.
   - Shares the same per-minute B1 self-sweep settlement (`scheduleWatches` + `scheduleExpiredSettlements`) and fund recycling.

3. **`settle-all.js` (Global Fallback Permissionless Settler)**
   - Retained as global safety net decoupled from `state*.json`: scans **all** `open` `Market` accounts owned by `PROGRAM_ID` using discriminator + status filters, skipping legacy 409-byte accounts and settling only 415-byte v2 markets—including user-created, sandbox-created, or bot markets.
   - Settles every expired market at least `SETTLE_MIN_AGE_SEC` past `endTs` and still within the inclusive 48-hour settlement window (newest-expired first) by invoking `scripts/settle.js`.
   - After settlement, voids open markets past 48 hours and reclaims operator-created terminal markets strictly more than 30 days after finalization. The creator receives remaining vault collateral and closed-account rent. Each maintenance pass handles up to `SETTLE_MAX_PER_RUN` successful transactions.
   - Supports single cron runs, `--dry-run` inspection, and `--loop` polling daemon mode.

## Server Layout

Both scripts run directly with Node 22 using the root `node_modules` (`@coral-xyz/anchor`, `@solana/spl-token`, `@solana/web3.js`) and repo files (`scripts/settle.js`, `app/src/idl/prediction_market.json`).

If copying outside a full repo checkout onto an Ubuntu VPS:

```text
/opt/veritas/
├── node_modules/              # from repo root npm ci --omit=dev
├── scripts/
│   ├── settle.js
│   └── sandbox/
│       ├── tick.js
│       ├── daily.js
│       ├── expiry-watch.js
│       ├── settle-all.js
│       ├── state.json         # auto-created by tick.js
│       └── state-daily.json   # auto-created by daily.js
└── app/src/idl/prediction_market.json
```

Verify offline in any clean directory before enabling cron:

```bash
node scripts/sandbox/tick.js --self-check
node scripts/sandbox/daily.js --self-check
node scripts/sandbox/settle-all.js --self-check
```

## Environment Variables (`tick.js`)

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC` / `RPC_URL` | `https://api.devnet.solana.com` | Solana devnet RPC URL |
| `WALLET_PATH` / `ANCHOR_WALLET` | `~/.config/solana/id.json` | Operator JSON keypair path |
| `PROGRAM_ID` | `CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER` | Veritas Anchor program ID |
| `COLLATERAL_MINT` | `CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG` | Test USDT mint (6 decimals) |
| `SANDBOX_ASSETS` | `btc,eth,sol,link` | Comma-separated staggered feeds |
| `SANDBOX_DURATION_SEC` | `900` | Market duration in seconds (`900` = 15 min) |
| `SANDBOX_SEED_USDT` | `150` | Initial LP seed liquidity in USDT per market |
| `SANDBOX_BET_USDT` | `2` | Alternating initial `YES`/`NO` trade in USDT |
| `SANDBOX_TITLE` | _(per-asset default)_ | Optional title override (single-asset mode only, `<= 64` UTF-8 bytes) |
| `SANDBOX_STATE_PATH` | `scripts/sandbox/state.json` | JSON file recording markets created by `tick.js` |
| `SANDBOX_RECYCLE_FUNDS` | `true` | Withdraw settled LP, redeem winnings, close empty ATAs |
| `SANDBOX_DAILY_MAX_MARKETS` | `0` | UTC daily creation cap (`0` = unlimited) |
| `SANDBOX_MIN_SOL_LAMPORTS` | `30000000` | Minimum SOL guard (`0.03 SOL`); when below threshold, skips creation only while still settling & recycling |
| `SANDBOX_ACTIVE_FILE` | _(empty)_ | Optional JSON `{ "lastActiveTs": <unix_sec> }` gating creation |
| `SANDBOX_ACTIVE_WINDOW_SEC` | `3600` | Activity window duration if `SANDBOX_ACTIVE_FILE` is set |
| `SETTLE_SCRIPT_PATH` | `../settle.js` | Explicit path to `scripts/settle.js` |
| `IDL_PATH` | `../../app/src/idl/prediction_market.json` | Explicit path to Anchor IDL |

Per-feed overrides (defaults match `app/src/lib/feeds.ts`):
`BTC_FEED_ACCOUNT`, `BTC_OCR2_STATE`, `ETH_FEED_ACCOUNT`, `ETH_OCR2_STATE`, `SOL_FEED_ACCOUNT`, `SOL_OCR2_STATE`, `LINK_FEED_ACCOUNT`, `LINK_OCR2_STATE`.

## Environment Variables (`settle-all.js`)

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC` / `RPC_URL` | `https://api.devnet.solana.com` | Solana devnet RPC URL |
| `WALLET_PATH` / `ANCHOR_WALLET` | `~/.config/solana/id.json` | Payer keypair for permissionless `resolve_market` |
| `PROGRAM_ID` | `CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER` | Veritas Anchor program ID |
| `SETTLE_MIN_AGE_SEC` | `4` | Seconds past `endTs` before invoking `settle.js` |
| `SETTLE_MAX_PER_RUN` | `20` | Maximum markets processed per sweep |
| `SETTLE_LOOP_INTERVAL_SEC` | `15` | Interval seconds in `--loop` mode (min `5`) |
| `SETTLE_SCRIPT_PATH` | `../settle.js` | Explicit path to `scripts/settle.js` |

## Example Cron / Systemd Setup

Run both scripts every minute with `flock` to prevent overlapping runs (replacing any old single-market keeper cron):

```cron
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin

* * * * * flock -n /tmp/veritas-sandbox-tick.lock env SOLANA_RPC=https://api.devnet.solana.com WALLET_PATH=/opt/veritas/operator.json /usr/bin/node /opt/veritas/scripts/sandbox/tick.js >> /var/log/veritas-tick.log 2>&1
* * * * * flock -n /tmp/veritas-daily-tick.lock env SOLANA_RPC=https://api.devnet.solana.com WALLET_PATH=/opt/veritas/operator.json /usr/bin/node /opt/veritas/scripts/sandbox/daily.js >> /var/log/veritas-daily.log 2>&1
* * * * * flock -n /tmp/veritas-settle-all.lock env SOLANA_RPC=https://api.devnet.solana.com WALLET_PATH=/opt/veritas/operator.json /usr/bin/node /opt/veritas/scripts/sandbox/settle-all.js >> /var/log/veritas-settle.log 2>&1
```

Or run `settle-all.js --loop` as a lightweight systemd service for 15-second settlement cadence:

```ini
[Service]
ExecStart=/usr/bin/node /opt/veritas/scripts/sandbox/settle-all.js --loop
Environment=SOLANA_RPC=https://api.devnet.solana.com
Environment=WALLET_PATH=/opt/veritas/operator.json
Restart=always
RestartSec=5
```

If you also want longer-horizon markets (e.g., 1 hour) with full LP + collateral recycling instead of legacy scripts, reuse `tick.js` with a separate `SANDBOX_STATE_PATH` and `SANDBOX_DURATION_SEC=3600` (e.g. `SANDBOX_DURATION_SEC=3600 SANDBOX_STATE_PATH=/opt/veritas/state-1h.json SANDBOX_SEED_USDT=150 node /opt/veritas/scripts/sandbox/tick.js`).
