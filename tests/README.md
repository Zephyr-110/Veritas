# Tests

The live spec net is the LiteSVM suite:

```
cargo test -p prediction_market --test spec_scenarios -- --test-threads=1
```

It loads `target/deploy/prediction_market.so` (build with `cargo build-sbf --arch v0`).

Coverage: lifecycle, Pyth settlement, conservation, fees, last-LP EmptyPool, account/status guards, and `oracle/test_vectors.json` vs on-crate math.

Conservation band is `max(ops, 1) + 2` tokens. Closed-loop still uses a tight cap of 8. B1/B2 need a Python interpreter (`PYTHON` or PATH); they compare chain state to `oracle/protocol_sim.py`.

`tests/*.spec.ts` is the old human-oracle validator suite. It does not match the current IDL (no `oracle` / `lpMint`, Pyth `resolve_market`). Every file is `describe.skip` so `anchor test` cannot be mistaken for a pass on the current program.