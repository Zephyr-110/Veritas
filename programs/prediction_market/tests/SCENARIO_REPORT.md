# Spec test report

Last green run (2026-11-16):

| Target | Result |
| :--- | :--- |
| `prediction_market` lib | 50 passed |
| `econ_settlement` | 28 passed |
| `spec_scenarios` | 51 passed |

```
cargo test -p prediction_market --lib --test spec_scenarios --test econ_settlement -- --test-threads=1
```

- Route: LiteSVM. Clock via the `Clock` sysvar. Pyth `PriceUpdateV2` is injected (price, publish_time, prev_publish_time, exponent, feed_id). Create copies `feed_id` / `exponent` from that account.
- Program: `CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER`, local `target/deploy/prediction_market.so` built with `cargo build-sbf --arch v0` (LiteSVM 0.10 rejects default sbpfv3).
- Expected values: README spec + `oracle/pm_amm_math.py` + `oracle/protocol_sim.py`.
- Ledger: Open markets require exact complete-set backing. Resolved markets require `vault == winner supply`. Voids require `vault >= floor(yes/2) + floor(no/2)`. Conservation uses `min(ops + 2, 8)` except long walks.

See `README.md` in this directory for invariants and caps.

## Chain vs older wording

- Original "Burn" is `StaleBurn` (first print > expiry + 10s) and `WindowBurn` (void after T+48h).
- Original "full exit advances checkpoint" is now close `lp_position`.
- `TokensOutstanding` / `NoResidual` are unused. After `CLAIM_WINDOW` the creator sweeps leftover vault; that is the README spec, not an untested hole.
