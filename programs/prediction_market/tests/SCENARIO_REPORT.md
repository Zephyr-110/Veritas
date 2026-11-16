# prediction_market spec test report

- Route: **LiteSVM**. Clock via `Clock` sysvar; Pyth `PriceUpdateV2` injected (price / publish_time / prev_publish_time / exponent / feed_id). Create also takes a dummy PriceUpdateV2 so the market copies `feed_id`/`exponent`.
- Program: `CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER`, local `target/deploy/prediction_market.so` built with `cargo build-sbf --arch v0` (LiteSVM 0.10 rejects default sbpfv3).
- Expected values: original spec + `oracle/pm_amm_math.py` + `oracle/protocol_sim.py`. Assertions follow the **current** chain state machine (`WindowBurn` / `StaleBurn`, `winner: Option`, full LP exit closes the account).
- Conservation band: `max(ops, 1) + 2` tokens. Closed loop still uses a tight cap of 8.
- Command: `cargo test -p prediction_market --test spec_scenarios -- --test-threads=1`
- Suite: **42 passed, 0 failed** (28.77s). Python oracle via `PYTHON` / PATH / `py -3`.
- Root `tests/*.spec.ts` is the old human-oracle validator suite. Every file is `describe.skip`. It is **not** this spec net.

Backend vs original prompt wording (tests follow chain, numbers still vs Python):
- Original "Burn" split into `StaleBurn` (first print > expiry+10s) and `WindowBurn` (void after T+48h).
- Original "full exit advances checkpoint" is now **close `lp_position`**.
- `TokensOutstanding` / `NoResidual` are defined in `error.rs` but never emitted.

## A closed loop — **PASS**

Create copies feed/exponent, `winner=None`, `finish_ts=0`. Then add LP, both bets, both swaps, merge, partial + full extra-LP exit (account closed), resolve (Yes), winner 1:1 redeem.

| stage | err yes | err no | solvency | band |
|---|---|---|---|---|
| create | 0.016 | 0.016 | 0 | 3 |
| add_lp | 0.975 | 0.016 | 0 | 4 |
| bet_yes | 0.020 | 0.016 | 0 | 5 |
| bet_no | 0.020 | 0.626 | 0 | 6 |
| swap_to_yes | 0.988 | 0.626 | 0 | 7 |
| swap_to_no | 0.988 | 0.667 | 0 | 8 |
| merge | 0.988 | 0.667 | 0 | 9 |
| partial_withdraw | 1.687 | 1.223 | 0 | 10 |
| full_withdraw | 2.295 | 2.202 | 0 | 11 |
| resolve | 2.295 | 2.202 | 0 | 12 |
| redeem_winner | 2.295 | 2.202 | 0 | 13 |

Max conservation error: yes **2.295**, no **2.202**, band **13**. Share error 0. After resolve, working reserves 0 / pending holds the pool. Winner redeemed **720448** at 1:1.

## B1 deep skew vs Python — **PASS**

195 yes bets drove Python price to **0.990219**. Interleaved swap / warp / 1-share withdraw / swap.

- max |chain − python| = **21** (swap output)
- python-vs-chain cap = **32** (observed **21**)
- compared steps = 198

## B2 aging vs Python — **PASS**

Accrue at 50% / 90% / 99% of life (1-share withdraw as the touch).

| life | released_chain yes | released_py yes | pending_err |
|---|---|---|---|
| 50% | 2928932.184 | 2928932.188 | 0.0046 |
| 90% | 3908789.755 | 3908789.761 | 0.0107 |
| 99% | 2162277.224 | 2162277.228 | 0.0141 |

max_err = **0.01414**, python cap **1.0**.

## B3 second add checkpoint — **PASS**

Weighted-average checkpoint spec `(0.018708659171351, 0.019464654221207)` vs got `(0.018708659171349, 0.019464654221206)`. Pre-add pending preserved (err ~3e-8). Later bet raised pending yes **1035681.44 → 1035915.36**. Ledger err `(0.748, 0.824)` inside ops+2 band.

## C fees — **PASS**

Bet Yes, amount 200_000: in-leg extra_no **600**; out-leg ratio **0.00300385** vs 0.003; extras_sum **1191.459** = in+out fee. cum_no = 600/shares, cum_yes = out-fee/shares.

Swap to NO, amount 20_000: extra_yes **60**; out-leg ratio **0.0030465** vs 0.003 (cap 5e-5). Out-leg amount vs `paid * 0.003/0.997` err **0.95** (cap 1). No `extra <= band` escape hatch. Conservation band 4 / 5.

## D seed threshold — **PASS**

- 1_000_000 → `InvalidAmount`
- 1_000_001 accepted. phys yes=no=**1000001**. book−phys |err| = **0.001571**, band **3**. `winner=None`, feed/exponent copied from the create Pyth account.

## E withdraw — **PASS**

- request 0 → `ZeroLp`
- partial 25%: checkpoints unchanged; payout yes **499998** / no **499999**, err 0, inside ops+2 band
- request remainder+7: `lp_position` **closed** (including fractional tail). Checkpoints are not observable after close.
- full payout yes **1500000** / no **1500000**, err 0, inside ops+2 band
- ledger after extra-LP full exit: phys leftover 1 per side vs house book, err ≤ 1.02, inside ops+2 band

