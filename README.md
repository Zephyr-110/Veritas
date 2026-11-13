# Veritas Markets

A non-custodial binary prediction market on Solana. Prices come from a
[pm-AMM](https://www.paradigm.xyz/2024/11/pm-amms) curve, settlement comes
from [Pyth](https://pyth.network/), and every complete YES/NO set is backed
1:1 by collateral in the market vault.

The on-chain program lives in `programs/prediction_market`. The client lives
in `app/` and talks to the program directly — no off-chain matching engine.

| | |
| :--- | :--- |
| Program (devnet) | [`CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER`](https://explorer.solana.com/address/CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER?cluster=devnet) |
| Collateral (devnet USDT) | [`CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG`](https://explorer.solana.com/address/CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG?cluster=devnet) |
| Stack | Anchor 1.2, Solana, Pyth Receiver, Next.js 15 |

---

## How a market works

Each market is a YES/NO question with a Pyth feed, a threshold, a direction
(`settle_above`), and an expiry.

**Complete sets.** Depositing 1 unit of collateral mints 1 YES and 1 NO.
Burning 1 YES and 1 NO returns 1 collateral. The vault always holds exactly
as many units as there are complete sets in circulation.

**Pricing.** The pool is a pm-AMM (Moallemi & Robinson), not a constant
product. Effective liquidity is \(L_{\text{eff}} = L_0 \sqrt{T - t}\). As
expiry approaches, depth shrinks and released tokens accrue to LPs. Spot
YES price is recovered from the two reserves and \(L_{\text{eff}}\). Swaps
pay a 30 bps fee that stays in the pool.

**Settlement.** After expiry, anyone may submit the first Pyth print whose
`publish_time` is at or after `end_ts` and whose previous print is before
it.

- Print within 10 seconds of expiry → the market resolves. YES wins if the
  print is on the configured side of the threshold (`>=` when
  `settle_above`, otherwise `<`). Winners redeem 1:1.
- Print later than 10 seconds → `StaleBurn`. Both tokens redeem at 1/2.
- No successful resolve within 48 hours → anyone may `void_market`
  (`WindowBurn`). Same 1/2 redemption.

**Claim window.** Traders and LPs have 30 days after the market leaves
`Open` to redeem or withdraw. After that the creator may `burn_account`:
leftover vault collateral goes to the house, remaining pool tokens are
burned, and the market / vault / pool accounts close. The two mint accounts
are left as empty shells.

```
create_market
     │
     ▼
   Open  ── bet / swap / add or remove liquidity / merge
     │
     │  expiry
     ▼
  48h window ── resolve_market ──► Resolved          (winner 1:1)
     │                         └─► StaleBurn         (late print, 1/2)
     │
     └── void_market ────────────► WindowBurn        (timeout, 1/2)
                                        │
                                        │  30-day claim window
                                        ▼
                                   burn_account      (creator only)
```

---

## Instructions

| Instruction | Who | What |
| :--- | :--- | :--- |
| `create_market` | Creator | Open a market, bind `feed_id` / `exponent` from a Pyth `PriceUpdateV2`, seed the pool. |
| `user_bet_on` | Anyone | Deposit collateral, mint a pair, swap the unwanted side. |
| `swap` | Anyone | Trade YES ↔ NO against the pool. |
| `add_liquidity` | Anyone | Deposit a complete set, receive LP shares. |
| `get_liquidity` | LP | Withdraw a share of pool + accrued tokens. A full exit closes the `LpPosition` PDA. |
| `merge_token` | Anyone | Burn 1 YES + 1 NO for 1 collateral while the market is open. |
| `resolve_market` | Anyone | First Pyth print after expiry. Resolves or stale-voids. |
| `void_market` | Anyone | After the 48h window, if still `Open`. |
| `get_collateral` | Anyone | Redeem: 1 winner token → 1 collateral; voided market → 2 tokens → 1 collateral. |
| `burn_account` | Creator | After the 30-day claim window: sweep leftover collateral, burn pool remnants, close PDAs. |

Resolve and void are permissionless. `burn_account` is creator-only because
the leftover collateral and account rent go to the house.

---

## On-chain constants

| Name | Value | Meaning |
| :--- | :--- | :--- |
| `SERVICE_FEE` | 30 | Swap fee in bps. |
| `RESOLVE_WINDOW` | 172,800 s | 48 hours after expiry to resolve. |
| `MAX_SETTLE_DELAY` | 10 s | First print later than this voids as `StaleBurn`. |
| `CLAIM_WINDOW` | 2,592,000 s | 30 days after `finish_ts` before the house can close. |

`finish_ts` is the clock time when the market leaves `Open` (resolve or
void). The claim deadline is `finish_ts + CLAIM_WINDOW`.

Minimum seed collateral is 1,000,001 base units.

---

## Program layout

```
programs/prediction_market/src/
  lib.rs                 program entrypoints
  constants.rs           fees and windows
  entity.rs              Market, LpPosition
  state.rs               MarketStatus, MarketOutcome
  error.rs               error codes
  instructions/          one file per instruction
  math/                  pm-AMM + LP accrual (I80F48)
```

PDAs (seeds):

- `["market", market_id]`
- `["yes_mint" | "no_mint" | "yes_pool" | "no_pool" | "collateral_vault", market]`
- `["lp_position", market, owner]`

---

## Build

Rust 1.89, Solana CLI, and Anchor 1.2 are required.

```bash
anchor build
```

Unit tests for the math crate:

```bash
cargo test --manifest-path programs/prediction_market/Cargo.toml --lib
```

Deploy (devnet example):

```bash
anchor deploy --provider.cluster devnet
```

The program id is declared in `programs/prediction_market/src/lib.rs` and
`Anchor.toml`.

---

## Client

```bash
cd app
npm install
cp .env.example .env.local   # if present
npm run dev
```

Point Phantom (or another Solana wallet) at **devnet**. You need devnet SOL
and the collateral mint above.

The client IDL under `app/src/idl/` is copied from an `anchor build`. After
program changes, regenerate it before expecting the UI to match.

---

## Status

The on-chain program is the source of truth. Frontend copy, the committed
IDL, and the integration tests may lag a program change. Instruction-level
lifecycle tests are still being written.