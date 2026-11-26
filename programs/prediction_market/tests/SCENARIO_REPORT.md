# Spec test report

Last green run (2026-11-26):

| Target | Result |
| :--- | :--- |
| `prediction_market` lib | 69 passed |
| `econ_settlement` | 31 passed |
| `spec_scenarios` | 55 passed |
| `ocr2_settle` | 34 passed |

```
cargo test -p prediction_market --lib --test spec_scenarios --test econ_settlement --test ocr2_settle -- --test-threads=1
```

- Route: LiteSVM. Clock via the `Clock` sysvar.
- Spec and econ sign OCR2 reports in `harness/chainlink.rs` against the allowlisted BTC state (`f = 1`, two test signers, captured `r_max`). That is how price and timestamp stay controllable.
- `ocr2_settle` loads captured BTC/ETH state and transmits, covers `take_snapshot` negative/permissionless boundary checks, `verify_report` edge cases (`f = 0` / `f = 2`, short/unaligned/malformed signatures, invalid recovery id), `i64` median overflow rejection, and both snapshot-`StaleBurn` coverage and realistic monotonic-clock `take_snapshot` window vs `StaleBurn` behavior.
- Program: `CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER`, local `target/deploy/prediction_market.so`.
- Expected values: README spec + `oracle/pm_amm_math.py` + `oracle/protocol_sim.py`.
- Ledger: Open markets require exact complete-set backing. Resolved markets require `vault == winner supply`. Voids require `vault >= floor(yes/2) + floor(no/2)`. Signed accounting tracks `drift = phys - (book + pending)` and `deficit = (-drift).max(0)`: `assert_ok` caps `|drift| <= min(ops + 2, 2.5)` and `deficit <= 1.5`, while walks use `assert_walk_ok` with `(11.0, 2.0)` (`p_random_walk_invariants`), `(9.0, 2.0)` (`e_walk_open_backing_then_settle_and_claim`), and `(30.0, 3.0)` (`e_warped_multi_lp_walk_full_exit_and_claim`).

See `README.md` in this directory for invariants and caps.

## Chain vs older wording

- Settlement is Chainlink OCR2, not a Pyth `PriceUpdateV2`.
- `StaleBurn` sets status and `finish_ts` only. It does not keep the late price.
- Original "Burn" is `StaleBurn` (later print > expiry + 10s) and `WindowBurn` (void after T+48h).
- `burn_account` also closes the snapshot PDA.
- After `CLAIM_WINDOW` the creator sweeps leftover vault; that is the README spec, not an untested hole.
- `add_liquidity` rounding regression: `e_repeated_skewed_add_liquidity_deficit_bricks_last_lp_exit` in `econ_settlement.rs` is now active in the regression suite (no longer `#[ignore]`) because repository code includes the `checked_ceil` fix (`bd24f67`). Note: the currently deployed Devnet program does not yet include this fix; whether to upgrade before the judging freeze is left to the author's decision.
