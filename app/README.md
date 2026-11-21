# Veritas Client

Next.js 15 frontend for the Veritas on-chain prediction market. All market reads and transactions go directly from the browser to Solana RPC — there is no backend indexer or matching server.

Protocol mechanics and on-chain constants are documented in the [root README](../README.md).

| Config | Default (Devnet) |
| :--- | :--- |
| **Program ID** | [`CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER`](https://explorer.solana.com/address/CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER?cluster=devnet) |
| **Collateral Mint (USDT)** | [`CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG`](https://explorer.solana.com/address/CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG?cluster=devnet) |
| **Default Cluster / RPC** | `devnet` · `https://api.devnet.solana.com` |

---

## Features & Architecture

- **Direct Chainlink Store Reads**: Live oracle prices are read and subscribed directly from Chainlink Store `Transmissions` accounts over Solana RPC, displaying per-print freshness via `PriceAge`.
- **Automated OCR2 Settlement Discovery**: When settling an expired market, `resolve.ts` performs a two-pass scan (`±120s` tight window, then `[-900s, +3600s]` wide fallback) over `ocr2_state` signatures to find straddling `transmit` payloads, automatically checking round adjacency (`r_max`) or `MarketSnapshot` certification.
- **Full Lifecycle Desks**:
  - `TradeDesk` — Buy YES/NO (`user_bet_on`), outcome swap (`swap`), live pm-AMM quotes, slippage protection, and shallow-pool price impact warnings.
  - `LpDesk` — Add/withdraw liquidity (`add_liquidity` / `get_liquidity`), pending accrued token estimates, and post-expiry LP exit.
  - `SettleDesk` — Complete-set merging (`merge_token`), `±10s` expiry snapshot capture (`take_snapshot`), permissionless settlement (`resolve_market`), 48h timeout voiding (`void_market`), even-sized void refunds (`get_collateral`), and 30-day creator cleanup (`burn_account`).
- **Zero-Shift Bilingual UI (`EN` / `中文`)**: `StableText` overlays the active and reserve translations in a `1×1` CSS Grid cell so switching languages never shifts surrounding layout or numerals.
- **Optional Faucet & Reference Charts**:
  - `POST /api/faucet` distributes 100 test USDT per wallet every 24h when `FAUCET_KEYPAIR_PATH` is configured.
  - `/chart/*` proxies Coinbase Exchange candles (`next.config.js` rewrite) for visual reference only — settlement always uses signed Chainlink OCR2 reports.

### Directory Layout

```text
app/src/
├── app/                   # Next.js App Router pages (/, /markets, /markets/[address], /create, /me, /help, /api/faucet)
├── components/            # TradeDesk, LpDesk, SettleDesk, MarketCard, MarketTable, PriceTape, UI primitives
├── hooks/                 # React Query & RPC hooks (useMarkets, useMarket, useFeeds, useProgram, useNow)
├── i18n/                  # Bilingual store, parity assertions, and LocaleProvider
├── idl/                   # Generated Anchor IDL (prediction_market.json & .ts)
├── lib/                   # Borsh codecs, PDA derivations, pm-AMM quoting, Chainlink OCR2 & report discovery
├── locales/               # en.json & zh.json dictionaries
└── test/                  # Vitest jsdom + crypto/Buffer setup
```

---

## Getting Started

```bash
cd app
npm install
cp .env.example .env.local   # optional; override NEXT_PUBLIC_* or faucet settings
npm run dev
```

Open [http://localhost:3000](http://localhost:3000):

1. Switch your Solana wallet (e.g. Phantom) to **Devnet**.
2. Confirm the header cluster shows `devnet` (if switching from another cluster, open **Settings → Reset → Save** and reload).
3. Request Devnet SOL for fees from the Solana faucet, then claim 100 test USDT on the **Help** page (or directly from the Trade desk when balance is zero).
4. Trade an active market, provide LP, or open a new market on any of the 6 whitelisted Chainlink feeds (`BTC/USD`, `ETH/USD`, `SOL/USD`, `LINK/USD`, `USDC/USD`, `USDT/USD`).

---

## Testing & Quality Gates

The frontend uses **Vitest** + **React Testing Library** + **v8 coverage**, enforced in CI via [`.github/workflows/frontend-tests.yml`](../.github/workflows/frontend-tests.yml).

```bash
npm run typecheck          # TypeScript check (tsc --noEmit)
npm test                   # Run all Vitest suites
npm run test:coverage      # Run all suites with v8 coverage report & threshold checks
npm run test:watch         # Watch mode for local development
```

### Coverage Overview (18 Suites · 242 Tests)

| Area | What Is Verified |
| :--- | :--- |
| **Chainlink OCR2 Goldens** | Real captured devnet `State`, `Transmissions`, and `transmit` payloads (`chainlink.test.ts`), two-pass straddling report discovery, `r_max` epoch rollover, and `MarketSnapshot` certification (`resolve.test.ts`). |
| **Codecs & Fixed-Point Math** | Borsh account decoders (`Market`, `LpPosition`, `MarketSnapshot`), variable-length `Option<MarketOutcome>` layout shift trap, and 5,000-sample `I80F48` rational precision checks (`codec.test.ts`). |
| **Instructions & PDAs** | PDA determinism (`pdas.test.ts`), all 11 instruction builders including Token-2022 ATA derivation and `hasSnapshot` handling (`instructions.test.ts`), and RPC account aggregation (`markets.test.ts`). |
| **Domain Helpers & i18n** | pm-AMM quoting & slippage (`quote.test.ts`), 36 Anchor error mappings (`errors.test.ts`), time-window boundary flips (`markets.test.ts`), display formatting (`display.test.ts`, `format.test.ts`, `feeds.test.ts`), candle windows (`chart.test.ts`), and EN/ZH key parity (`store.test.ts`). |
| **UI & Desk Components** | `TradeDesk`, `LpDesk`, `SettleDesk`, `MarketCard`, and core `ui` primitives (`*.test.tsx`). |

Minimum coverage thresholds configured in [`vitest.config.ts`](vitest.config.ts): **52% statements · 55% branches · 54% functions · 53% lines**.

---

## Localnet Development

Run a local validator in Terminal 1 (from repo root):

```bash
solana-test-validator
```

Deploy and seed collateral in Terminal 2:

```bash
solana config set --url http://127.0.0.1:8899
anchor deploy
node app/scripts/seed-local.js <walletA> <walletB>
```

Add `http://127.0.0.1:8899` as a custom RPC in Phantom and paste the printed collateral mint into **Settings** in the app.

### Updating the IDL

After modifying the Anchor program, regenerate the client IDL before testing or building:

```bash
node app/scripts/gen-idl.js
```

---

## Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| RPC unreachable | Confirm cluster/RPC in **Settings** matches your wallet network. |
| Create fails with `Mint not found` | Set the correct Collateral Mint address in **Settings** (or Reset to Devnet defaults). |
| Insufficient collateral on Devnet | Claim 100 test USDT on **Help**, or verify your wallet has Devnet SOL for fees. |
| UI does not reflect a confirmed tx | Wait a few seconds for `confirmed` commitment or click **Refresh**. |
