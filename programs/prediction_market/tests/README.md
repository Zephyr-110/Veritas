# Tests

Live net for the on-chain program. `npm test` and `anchor test` run:

```
cargo test -p prediction_market --lib --test spec_scenarios --test econ_settlement --test ocr2_settle -- --test-threads=1
```

Needs `target/deploy/prediction_market.so` built with `cargo build-sbf --arch v0`. `harness/util.rs` automatically checks `target/deploy/prediction_market.so` mtime against `programs/prediction_market/Cargo.toml` and `programs/prediction_market/src/**/*.rs` (and panics if stale; set `PM_ALLOW_STALE_SO=1` to bypass). Python (`PYTHON`, `PATH`, or standard Windows `%LOCALAPPDATA%` Python installs) is required for B1/B2 and other `protocol_sim` comparisons.

## Layout

- `harness/` — LiteSVM fixture: clock, txs, ledger, and `chainlink.rs`
- `harness/chainlink.rs` — signs OCR2 pre/post reports under the allowlisted BTC state, so spec and econ can choose price and timestamp
- `spec_scenarios.rs` — instruction scenarios, fees, feed binding, math vectors, CU
- `econ_settlement.rs` — settlement boundaries and economic-security gate
- `ocr2_settle.rs` — captured Chainlink transmits: verification, round adjacency, snapshot certification, and payout on that path
- repo-root `oracle/pm_amm_math.py` and `oracle/protocol_sim.py` — independent expected values

Spec and econ do not claim to be live Chainlink bytes. `ocr2_settle` does. Both go through `resolve_market`.

## Invariants

A green run means settlement and economic security hold against the README spec:

- Open: complete sets, `vault == yes_supply == no_supply`
- Resolved: `vault == remaining winner supply`; winners redeem 1:1; losers extract 0. `settled_price` and `settled_publish_time` are the later report.
- `StaleBurn` / `WindowBurn`: each token pays `floor(amount / 2)`; vault never drops below remaining floor liability. Neither path stores a print (`settled_price` stays 0).
- Adjacent rounds, or a snapshot-certified pair, must straddle expiry. A later print more than 10 seconds after expiry stale-voids. No resolve by T+48h window-voids.
- Through `finish_ts + CLAIM_WINDOW` (inclusive) entitled users can still be paid in full. After that the creator may sweep leftover vault and close the snapshot. Unredeemed tokens become unredeemable. That forfeiture is the spec.

## Caps

- Signed `Ledger` conservation (`drift = phys - (book + pending)`, `deficit = (-drift).max(0)`):
  - `assert_ok`: `|drift| <= min(ops + 2, 2.5)` and `deficit <= 1.5`. Share error must be under `1e-6`. Open and resolved solvency must be exact; void floor dust stays in the vault and is only checked as `vault >= floor liability`. Mint cover and vault backing stay exact.
  - `assert_walk_ok(max_surplus, max_deficit)`: separates signed pool surplus from dangerous `book + pending > phys` deficits — `p_random_walk_invariants` `(11.0, 2.0)`, `e_walk_open_backing_then_settle_and_claim` `(9.0, 2.0)`, and `e_warped_multi_lp_walk_full_exit_and_claim` `(30.0, 3.0)`.
- B1 vs Python: bet output exact, bet reserve-step <= 0.002, chain vs crate quote exact. Swaps under 1,000 tokens stay within 1 token (reserve-step <= 1.5). The tail swap (~4e5 out) may differ by at most 22 tokens and 8e-5 relative; that gap is python float versus I80F48, and the relative cap is what stops it from hiding a small-swap bug. Withdraw reserve-step <= 2.
- B2 aging <= 0.05 (measured 0.014). Near-the-money reserves in `c_swap` / partial withdraw <= 0.05. Integer payouts that matched exactly are asserted exactly; a 1-token floor difference on LP withdraw stays at 1.
- CU ceilings: create < 450k, bet < 400k, swap < 300k.

## Notes

- The old human-oracle mocha suite under `tests/*.spec.ts` is deleted.
- After `CLAIM_WINDOW`, the creator sweeps leftover vault and closes market/snapshot accounts via `burn_account` per the README spec.
- Create rejects an OCR2 state that is not in `ALLOWED_FEEDS` and Token-2022 mints. Resolve rejects a tampered report and a state account whose owner is not the OCR2 program.
- `ocr2_settle` overwrites the synthetic BTC state with captured bytes. Do not mix the two styles in one `Env` without reinstalling (`install_all_feeds`).
- `take_snapshot` vs `StaleBurn` window caveat in `ocr2_settle.rs`: `take_snapshot` requires `now < end_ts + 10`, whereas snapshot-certified `StaleBurn` requires `post.ts > end_ts + 10`. Thus `snapshot_gap_over_ten_seconds_stale_burns_and_pays_floor` rolls clock back strictly to cover the `resolve_market` snapshot-`StaleBurn` branch, while `take_snapshot_blocked_when_stale_report_lands_and_adjacent_stale_burn_works_realistically` verifies realistic monotonic-clock behavior.
- Known contract bug reproducer (`#[ignore]`): run `cargo test -p prediction_market --test econ_settlement e_repeated_skewed_add_liquidity_deficit_bricks_last_lp_exit -- --ignored --nocapture` to reproduce `book + pending > phys` deficit accumulation from floored token transfers vs un-floored `I80F48` reserve updates in `add_liquidity.rs`.
- CI runs the build (`cargo build-sbf --arch v0`) and full suite via `.github/workflows/contract-tests.yml`.
