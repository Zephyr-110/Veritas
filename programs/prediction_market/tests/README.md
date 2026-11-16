# Tests

Live net for the on-chain program. `npm test` and `anchor test` run:

```
cargo test -p prediction_market --lib --test spec_scenarios --test econ_settlement -- --test-threads=1
```

Needs `target/deploy/prediction_market.so` built with `cargo build-sbf --arch v0`. Python (`PYTHON` or PATH) is required for B1/B2 and other `protocol_sim` comparisons.

## Layout

- `harness/` — LiteSVM fixture: clock, Pyth accounts, txs, ledger
- `spec_scenarios.rs` — instruction scenarios, fees, Pyth identity, math vectors, CU
- `econ_settlement.rs` — settlement boundaries and economic-security gate
- repo-root `oracle/pm_amm_math.py` and `oracle/protocol_sim.py` — independent expected values

## Invariants

A green run means settlement and economic security hold against the README spec:

- Open: complete sets, `vault == yes_supply == no_supply`
- Resolved: `vault == remaining winner supply`; winners redeem 1:1; losers extract 0
- `StaleBurn` / `WindowBurn`: each token pays `floor(amount / 2)`; vault never drops below remaining floor liability
- First Pyth print after expiry settles; print later than 10s stale-voids; no print by T+48h window-voids
- Through `finish_ts + CLAIM_WINDOW` (inclusive) entitled users can still be paid in full. After that the creator may sweep leftover vault; unredeemed tokens become unredeemable. That forfeiture is the spec.

## Caps

- Conservation: `min(ops + 2, 8)` tokens (`assert_ok`). Long walks allow 16 of book-vs-pool dust; mint cover and vault backing stay exact.
- B1 vs Python, deep skew at P~0.99: bet <= 1, swap <= 24, withdraw <= 8. Chain vs crate quote cap is 1; the 24-token Python gap is oracle float, not a chain bug.
- CU ceilings: create < 450k, bet < 400k, swap < 300k.

## Notes

- The old human-oracle mocha suite under `tests/*.spec.ts` is deleted.
- `TokensOutstanding` and `NoResidual` are defined in `error.rs` but never emitted.
- These tests inject `PriceUpdateV2` accounts. They do not run the live Pyth receiver.