### Last LP drain / EmptyPool — **PASS**

Extra LP full exit, then house (last remaining) full exit: `lp_position` closed, `total_lp_shares=0`, working reserves 0/0, phys leftover **1** per side. Subsequent `add_liquidity` / `bet` / `swap` fail `EmptyPool`.

## F settlement

### F1 four directions + exactly +10s + equal threshold — **PASS**

`settle_above=true` above/equal → `Some(Yes)`; below → `Some(No)`. `settle_above=false` inverted. Delay=10 still `Resolved`. `finish_ts` stamped.

### F2 second print — **PASS**

- `prev_publish_time = expiry+1` → `NotFirstAfterExpiry`. Status `Open`, `winner=None`, `finish_ts=0`, settled fields 0.
- `prev_publish_time == expiry` (spec ≥ expiry) → same rejection, still `Open`.

### F3 late first print — **PASS**

- First print at expiry+15 → `StaleBurn`, `winner=None`, `settled_price`/`settled_publish_time` written from that print, `finish_ts=expiry+20`.
- First print at expiry+11 (just over 10s) → `StaleBurn`, settled_price=105, settled_publish_time=1700003611.

### F4 void window + final accrue — **PASS**

- expiry+100 void → `MarketNotInWindow`
- expiry+172801 void → `WindowBurn`, settled fields stay 0, working 0/0
- house full withdraw got yes **9999999**, no **10000000** = floor(pending); LP account closed. leftover phys yes **1**, band **3**

### F5 resolve after +48h — **PASS**

expiry+172810 → `MarketNotInWindow`, status `Open`.

### F6 resolve before expiry — **PASS**

→ `MarketNotExpired`, status `Open`.

### Window endpoint — **PASS**

Exactly T+48h: resolve succeeds; void rejected. T+48h+1: void → `WindowBurn`.

### Mismatched feed — **PASS**

Resolve with a different `feed_id` → Pyth `MismatchedFeedId` (16002). Status stayed `Open`.

### Exponent mismatch — **PASS**

Wrong exponent, matching times/feed → `ExponentMismatch`. Status `Open`, `winner=None`, `finish_ts`/`settled_*` stay 0.

## G redeem / merge — **PASS**

- Resolved: merge `MarketNotTradable`; loser `NotWinnerMint`; winner 1:1.
- Expired still Open: merge 3 pairs, ledger err `(0.994, 0.922)`, inside ops+2 band. Bet/swap/add at expiry → `MarketExpired`; merge still works, status stays `Open`, err `(0.238, 0.458)`, inside ops+2 band.
- After `WindowBurn`: merge rejected; redeem 1 yes/no rejected; redeem 3 yes → 1; redeem 3 no → 1. After both: vault **10119995**, supply **10119994/10119994**, solvency_err **1**, inside ops+2 band.
- After `StaleBurn`: same 0.5 both sides. After both 3→1: vault **10119998**, supply **10119997/10119997**, solvency_err **1**, inside ops+2 band.

## H accrual boundary — **PASS**

Touch at expiry: working 0/0, cum 1.0/1.0. Touch at expiry+30: cumulants bit-identical.

Resolve-path: working 0; withdraw 100 shares paid **99** = floor(pending * 100 / shares), err 0, inside ops+2 band.

## I burn_account — **PASS** (with observed hole)

- Open → `MarketIsOpen`; non-creator → `NoCreator`; at `finish_ts + CLAIM_WINDOW` exactly → `NoArriveFinishTS`.
- After Resolved + `finish_ts + 30d + 1`: creator receives remaining vault **10050000**, market/vault/pools closed. Trader still holds winner tokens **99543**. Later redeem fails `InstructionError(2, Custom(3012))` (account gone). Outstanding user tokens are not checked on-chain (`TokensOutstanding` unused).
- After WindowBurn + claim window: creator sweeps vault **10020000** while trader still holds yes **39854**. Market/vault closed.

This is current-chain behavior, not a cargo failure. The unused `TokensOutstanding` error is the hole: unredeemed tokens are not blocked before the vault is swept.


## J guards — **PASS**

Permissionless resolve/void, create expiry gates, zero amounts, slippage, insufficient balances, foreign mint / wrong ATA / wrong vault, status conflicts (including void constraint order: window before status), Partial Pyth verification, wrong-owner Pyth account, stranger cannot withdraw house LP, StaleBurn LP full exit then claim-window sweep with outstanding tokens still in the trader wallet.

Closed-loop conservation stays inside **8 tokens**. Ledger band is now **ops+2** (create band 3, not ~600). B1 python-vs-chain cap **32** (observed ~21). B2 cap **1.0** (observed ~0.014). Fee out-leg has no band escape hatch (amount cap 1 token, ratio cap 5e-5).

## K math vectors vs `oracle/test_vectors.json` — **PASS**

Loads the Python-generated JSON at runtime (not copied constants). `phi` / `Phi` / `Phi_inv`, reserves at P=0.5 and P=0.3, `suggest_l_zero(1e6, 1d)=8527.722566`. `l_effective(T=0)` and `budget=0` error.
