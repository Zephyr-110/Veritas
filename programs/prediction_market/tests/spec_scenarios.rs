//! Spec tests for CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER.
//! Route: LiteSVM. Clock via the Clock sysvar. Settlement is Chainlink OCR2:
//! harness/chainlink.rs signs the pre/post pair under the allowlisted BTC state.
//! Captured Chainlink bytes live in ocr2_settle. Expected values come from the
//! README spec and oracle/pm_amm_math.py plus oracle/protocol_sim.py.
//! Conservation uses band = max(ops, 1) + 2 tokens (not pool thickness).
mod harness;

use fixed::types::I80F48;
use harness::*;
use prediction_market::math::pm_math::{
    capital_phi_fixed, capital_phi_inv_fixed, phi_fixed, pool_value,
};
use prediction_market::math::{
    apply_accrual, compute_accrual, compute_swap_output, l_effective, price_from_reserves,
    reserves_from_price, suggest_l_zero_for_budget, SwapSide,
};
use prediction_market::state::{MarketOutcome, MarketStatus};
use serde_json::json;

const START: i64 = 1_700_000_000;
const DAY: i64 = 86_400;
const LIFE: i64 = 7 * DAY;
const SEED: u64 = 10_000_000;
const FEE_CAP: f64 = 1.0;
const FEE_RATIO_CAP: f64 = 6e-5;

fn queue_first(env: &mut Env, keys: &MarketKeys, price: i64, delay: i64) {
    env.queue_ocr2_reports(price, keys.expiry as i64 + delay, keys.expiry as i64 - 1);
}

fn assert_working_zero(env: &Env, keys: &MarketKeys, label: &str) {
    let m = env.read_market(keys);
    let y = bits_f64(m.reserve_yes);
    let n = bits_f64(m.reserve_no);
    println!("{label} working reserves yes={y} no={n}");
    assert!(y.abs() <= 1.0, "{label} working yes {y} not released");
    assert!(n.abs() <= 1.0, "{label} working no {n} not released");
}

fn reserve_step_delta(
    prev: &mut (Option<f64>, Option<f64>, Option<f64>, Option<f64>),
    cx: f64,
    cy: f64,
    px: f64,
    py: f64,
) -> f64 {
    let d = match *prev {
        (Some(pcx), Some(pcy), Some(ppx), Some(ppy)) => ((cx - pcx) - (px - ppx))
            .abs()
            .max(((cy - pcy) - (py - ppy)).abs()),
        _ => (cx - px).abs().max((cy - py).abs()),
    };
    *prev = (Some(cx), Some(cy), Some(px), Some(py));
    d
}

/// Wiring helper for the program's own min_out gate.
/// Independent output lives in B1 / c_swap_output_vs_python; j_min_out also
/// cross-checks the first crate quote against protocol_sim (exact).
fn quote_swap_out(env: &Env, keys: &MarketKeys, amount_in: u64, want: MarketOutcome) -> u64 {
    let mut market = env.read_market(keys);
    let accrual = compute_accrual(&market, env.clock).unwrap();
    apply_accrual(&mut market, &accrual);
    let fee = I80F48::from_num(market.current_fee_bps(env.clock).unwrap());
    let den = I80F48::from_num(10_000);
    let amt = I80F48::from_num(amount_in);
    let in_fee = amt.checked_mul(fee).unwrap().checked_div(den).unwrap();
    let net_in = amt.checked_sub(in_fee).unwrap();
    let l_eff = l_effective(market.l_zero_fixed(), market.end_ts - env.clock).unwrap();
    let (side_in, side_out) = if want == MarketOutcome::Yes {
        (SwapSide::No, SwapSide::Yes)
    } else {
        (SwapSide::Yes, SwapSide::No)
    };
    let result = compute_swap_output(
        market.reserve_yes_fixed(),
        market.reserve_no_fixed(),
        l_eff,
        net_in,
        side_in,
        side_out,
    )
    .unwrap();
    let out_fee = result
        .output
        .checked_mul(fee)
        .unwrap()
        .checked_div(den)
        .unwrap();
    result.output.checked_sub(out_fee).unwrap().to_num::<u64>()
}

fn assert_merge_one_to_one(
    env: &Env,
    keys: &MarketKeys,
    user: &Actor,
    amount: u64,
    before_coll: u64,
    before_yes: u64,
    before_no: u64,
) {
    let after_coll = env.token_amount(ata(user.pk(), env.mint));
    let after_yes = env.token_amount(ata(user.pk(), keys.yes_mint));
    let after_no = env.token_amount(ata(user.pk(), keys.no_mint));
    assert_eq!(
        after_coll - before_coll,
        amount,
        "merge must return collateral 1:1"
    );
    assert_eq!(before_yes - after_yes, amount, "merge must burn yes 1:1");
    assert_eq!(before_no - after_no, amount, "merge must burn no 1:1");
}

#[test]
fn a_closed_loop() {
    // conservation must stay inside 8 tokens, not just the wide ledger band
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    println!("create cu={}", env.last_cu);
    assert!(
        env.last_cu < 450_000,
        "create CU {} exceeds 450k ceiling",
        env.last_cu
    );
    let created = env.read_market(&keys);
    assert_eq!(
        created.ocr2_state,
        prediction_market::ALLOWED_FEEDS[0].state
    );
    assert_eq!(created.decimals, 8);
    assert_eq!(created.winner, None);
    assert_eq!(created.finish_ts, 0);
    assert_eq!(created.status, MarketStatus::Open);
    assert_eq!(created.start_ts, START, "create must persist start_ts");
    assert_eq!(
        created.current_fee_bps(START).unwrap(),
        prediction_market::SERVICE_FEE,
        "opening fee must equal SERVICE_FEE"
    );
    env.ledger(&keys, "create").assert_tight(2.5);

    let lp = env.fund_user(3_000_000);
    env.add_liquidity(&keys, &lp, 3_000_000);
    env.ledger(&keys, "add_lp").assert_tight(2.5);

    let trader = env.fund_user(2_000_000);
    env.bet(&keys, &trader, 400_000, MarketOutcome::Yes);
    println!("bet cu={}", env.last_cu);
    assert!(
        env.last_cu < 400_000,
        "bet CU {} exceeds 400k ceiling",
        env.last_cu
    );
    env.ledger(&keys, "bet_yes").assert_tight(2.5);
    env.bet(&keys, &trader, 300_000, MarketOutcome::No);
    env.ledger(&keys, "bet_no").assert_tight(2.5);

    let yes_bal = env.token_amount(ata(trader.pk(), keys.yes_mint));
    let no_bal = env.token_amount(ata(trader.pk(), keys.no_mint));
    let swap_yes = (yes_bal / 10).max(1);
    let swap_no = (no_bal / 10).max(1);
    env.swap(&keys, &trader, swap_no, MarketOutcome::Yes);
    println!("swap cu={}", env.last_cu);
    assert!(
        env.last_cu < 300_000,
        "swap CU {} exceeds 300k ceiling",
        env.last_cu
    );
    env.ledger(&keys, "swap_to_yes").assert_tight(2.5);
    env.swap(&keys, &trader, swap_yes, MarketOutcome::No);
    env.ledger(&keys, "swap_to_no").assert_tight(2.5);

    let yes_bal = env.token_amount(ata(trader.pk(), keys.yes_mint));
    let no_bal = env.token_amount(ata(trader.pk(), keys.no_mint));
    let merge_amt = yes_bal.min(no_bal).min(50_000).max(1);
    let coll_before = env.token_amount(ata(trader.pk(), env.mint));
    env.merge(&keys, &trader, merge_amt);
    assert_merge_one_to_one(
        &env,
        &keys,
        &trader,
        merge_amt,
        coll_before,
        yes_bal,
        no_bal,
    );
    env.ledger(&keys, "merge").assert_tight(2.5);

    let pos = env.read_lp(&keys, lp.pk()).unwrap();
    let shares = bits_f64(pos.shares);
    let part = (shares * 0.3).max(1.0) as u64;
    env.withdraw(&keys, &lp, part);
    env.ledger(&keys, "partial_withdraw").assert_walk_ok(4.5, 1.5);
    env.withdraw(&keys, &lp, u64::MAX);
    env.ledger(&keys, "full_withdraw").assert_walk_ok(4.5, 1.5);

    env.warp(keys.expiry as i64);
    env.queue_ocr2_reports(
        keys.threshold + 1,
        keys.expiry as i64 + 2,
        keys.expiry as i64 - 5,
    );
    env.resolve(&keys);
    let resolved = env.read_market(&keys);
    assert_eq!(resolved.status, MarketStatus::Resolved);
    assert_eq!(resolved.winner, Some(MarketOutcome::Yes));
    env.ledger(&keys, "resolve").assert_walk_ok(4.5, 1.5);

    let yes_left = env.token_amount(ata(trader.pk(), keys.yes_mint));
    println!("A winner yes_left={yes_left}");
    assert!(
        yes_left > 0,
        "closed loop must leave winner tokens to redeem"
    );
    env.redeem(&keys, &trader, keys.yes_mint, yes_left);
    env.ledger(&keys, "redeem_winner").assert_walk_ok(4.5, 1.5);
}

#[test]
fn d_seed_threshold() {
    let mut env = Env::new(START);
    let (_keys, res) = env.create_market_raw(1_000_000, LIFE, true);
    assert_logs_contain(res, "InvalidAmount");

    let mut env = Env::new(START);
    let keys = env.create_market(1_000_001, LIFE, true);
    let m = env.read_market(&keys);
    let book_yes = bits_f64(m.reserve_yes);
    let book_no = bits_f64(m.reserve_no);
    let phys_yes = env.token_amount(keys.yes_pool) as f64;
    let phys_no = env.token_amount(keys.no_pool) as f64;
    let l = env.ledger(&keys, "seed_1_000_001");
    l.assert_ok();
    println!(
        "D seed: book=({book_yes},{book_no}) phys=({phys_yes},{phys_no}) err_yes={} err_no={}",
        (book_yes - phys_yes).abs(),
        (book_no - phys_no).abs()
    );
    assert!(
        (book_yes - phys_yes).abs() <= l.band,
        "book yes != seed phys"
    );
    assert!((book_no - phys_no).abs() <= l.band, "book no != seed phys");
    assert_eq!(phys_yes, 1_000_001.0);
    assert_eq!(phys_no, 1_000_001.0);
    assert_eq!(m.ocr2_state, prediction_market::ALLOWED_FEEDS[0].state);
    assert_eq!(m.decimals, 8);
    assert_eq!(m.winner, None);
}

#[test]
fn c_fees_bet_and_swap() {
    // Bet Yes: sell NO in, take YES out.
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let before = env.ledger(&keys, "c_bet_before");
    let trader = env.fund_user(500_000);
    let amount = 200_000u64;
    env.bet(&keys, &trader, amount, MarketOutcome::Yes);
    let after = env.ledger(&keys, "c_bet_after");
    after.assert_ok();
    let m = env.read_market(&keys);
    let in_fee = amount as f64 * FEE_BPS / FEE_DEN;
    let extra_no = after.phys_no - after.book_no;
    let extra_yes = after.phys_yes - after.book_yes;
    let extra_no_delta = extra_no - (before.phys_no - before.book_no);
    let extra_yes_delta = extra_yes - (before.phys_yes - before.book_yes);
    let paid = env.token_amount(ata(trader.pk(), keys.yes_mint)) as f64 - amount as f64;
    let gross = paid + extra_yes_delta;
    let out_fee_ratio = if gross > 0.0 {
        extra_yes_delta / gross
    } else {
        0.0
    };
    println!(
        "C bet: in_fee_spec={in_fee} extra_no_delta={extra_no_delta} extra_yes_delta={extra_yes_delta} paid={paid} out_fee_ratio={out_fee_ratio} cum_yes={} cum_no={}",
        bits_f64(m.cum_yes_per_share), bits_f64(m.cum_no_per_share)
    );
    assert!(
        (extra_no_delta - in_fee).abs() <= FEE_CAP,
        "in-leg fee should sit in sold-in token (NO)"
    );
    assert!(
        (out_fee_ratio - FEE_BPS / FEE_DEN).abs() <= FEE_RATIO_CAP,
        "out-leg fee ratio={out_fee_ratio}"
    );
    let expect_out = paid * (FEE_BPS / FEE_DEN) / (1.0 - FEE_BPS / FEE_DEN);
    assert_close(
        extra_yes_delta,
        expect_out,
        FEE_CAP,
        "C bet out-leg fee amount",
    );
    let shares = bits_f64(m.total_lp_shares);
    let per_in = in_fee / shares;
    let per_out = extra_yes_delta / shares;
    assert_close(
        bits_f64(m.cum_no_per_share),
        per_in,
        (FEE_CAP / shares).max(1e-12),
        "C bet cum_no in-leg",
    );
    assert_close(
        bits_f64(m.cum_yes_per_share),
        per_out,
        (FEE_CAP / shares).max(1e-12),
        "C bet cum_yes out-leg",
    );

    // Swap: user wants NO, sells YES in.
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let trader = env.fund_user(500_000);
    env.bet(&keys, &trader, 200_000, MarketOutcome::Yes);
    let before = env.ledger(&keys, "c_swap_before");
    let m_before = env.read_market(&keys);
    let sell = 20_000u64;
    env.swap(&keys, &trader, sell, MarketOutcome::No);
    let after = env.ledger(&keys, "c_swap_after");
    after.assert_ok();
    let extra_yes_delta = (after.phys_yes - after.book_yes) - (before.phys_yes - before.book_yes);
    let extra_no_delta = (after.phys_no - after.book_no) - (before.phys_no - before.book_no);
    let in_fee = sell as f64 * FEE_BPS / FEE_DEN;
    let paid_no = env.token_amount(ata(trader.pk(), keys.no_mint)) as f64;
    let gross_out = paid_no + extra_no_delta;
    let out_fee_ratio = if gross_out > 0.0 {
        extra_no_delta / gross_out
    } else {
        0.0
    };
    println!(
        "C swap: extra_yes_delta={extra_yes_delta} extra_no_delta={extra_no_delta} in_fee={in_fee} paid_no={paid_no} out_fee_ratio={out_fee_ratio}"
    );
    assert!(
        (extra_yes_delta - in_fee).abs() <= FEE_CAP,
        "swap in-leg fee on YES"
    );
    assert!(
        (out_fee_ratio - FEE_BPS / FEE_DEN).abs() <= FEE_RATIO_CAP,
        "swap out-leg fee ratio={out_fee_ratio}"
    );
    let expect_out = paid_no * (FEE_BPS / FEE_DEN) / (1.0 - FEE_BPS / FEE_DEN);
    assert_close(
        extra_no_delta,
        expect_out,
        FEE_CAP,
        "C swap out-leg fee amount",
    );
    let m = env.read_market(&keys);
    let shares = bits_f64(m.total_lp_shares);
    let per_in = in_fee / shares;
    let per_out = extra_no_delta / shares;
    assert_close(
        bits_f64(m.cum_yes_per_share) - bits_f64(m_before.cum_yes_per_share),
        per_in,
        (FEE_CAP / shares).max(1e-12),
        "C swap cum_yes in-leg",
    );
    assert_close(
        bits_f64(m.cum_no_per_share) - bits_f64(m_before.cum_no_per_share),
        per_out,
        (FEE_CAP / shares).max(1e-12),
        "C swap cum_no out-leg",
    );
}

#[test]
fn c_swap_output_vs_python() {
    let req = json!({
        "seed": SEED,
        "duration": LIFE,
        "start_ts": START,
        "ops": [
            {"op": "create"},
            {"op": "bet", "wallet": "trader", "amount": 50_000, "side": "yes"},
            {"op": "swap", "wallet": "trader", "amount": 5_000, "side": "no"}
        ]
    });
    let sim = python_sim(&req);
    let st = &sim["steps"][2];
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 50_000, MarketOutcome::Yes);
    let no_before = env.token_amount(ata(trader.pk(), keys.no_mint));
    env.swap(&keys, &trader, 5_000, MarketOutcome::No);
    let out = (env.token_amount(ata(trader.pk(), keys.no_mint)) - no_before) as f64;
    let m = env.read_market(&keys);
    env.ledger(&keys, "c_swap_output").assert_ok();
    assert_close(out, f64_of(&st["output"]), 0.0, "c_swap output vs python");
    assert_close(
        bits_f64(m.reserve_yes),
        f64_of(&st["reserve_yes"]),
        0.05,
        "c_swap reserve_yes vs python",
    );
    assert_close(
        bits_f64(m.reserve_no),
        f64_of(&st["reserve_no"]),
        0.05,
        "c_swap reserve_no vs python",
    );
}

#[test]
fn e_withdraw_rules() {
    let part = 500_000u64;
    let req = json!({
        "seed": SEED,
        "duration": LIFE,
        "start_ts": START,
        "ops": [
            {"op": "create"},
            {"op": "add_liquidity", "wallet": "lp", "amount": 2_000_000},
            {"op": "withdraw", "wallet": "lp", "shares": part},
            {"op": "withdraw", "wallet": "lp", "shares": 1_000_000_000u64}
        ]
    });
    let sim = python_sim(&req);
    let part_st = &sim["steps"][2];
    let full_st = &sim["steps"][3];

    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let lp = env.fund_user(2_000_000);
    env.add_liquidity(&keys, &lp, 2_000_000);
    let pos0 = env.read_lp(&keys, lp.pk()).unwrap();
    let cp_yes0 = pos0.checkpoint_yes;
    let cp_no0 = pos0.checkpoint_no;
    assert!(
        bits_f64(pos0.shares) > part as f64,
        "need extra LP shares above partial exit"
    );

    assert_logs_contain(env.withdraw_raw(&keys, &lp, 0), "ZeroLp");

    let yes_before = env.token_amount(ata(lp.pk(), keys.yes_mint));
    let no_before = env.token_amount(ata(lp.pk(), keys.no_mint));
    env.withdraw(&keys, &lp, part);
    let pos1 = env.read_lp(&keys, lp.pk()).unwrap();
    assert_eq!(
        pos1.checkpoint_yes, cp_yes0,
        "partial exit must not move checkpoint"
    );
    assert_eq!(
        pos1.checkpoint_no, cp_no0,
        "partial exit must not move checkpoint"
    );
    let yes_got = env.token_amount(ata(lp.pk(), keys.yes_mint)) - yes_before;
    let no_got = env.token_amount(ata(lp.pk(), keys.no_mint)) - no_before;
    let m = env.read_market(&keys);
    env.ledger(&keys, "e_partial").assert_ok();
    assert_close(
        yes_got as f64,
        f64_of(&part_st["pay_yes"]),
        1.0,
        "e_partial yes vs python",
    );
    assert_close(
        no_got as f64,
        f64_of(&part_st["pay_no"]),
        1.0,
        "e_partial no vs python",
    );
    assert_close(
        bits_f64(m.reserve_yes),
        f64_of(&part_st["reserve_yes"]),
        0.05,
        "e_partial reserve_yes vs python",
    );
    assert_close(
        bits_f64(m.reserve_no),
        f64_of(&part_st["reserve_no"]),
        0.05,
        "e_partial reserve_no vs python",
    );

    let yes_before = env.token_amount(ata(lp.pk(), keys.yes_mint));
    let no_before = env.token_amount(ata(lp.pk(), keys.no_mint));
    env.withdraw(&keys, &lp, u64::MAX);
    assert!(
        env.read_lp(&keys, lp.pk()).is_none(),
        "full exit closes lp_position including fractional tail"
    );
    let yes_got = env.token_amount(ata(lp.pk(), keys.yes_mint)) - yes_before;
    let no_got = env.token_amount(ata(lp.pk(), keys.no_mint)) - no_before;
    env.ledger(&keys, "e_full").assert_ok();
    assert_close(
        yes_got as f64,
        f64_of(&full_st["pay_yes"]),
        1.0,
        "e_full yes vs python",
    );
    assert_close(
        no_got as f64,
        f64_of(&full_st["pay_no"]),
        1.0,
        "e_full no vs python",
    );
}

fn resolve_case(
    settle_above: bool,
    price_delta: i64,
    delay: i64,
) -> (MarketStatus, Option<MarketOutcome>, i64, i64) {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, settle_above);
    env.warp(keys.expiry as i64 + delay.max(1));
    let price = keys.threshold + price_delta;
    queue_first(&mut env, &keys, price, delay);
    env.resolve(&keys);
    let m = env.read_market(&keys);
    println!(
        "F resolve settle_above={settle_above} price_delta={price_delta} delay={delay} status={:?} winner={:?} settled_price={} settled_publish_time={} finish_ts={}",
        m.status, m.winner, m.settled_price, m.settled_publish_time, m.finish_ts
    );
    assert!(m.finish_ts > 0, "resolve/void path must stamp finish_ts");
    (m.status, m.winner, m.settled_price, m.settled_publish_time)
}

#[test]
fn f1_settle_above_true_price_above_yes() {
    let (status, winner, _, _) = resolve_case(true, 5, 3);
    assert_eq!(status, MarketStatus::Resolved);
    assert_eq!(winner, Some(MarketOutcome::Yes));
}

#[test]
fn f1_settle_above_true_price_below_no() {
    let (status, winner, _, _) = resolve_case(true, -5, 3);
    assert_eq!(status, MarketStatus::Resolved);
    assert_eq!(winner, Some(MarketOutcome::No));
}

#[test]
fn f1_settle_above_false_price_above_no() {
    let (status, winner, _, _) = resolve_case(false, 5, 3);
    assert_eq!(status, MarketStatus::Resolved);
    assert_eq!(winner, Some(MarketOutcome::No));
}

#[test]
fn f1_settle_above_false_price_below_yes() {
    let (status, winner, _, _) = resolve_case(false, -5, 3);
    assert_eq!(status, MarketStatus::Resolved);
    assert_eq!(winner, Some(MarketOutcome::Yes));
}

#[test]
fn f1_first_print_at_exactly_10s_still_settles() {
    let (status, winner, _, _) = resolve_case(true, 5, MAX_SETTLE_DELAY);
    assert_eq!(status, MarketStatus::Resolved);
    assert_eq!(winner, Some(MarketOutcome::Yes));
}

#[test]
fn f2_second_print_rejected_stays_open() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + 8);
    env.queue_ocr2_reports(
        keys.threshold + 1,
        keys.expiry as i64 + 8,
        keys.expiry as i64 + 1,
    );
    let res = env.resolve_raw(&keys);
    assert_logs_contain(res, "NotFirstAfterExpiry");
    let m = env.read_market(&keys);
    assert_eq!(
        m.status,
        MarketStatus::Open,
        "F2 must leave market Open, not voided"
    );
    assert_eq!(m.winner, None);
    assert_eq!(m.finish_ts, 0);
    assert_eq!(m.settled_price, 0);
    assert_eq!(m.settled_publish_time, 0);
}

#[test]
fn f3_late_first_print_stale_burns_without_price() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + 20);
    let late_price = keys.threshold + 9;
    let late_time = keys.expiry as i64 + 15;
    env.queue_ocr2_reports(late_price, late_time, keys.expiry as i64 - 1);
    env.resolve(&keys);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::StaleBurn);
    assert_eq!(m.winner, None);
    assert_eq!(
        m.settled_price, 0,
        "StaleBurn does not store the late print"
    );
    assert_eq!(
        m.settled_publish_time, 0,
        "StaleBurn does not store the late print"
    );
    assert_eq!(m.finish_ts, keys.expiry + 20);
}

#[test]
fn f4_void_window_and_final_accrual() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + 100);
    let res = env.void_raw(&keys);
    assert_logs_contain(res, "MarketNotInWindow");
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    env.void_market(&keys);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::WindowBurn);
    assert_eq!(m.winner, None);
    assert_eq!(m.settled_price, 0);
    assert_eq!(m.settled_publish_time, 0);
    assert_eq!(m.finish_ts, keys.expiry + RESOLVE_WINDOW + 1);
    assert_working_zero(&env, &keys, "F4 after void");
    let house = env.house_actor();
    let pos = env.read_lp(&keys, house.pk()).unwrap();
    let shares = bits_f64(pos.shares);
    let pending_yes =
        (bits_f64(m.cum_yes_per_share) - bits_f64(pos.checkpoint_yes)).max(0.0) * shares;
    let pending_no = (bits_f64(m.cum_no_per_share) - bits_f64(pos.checkpoint_no)).max(0.0) * shares;
    println!(
        "F4 pending before withdraw yes={pending_yes} no={pending_no} working=({:.6},{:.6})",
        bits_f64(m.reserve_yes),
        bits_f64(m.reserve_no)
    );
    assert!(bits_f64(m.reserve_yes).abs() <= 1.0 && bits_f64(m.reserve_no).abs() <= 1.0);
    let yes_before = env.token_amount(ata(house.pk(), keys.yes_mint));
    let no_before = env.token_amount(ata(house.pk(), keys.no_mint));
    env.withdraw(&keys, &house, u64::MAX);
    let yes_got = env.token_amount(ata(house.pk(), keys.yes_mint)) - yes_before;
    let no_got = env.token_amount(ata(house.pk(), keys.no_mint)) - no_before;
    let l = env.ledger(&keys, "f4_withdraw");
    l.assert_ok();
    println!("F4 withdraw got yes={yes_got} no={no_got}");
    assert_close(
        yes_got as f64,
        pending_yes.floor(),
        l.band.max(1.0),
        "F4 withdraw is pending yes, not working",
    );
    assert_close(
        no_got as f64,
        pending_no.floor(),
        l.band.max(1.0),
        "F4 withdraw is pending no, not working",
    );
    assert!(
        env.read_lp(&keys, house.pk()).is_none(),
        "F4 full house exit closes lp_position"
    );
}

#[test]
fn f5_resolve_after_48h_rejected() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 10);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    let res = env.resolve_raw(&keys);
    assert_logs_contain(res, "MarketNotInWindow");
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Open);
}

#[test]
fn f6_resolve_before_expiry_rejected() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    queue_first(&mut env, &keys, keys.threshold + 1, 1);
    let res = env.resolve_raw(&keys);
    assert_logs_contain(res, "MarketNotExpired");
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Open);
}

#[test]
fn g_winner_loser_redeem() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 50_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 50_000, MarketOutcome::No);
    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.resolve(&keys);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(MarketOutcome::Yes));
    let res = env.merge_raw(&keys, &trader, 1);
    assert_logs_contain(res, "MarketNotTradable");
    let loser = env.token_amount(ata(trader.pk(), keys.no_mint));
    assert!(loser > 0);
    let res = env.redeem_raw(&keys, &trader, keys.no_mint, loser.min(10));
    assert_logs_contain(res, "NotWinnerMint");
    let coll_before = env.token_amount(ata(trader.pk(), env.mint));
    let win = env.token_amount(ata(trader.pk(), keys.yes_mint));
    env.redeem(&keys, &trader, keys.yes_mint, win);
    let coll_after = env.token_amount(ata(trader.pk(), env.mint));
    assert_eq!(coll_after - coll_before, win, "winner redeems 1:1");
}

#[test]
fn g_expired_open_merge_and_void_redeem() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 80_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 40_000, MarketOutcome::No);
    let yes_open = env.token_amount(ata(trader.pk(), keys.yes_mint));
    let no_open = env.token_amount(ata(trader.pk(), keys.no_mint));
    env.warp(keys.expiry as i64 + 1);
    let merge_amt = yes_open.min(no_open).min(3);
    assert!(
        merge_amt >= 1,
        "need a pair to merge after expiry while Open, yes={yes_open} no={no_open}"
    );
    let coll_before = env.token_amount(ata(trader.pk(), env.mint));
    env.merge(&keys, &trader, merge_amt);
    assert_merge_one_to_one(
        &env,
        &keys,
        &trader,
        merge_amt,
        coll_before,
        yes_open,
        no_open,
    );
    env.ledger(&keys, "g_merge_after_expiry_open").assert_ok();
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    env.void_market(&keys);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::WindowBurn);
    assert_eq!(m.winner, None);
    let res = env.merge_raw(&keys, &trader, 1);
    assert_logs_contain(res, "MarketNotTradable");
    let yes_left = env.token_amount(ata(trader.pk(), keys.yes_mint));
    let no_left = env.token_amount(ata(trader.pk(), keys.no_mint));
    assert!(
        yes_left >= 3,
        "need >=3 yes to exercise void redeem 3->1, have {yes_left}"
    );
    assert!(
        no_left >= 3,
        "need >=3 no to exercise void redeem 3->1, have {no_left}"
    );
    let res = env.redeem_raw(&keys, &trader, keys.yes_mint, 1);
    assert_logs_contain(res, "InvalidAmount");
    let res = env.redeem_raw(&keys, &trader, keys.no_mint, 1);
    assert_logs_contain(res, "InvalidAmount");
    let coll_before = env.token_amount(ata(trader.pk(), env.mint));
    env.redeem(&keys, &trader, keys.yes_mint, 3);
    let coll_mid = env.token_amount(ata(trader.pk(), env.mint));
    assert_eq!(
        coll_mid - coll_before,
        1,
        "WindowBurn redeem 3 yes pays floor(3/2)=1"
    );
    env.redeem(&keys, &trader, keys.no_mint, 3);
    let coll_after = env.token_amount(ata(trader.pk(), env.mint));
    assert_eq!(
        coll_after - coll_mid,
        1,
        "WindowBurn redeem 3 no pays floor(3/2)=1"
    );
    env.ledger(&keys, "g_window_burn_after_redeem").assert_ok();
}

#[test]
fn h_expiry_releases_all_and_no_further_release() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64);
    let house = env.house_actor();
    env.withdraw(&keys, &house, 1);
    let m = env.read_market(&keys);
    println!(
        "H at expiry: reserve=({:.6},{:.6}) cum=({:.6},{:.6})",
        bits_f64(m.reserve_yes),
        bits_f64(m.reserve_no),
        bits_f64(m.cum_yes_per_share),
        bits_f64(m.cum_no_per_share)
    );
    assert_working_zero(&env, &keys, "H at expiry");
    let cum_yes = m.cum_yes_per_share;
    let cum_no = m.cum_no_per_share;
    env.warp(keys.expiry as i64 + 30);
    env.withdraw(&keys, &house, 1);
    let m2 = env.read_market(&keys);
    assert_eq!(
        m2.cum_yes_per_share, cum_yes,
        "no new yes release after expiry"
    );
    assert_eq!(
        m2.cum_no_per_share, cum_no,
        "no new no release after expiry"
    );
}

#[test]
fn h_resolve_path_final_accrual() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.resolve(&keys);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(MarketOutcome::Yes));
    assert!(m.finish_ts > 0);
    assert_working_zero(&env, &keys, "H after resolve");
    let house = env.house_actor();
    let pos = env.read_lp(&keys, house.pk()).unwrap();
    let shares = bits_f64(pos.shares);
    let pending_yes =
        (bits_f64(m.cum_yes_per_share) - bits_f64(pos.checkpoint_yes)).max(0.0) * shares;
    let yes_before = env.token_amount(ata(house.pk(), keys.yes_mint));
    env.withdraw(&keys, &house, 100);
    let yes_got = env.token_amount(ata(house.pk(), keys.yes_mint)) - yes_before;
    let l = env.ledger(&keys, "h_resolve_withdraw");
    l.assert_ok();
    println!("H resolve-path withdraw yes={yes_got} pending_yes={pending_yes}");
    assert!(yes_got > 0);
    let expect = (pending_yes * 100.0 / shares).floor();
    assert_close(
        yes_got as f64,
        expect,
        l.band.max(1.0),
        "H resolve-path withdraw is pending, not working",
    );
}

#[test]
fn b3_second_add_checkpoint() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let trader = env.fund_user(1_000_000);
    env.bet(&keys, &trader, 200_000, MarketOutcome::Yes);
    env.warp(START + LIFE / 5);
    env.bet(&keys, &trader, 50_000, MarketOutcome::No);
    let house = env.house_actor();
    let pos0 = env.read_lp(&keys, house.pk()).unwrap();
    let m0 = env.read_market(&keys);
    let old_shares = bits_f64(pos0.shares);
    let old_cp_yes = bits_f64(pos0.checkpoint_yes);
    let old_cp_no = bits_f64(pos0.checkpoint_no);
    let pending0_yes = (bits_f64(m0.cum_yes_per_share) - old_cp_yes).max(0.0) * old_shares;
    let pending0_no = (bits_f64(m0.cum_no_per_share) - old_cp_no).max(0.0) * old_shares;
    env.add_liquidity(&keys, &house, 2_000_000);
    let pos1 = env.read_lp(&keys, house.pk()).unwrap();
    let m1 = env.read_market(&keys);
    let new_shares = bits_f64(pos1.shares);
    let add_shares = new_shares - old_shares;
    // Spec: checkpoint is share-weighted average of old checkpoint and current cum
    // (after this instruction's own accrual). New shares must not eat pre-add pending.
    let cur_yes = bits_f64(m1.cum_yes_per_share);
    let cur_no = bits_f64(m1.cum_no_per_share);
    let exp_cp_yes = (old_shares * old_cp_yes + add_shares * cur_yes) / new_shares;
    let exp_cp_no = (old_shares * old_cp_no + add_shares * cur_no) / new_shares;
    let got_cp_yes = bits_f64(pos1.checkpoint_yes);
    let got_cp_no = bits_f64(pos1.checkpoint_no);
    println!("B3 checkpoint spec=({exp_cp_yes},{exp_cp_no}) got=({got_cp_yes},{got_cp_no}) add_shares={add_shares} cur_cum=({cur_yes},{cur_no})");
    let l = env.ledger(&keys, "b3_after_second_add");
    l.assert_ok();
    assert!(
        (got_cp_yes - exp_cp_yes).abs() <= l.band / new_shares.max(1.0),
        "B3 yes checkpoint weighted-average mismatch"
    );
    assert!(
        (got_cp_no - exp_cp_no).abs() <= l.band / new_shares.max(1.0),
        "B3 no checkpoint weighted-average mismatch"
    );
    let pending1_yes = (cur_yes - got_cp_yes).max(0.0) * new_shares;
    let pending1_no = (cur_no - got_cp_no).max(0.0) * new_shares;
    let hist_yes = old_shares * (cur_yes - old_cp_yes).max(0.0);
    let hist_no = old_shares * (cur_no - old_cp_no).max(0.0);
    println!("B3 pending before=({pending0_yes},{pending0_no}) after=({pending1_yes},{pending1_no}) hist_old=({hist_yes},{hist_no})");
    assert!(
        (pending1_yes - hist_yes).abs() <= l.band.max(2.0),
        "new shares must not eat pre-add yes, err={}",
        (pending1_yes - hist_yes).abs()
    );
    assert!(
        (pending1_no - hist_no).abs() <= l.band.max(2.0),
        "new shares must not eat pre-add no, err={}",
        (pending1_no - hist_no).abs()
    );

    env.bet(&keys, &trader, 80_000, MarketOutcome::Yes);
    let m2 = env.read_market(&keys);
    let pos2 = env.read_lp(&keys, house.pk()).unwrap();
    let pending2_yes = (bits_f64(m2.cum_yes_per_share) - bits_f64(pos2.checkpoint_yes)).max(0.0)
        * bits_f64(pos2.shares);
    println!("B3 pending after later bet yes={pending2_yes}");
    assert!(
        pending2_yes > pending1_yes,
        "must eat post-add fees/releases"
    );
}

#[test]
fn b1_deep_skew_vs_python() {
    let req = json!({
        "plan": "deep_skew",
        "seed": SEED,
        "duration": LIFE,
        "start_ts": START,
        "bet": 250_000,
    });
    let sim = python_sim(&req);
    let ops = sim["ops"].as_array().expect("ops");
    let steps = sim["steps"].as_array().expect("steps");
    let mut env = Env::new(START);
    let mut keys = None;
    let mut trader = None;
    let mut max_bet_out = 0.0f64;
    let mut max_bet_res = 0.0f64;
    let mut max_swap_crate = 0.0f64;
    let mut max_wd_res_delta = 0.0f64;
    let mut small_swap_out = 0.0f64;
    let mut small_swap_res = 0.0f64;
    let mut large_swap_abs = 0.0f64;
    let mut large_swap_rel = 0.0f64;
    let mut large_res_rel = 0.0f64;
    let mut saw_small_swap = false;
    let mut saw_large_swap = false;
    let mut prev_res = (None, None, None, None);
    let mut compared = 0u32;
    for (i, op) in ops.iter().enumerate() {
        let kind = op["op"].as_str().unwrap();
        match kind {
            "create" => {
                keys = Some(env.create_market(SEED, LIFE, true));
                let k = keys.as_ref().unwrap();
                let m = env.read_market(k);
                let st = &steps[i];
                let _ = reserve_step_delta(
                    &mut prev_res,
                    bits_f64(m.reserve_yes),
                    bits_f64(m.reserve_no),
                    f64_of(&st["reserve_yes"]),
                    f64_of(&st["reserve_no"]),
                );
            }
            "bet" => {
                let keys = keys.as_ref().unwrap();
                if trader.is_none() {
                    trader = Some(env.fund_user(150_000_000));
                }
                let t = trader.as_ref().unwrap();
                let amt = f64_of(&op["amount"]) as u64;
                let side = if op["side"] == "yes" {
                    MarketOutcome::Yes
                } else {
                    MarketOutcome::No
                };
                let before = if side == MarketOutcome::Yes {
                    env.token_amount(ata(t.pk(), keys.yes_mint))
                } else {
                    env.token_amount(ata(t.pk(), keys.no_mint))
                };
                env.bet(keys, t, amt, side);
                let after = if side == MarketOutcome::Yes {
                    env.token_amount(ata(t.pk(), keys.yes_mint))
                } else {
                    env.token_amount(ata(t.pk(), keys.no_mint))
                };
                let out = after as f64 - before as f64 - amt as f64;
                let st = &steps[i];
                let m = env.read_market(keys);
                let e_out = (out - f64_of(&st["output"])).abs();
                let d_res = reserve_step_delta(
                    &mut prev_res,
                    bits_f64(m.reserve_yes),
                    bits_f64(m.reserve_no),
                    f64_of(&st["reserve_yes"]),
                    f64_of(&st["reserve_no"]),
                );
                max_bet_out = max_bet_out.max(e_out);
                max_bet_res = max_bet_res.max(d_res);
                compared += 1;
                println!(
                    "B1 {kind}#{i} e_out={e_out} d_res={d_res} py_price={}",
                    f64_of(&st["price"])
                );
            }
            "swap" => {
                let keys = keys.as_ref().unwrap();
                let t = trader.as_ref().unwrap();
                let amt = f64_of(&op["amount"]) as u64;
                let side = if op["side"] == "yes" {
                    MarketOutcome::Yes
                } else {
                    MarketOutcome::No
                };
                let mint = if side == MarketOutcome::Yes {
                    keys.yes_mint
                } else {
                    keys.no_mint
                };
                let quoted = quote_swap_out(&env, keys, amt, side);
                let before = env.token_amount(ata(t.pk(), mint));
                env.swap(keys, t, amt, side);
                let after = env.token_amount(ata(t.pk(), mint));
                let out = after as f64 - before as f64;
                max_swap_crate = max_swap_crate.max((out - quoted as f64).abs());
                let st = &steps[i];
                let m = env.read_market(keys);
                let py_out = f64_of(&st["output"]);
                let e_out = (out - py_out).abs();
                let d_res = reserve_step_delta(
                    &mut prev_res,
                    bits_f64(m.reserve_yes),
                    bits_f64(m.reserve_no),
                    f64_of(&st["reserve_yes"]),
                    f64_of(&st["reserve_no"]),
                );
                let scale = py_out.abs();
                if scale >= 1_000.0 {
                    saw_large_swap = true;
                    large_swap_abs = large_swap_abs.max(e_out);
                    large_swap_rel = large_swap_rel.max(e_out / scale);
                    large_res_rel = large_res_rel.max(d_res / scale);
                } else {
                    saw_small_swap = true;
                    small_swap_out = small_swap_out.max(e_out);
                    small_swap_res = small_swap_res.max(d_res);
                }
                compared += 1;
                println!("B1 {kind}#{i} e_out={e_out} d_res={d_res} py_out={py_out}");
            }
            "warp" => {
                env.warp(f64_of(&op["ts"]) as i64);
            }
            "withdraw" => {
                let keys = keys.as_ref().unwrap();
                let house = env.house_actor();
                env.withdraw(keys, &house, f64_of(&op["shares"]) as u64);
                let st = &steps[i];
                let m = env.read_market(keys);
                let d_res = reserve_step_delta(
                    &mut prev_res,
                    bits_f64(m.reserve_yes),
                    bits_f64(m.reserve_no),
                    f64_of(&st["reserve_yes"]),
                    f64_of(&st["reserve_no"]),
                );
                max_wd_res_delta = max_wd_res_delta.max(d_res);
                compared += 1;
                println!("B1 withdraw#{i} d_res={d_res}");
            }
            other => panic!("unknown op {other}"),
        }
    }
    let keys = keys.expect("created");
    let m = env.read_market(&keys);
    let thickness = bits_f64(m.reserve_yes).abs()
        + bits_f64(m.reserve_no).abs()
        + env.token_amount(keys.yes_pool) as f64
        + env.token_amount(keys.no_pool) as f64;
    let b = band(env.ops, thickness);
    println!(
        "B1 bet_out={max_bet_out} bet_res={max_bet_res} small_out={small_swap_out} small_res={small_swap_res} large_abs={large_swap_abs} large_rel={large_swap_rel} large_res_rel={large_res_rel} swap_crate={max_swap_crate} wd_res_delta={max_wd_res_delta} compared={compared} band={b}"
    );
    assert!(compared > 0);
    assert!(saw_small_swap && saw_large_swap, "B1 must compare both swap sizes");
    assert!(max_bet_out <= 1.0, "B1 bet output err {max_bet_out} > 1");
    assert!(
        max_bet_res <= 0.002,
        "B1 bet reserve-step err {max_bet_res} > 0.002"
    );
    assert!(
        max_swap_crate == 0.0,
        "B1 chain vs crate quote {max_swap_crate} != 0"
    );
    assert!(
        small_swap_out <= 1.0,
        "B1 small swap output err {small_swap_out} > 1"
    );
    assert!(
        small_swap_res <= 1.5,
        "B1 small swap reserve-step err {small_swap_res} > 1.5"
    );
    // Tail swap pays ~4e5. Float vs I80F48 gap is ~21..30 tokens (< 1e-4 relative),
    // not chain-vs-quote (which is asserted == 0 above). Small swap is split out above.
    assert!(
        large_swap_abs <= 40.0,
        "B1 large swap output err {large_swap_abs} > 40"
    );
    assert!(
        large_swap_rel <= 1e-4,
        "B1 large swap relative err {large_swap_rel} > 1e-4"
    );
    assert!(
        large_res_rel <= 1e-4,
        "B1 large swap reserve-step relative err {large_res_rel} > 1e-4"
    );
    assert!(
        max_wd_res_delta <= 2.0,
        "B1 withdraw reserve-step err {max_wd_res_delta} > 2"
    );
}

#[test]
fn b2_aging_vs_python() {
    let ops = json!({
        "seed": SEED,
        "duration": LIFE,
        "start_ts": START,
        "ops": [
            {"op": "create"},
            {"op": "warp", "ts": START + LIFE / 2},
            {"op": "withdraw", "wallet": "house", "shares": 1},
            {"op": "warp", "ts": START + LIFE * 9 / 10},
            {"op": "withdraw", "wallet": "house", "shares": 1},
            {"op": "warp", "ts": START + LIFE * 99 / 100},
            {"op": "withdraw", "wallet": "house", "shares": 1}
        ]
    });
    let sim = python_sim(&ops);
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let house = env.house_actor();
    let mut max_err = 0.0f64;
    let marks = [
        START + LIFE / 2,
        START + LIFE * 9 / 10,
        START + LIFE * 99 / 100,
    ];
    let mut si = 2usize; // first withdraw step in python steps
    for ts in marks {
        env.warp(ts);
        let before = env.read_market(&keys);
        env.withdraw(&keys, &house, 1);
        let m = env.read_market(&keys);
        let st = &sim["steps"][si];
        let e_rel_y = (bits_f64(m.reserve_yes) - f64_of(&st["reserve_yes"])).abs();
        let e_rel_n = (bits_f64(m.reserve_no) - f64_of(&st["reserve_no"])).abs();
        let e_cum_y = (bits_f64(m.cum_yes_per_share) - f64_of(&st["cum_yes"])).abs();
        let e_cum_n = (bits_f64(m.cum_no_per_share) - f64_of(&st["cum_no"])).abs();
        let pos = env.read_lp(&keys, house.pk()).unwrap();
        let pending_yes = (bits_f64(m.cum_yes_per_share) - bits_f64(pos.checkpoint_yes)).max(0.0)
            * bits_f64(pos.shares);
        let pending_no = (bits_f64(m.cum_no_per_share) - bits_f64(pos.checkpoint_no)).max(0.0)
            * bits_f64(pos.shares);
        let py_pending_yes = f64_of(&st["pending"]["house"]["yes"]);
        let py_pending_no = f64_of(&st["pending"]["house"]["no"]);
        let e_p = (pending_yes - py_pending_yes)
            .abs()
            .max((pending_no - py_pending_no).abs());
        let released_yes = (bits_f64(m.cum_yes_per_share) - bits_f64(before.cum_yes_per_share))
            * bits_f64(before.total_lp_shares);
        let released_no = (bits_f64(m.cum_no_per_share) - bits_f64(before.cum_no_per_share))
            * bits_f64(before.total_lp_shares);
        let e_rel = (released_yes - f64_of(&st["released_yes"]))
            .abs()
            .max((released_no - f64_of(&st["released_no"])).abs());
        max_err = max_err
            .max(e_rel_y)
            .max(e_rel_n)
            .max(e_cum_y)
            .max(e_cum_n)
            .max(e_p)
            .max(e_rel);
        println!(
            "B2 ts={ts} reserve_err=({e_rel_y},{e_rel_n}) cum_err=({e_cum_y},{e_cum_n}) pending_err={e_p} release_err={e_rel} released_chain=({released_yes},{released_no}) released_py=({},{})",
            f64_of(&st["released_yes"]), f64_of(&st["released_no"])
        );
        si += 2; // warp is separate; after first withdraw, next is warp then withdraw -> +2
    }
    let m = env.read_market(&keys);
    let thickness = bits_f64(m.reserve_yes).abs()
        + bits_f64(m.reserve_no).abs()
        + env.token_amount(keys.yes_pool) as f64
        + env.token_amount(keys.no_pool) as f64;
    let b = band(env.ops, thickness);
    println!("B2 max_err={max_err} band={b}");
    assert!(
        max_err <= 0.05,
        "B2 python vs chain max_err {max_err} exceeds 0.05 (measured 0.014, ledger band {b})"
    );
}
#[test]
fn f1_equal_threshold_counts_as_above() {
    let (status, winner, _, _) = resolve_case(true, 0, 3);
    assert_eq!(status, MarketStatus::Resolved);
    assert_eq!(winner, Some(MarketOutcome::Yes));
    let (status, winner, _, _) = resolve_case(false, 0, 3);
    assert_eq!(status, MarketStatus::Resolved);
    assert_eq!(winner, Some(MarketOutcome::No));
}

#[test]
fn f_window_endpoint_resolve_inclusive_void_exclusive() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.resolve(&keys);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Resolved);

    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64);
    let res = env.void_raw(&keys);
    assert_logs_contain(res, "MarketNotInWindow");
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    env.void_market(&keys);
    assert_eq!(env.read_market(&keys).status, MarketStatus::WindowBurn);
}

#[test]
fn f_mismatched_feed_rejected() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    let res = env.resolve_raw_against(&keys, prediction_market::ALLOWED_FEEDS[1].state);
    assert_logs_contain(res, "WrongOracleState");
    assert_eq!(env.read_market(&keys).status, MarketStatus::Open);
    assert_eq!(env.read_market(&keys).finish_ts, 0);
}

#[test]
fn i_burn_account_gates() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let house = env.house_actor();
    let stranger = env.fund_user(10_000);
    let res = env.burn_account_raw(&keys, &house);
    assert_logs_contain(res, "MarketIsOpen");
    let res = env.burn_account_raw(&keys, &stranger);
    assert_logs_contain(res, "NoCreator");

    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.resolve(&keys);
    let finish = env.read_market(&keys).finish_ts;
    env.warp(finish as i64 + CLAIM_WINDOW as i64);
    let res = env.burn_account_raw(&keys, &house);
    assert_logs_contain(res, "NoArriveFinishTS");
    let res = env.burn_account_raw(&keys, &stranger);
    assert_logs_contain(res, "NoCreator");
}

#[test]
fn i_burn_account_sweeps_after_claim_window() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 50_000, MarketOutcome::Yes);
    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.resolve(&keys);
    let house = env.house_actor();
    let finish = env.read_market(&keys).finish_ts;
    let vault_before = env.token_amount(keys.vault);
    let house_coll_before = env.token_amount(ata(house.pk(), env.mint));
    assert!(vault_before > 0);
    env.warp(finish as i64 + CLAIM_WINDOW as i64 + 1);
    let win_left = env.token_amount(ata(trader.pk(), keys.yes_mint));
    assert!(
        win_left > 0,
        "trader must still hold unredeemed winner tokens before sweep"
    );
    env.burn_account(&keys, &house);
    assert!(!env.account_alive(keys.market), "market account closed");
    assert!(!env.account_alive(keys.snapshot), "snapshot account closed");
    assert!(!env.account_alive(keys.vault), "vault closed");
    assert!(!env.account_alive(keys.yes_pool), "yes pool closed");
    assert!(!env.account_alive(keys.no_pool), "no pool closed");
    let house_coll_after = env.token_amount(ata(house.pk(), env.mint));
    assert_eq!(
        house_coll_after - house_coll_before,
        vault_before,
        "creator receives remaining vault"
    );
    let win_after = env.token_amount(ata(trader.pk(), keys.yes_mint));
    assert_eq!(
        win_after, win_left,
        "unredeemed winner tokens remain in trader wallet"
    );
    let res = env.redeem_raw(&keys, &trader, keys.yes_mint, win_after.min(10).max(1));
    let err = res.expect_err("redeem after burn_account must fail; vault is gone");
    println!(
        "I sweep hole: outstanding_winner={win_left} vault_swept={vault_before} redeem_err={:?}",
        err.err
    );
}
#[test]
fn f_unlisted_oracle_state_rejected() {
    let mut env = Env::new(START);
    let bogus = env.forge_unlisted_state();
    let (_keys, res) = env.create_market_on(SEED, (env.clock + 3_600) as u64, true, bogus);
    assert_logs_contain(res, "WrongOracleState");
}

#[test]
fn g_stale_burn_redeem_both_sides() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 80_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 40_000, MarketOutcome::No);
    env.warp(keys.expiry as i64 + 20);
    let late_price = keys.threshold + 9;
    let late_time = keys.expiry as i64 + 15;
    env.queue_ocr2_reports(late_price, late_time, keys.expiry as i64 - 1);
    env.resolve(&keys);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::StaleBurn);
    assert_eq!(m.winner, None);
    assert_eq!(
        m.settled_price, 0,
        "StaleBurn does not store the late print"
    );
    assert_eq!(
        m.settled_publish_time, 0,
        "StaleBurn does not store the late print"
    );
    env.ledger(&keys, "g_stale_burn").assert_ok();

    let res = env.merge_raw(&keys, &trader, 1);
    assert_logs_contain(res, "MarketNotTradable");

    let yes_left = env.token_amount(ata(trader.pk(), keys.yes_mint));
    let no_left = env.token_amount(ata(trader.pk(), keys.no_mint));
    assert!(
        yes_left >= 3,
        "need >=3 yes for stale redeem, have {yes_left}"
    );
    assert!(no_left >= 3, "need >=3 no for stale redeem, have {no_left}");

    let res = env.redeem_raw(&keys, &trader, keys.yes_mint, 1);
    assert_logs_contain(res, "InvalidAmount");
    let res = env.redeem_raw(&keys, &trader, keys.no_mint, 1);
    assert_logs_contain(res, "InvalidAmount");

    let coll0 = env.token_amount(ata(trader.pk(), env.mint));
    env.redeem(&keys, &trader, keys.yes_mint, 3);
    let coll1 = env.token_amount(ata(trader.pk(), env.mint));
    assert_eq!(coll1 - coll0, 1, "StaleBurn redeem 3 yes pays floor(3/2)=1");
    env.redeem(&keys, &trader, keys.no_mint, 3);
    let coll2 = env.token_amount(ata(trader.pk(), env.mint));
    assert_eq!(coll2 - coll1, 1, "StaleBurn redeem 3 no pays floor(3/2)=1");
    env.ledger(&keys, "g_stale_burn_after_redeem").assert_ok();
}
#[test]
fn f2_prev_publish_time_equals_expiry_rejected() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + 2);
    env.queue_ocr2_reports(
        keys.threshold + 1,
        keys.expiry as i64 + 2,
        keys.expiry as i64,
    );
    let res = env.resolve_raw(&keys);
    assert_logs_contain(res, "NotFirstAfterExpiry");
    let m = env.read_market(&keys);
    assert_eq!(
        m.status,
        MarketStatus::Open,
        "prev_publish_time == expiry must not void"
    );
    assert_eq!(m.winner, None);
    assert_eq!(m.finish_ts, 0);
    assert_eq!(m.settled_price, 0);
    assert_eq!(m.settled_publish_time, 0);
}

#[test]
fn f3_first_print_just_over_10s_stale_burns() {
    let (status, winner, price, publish) = resolve_case(true, 5, MAX_SETTLE_DELAY + 1);
    assert_eq!(status, MarketStatus::StaleBurn);
    assert_eq!(winner, None);
    assert_eq!(price, 0, "StaleBurn does not store the late print");
    assert_eq!(publish, 0, "StaleBurn does not store the late print");
}

#[test]
fn g_trade_blocked_merge_ok_after_expiry() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(300_000);
    env.bet(&keys, &trader, 50_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 40_000, MarketOutcome::No);
    env.warp(keys.expiry as i64);
    let res = env.bet_raw(&keys, &trader, 1_000, MarketOutcome::Yes);
    assert_logs_contain(res, "MarketExpired");
    let sell = env
        .token_amount(ata(trader.pk(), keys.yes_mint))
        .min(1_000)
        .max(1);
    let res = env.swap_raw(&keys, &trader, sell, MarketOutcome::No);
    assert_logs_contain(res, "MarketExpired");
    let house = env.house_actor();
    let res = env.add_liquidity_raw(&keys, &house, 1_000);
    assert_logs_contain(res, "MarketExpired");
    let yes_left = env.token_amount(ata(trader.pk(), keys.yes_mint));
    let no_left = env.token_amount(ata(trader.pk(), keys.no_mint));
    let merge_amt = yes_left.min(no_left).min(3).max(1);
    let coll_before = env.token_amount(ata(trader.pk(), env.mint));
    env.merge(&keys, &trader, merge_amt);
    assert_merge_one_to_one(
        &env,
        &keys,
        &trader,
        merge_amt,
        coll_before,
        yes_left,
        no_left,
    );
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Open);
    env.ledger(&keys, "g_merge_at_expiry").assert_ok();
}

#[test]
fn i_burn_account_after_window_burn() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(80_000);
    env.bet(&keys, &trader, 20_000, MarketOutcome::Yes);
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    env.void_market(&keys);
    assert_eq!(env.read_market(&keys).status, MarketStatus::WindowBurn);
    let house = env.house_actor();
    let finish = env.read_market(&keys).finish_ts;
    let vault_before = env.token_amount(keys.vault);
    let house_coll_before = env.token_amount(ata(house.pk(), env.mint));
    env.warp(finish as i64 + CLAIM_WINDOW as i64 + 1);
    let yes_left = env.token_amount(ata(trader.pk(), keys.yes_mint));
    assert!(
        yes_left > 0,
        "unredeemed tokens must remain before WindowBurn sweep"
    );
    env.burn_account(&keys, &house);
    assert!(!env.account_alive(keys.market), "WindowBurn market closed");
    assert!(!env.account_alive(keys.vault), "WindowBurn vault closed");
    let house_coll_after = env.token_amount(ata(house.pk(), env.mint));
    assert_eq!(
        house_coll_after - house_coll_before,
        vault_before,
        "creator sweeps remaining vault after WindowBurn"
    );
    println!("I WindowBurn sweep: outstanding_yes={yes_left} vault_swept={vault_before}");
}

#[test]
fn j_permissionless_resolve_and_void() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let stranger = env.fund_user(10_000);
    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.resolve_raw_as(&keys, &stranger)
        .unwrap_or_else(|e| {
            panic!(
                "stranger resolve failed: {:?}\n{}",
                e.err,
                e.meta.logs.join("\n")
            )
        });
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(MarketOutcome::Yes));
    assert!(m.finish_ts > 0);

    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let stranger = env.fund_user(10_000);
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    env.void_raw_as(&keys, &stranger).unwrap_or_else(|e| {
        panic!(
            "stranger void failed: {:?}\n{}",
            e.err,
            e.meta.logs.join("\n")
        )
    });
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::WindowBurn);
    assert_eq!(m.winner, None);
}

#[test]
fn j_create_expiry_gates() {
    let mut env = Env::new(START);
    let (_keys, res) = env.create_market_raw(SEED, 0, true);
    assert_logs_contain(res, "InvalidAmount");

    let mut env = Env::new(START);
    let (_keys, res) = env.create_market_raw(SEED, -10, true);
    assert_logs_contain(res, "InvalidAmount");

    let mut env = Env::new(START);
    let (_keys, res) = env.create_market_raw_expiry(SEED, u64::MAX - 1_000, true);
    assert_logs_contain(res, "InvalidAmount");

    let mut env = Env::new(START);
    let (_keys, res) = env.create_market_raw_expiry(SEED, i64::MAX as u64, true);
    assert_logs_contain(res, "InvalidAmount");
}

#[test]
fn j_zero_amounts_and_slippage() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(300_000);

    assert_logs_contain(env.add_liquidity_raw(&keys, &trader, 0), "InvalidAmount");
    assert_logs_contain(
        env.bet_raw(&keys, &trader, 0, MarketOutcome::Yes),
        "InvalidAmount",
    );
    assert_logs_contain(
        env.bet_raw_min_out(&keys, &trader, 20_000, MarketOutcome::Yes, u64::MAX),
        "SlippageExceeded",
    );

    env.bet(&keys, &trader, 50_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 40_000, MarketOutcome::No);
    assert_logs_contain(
        env.swap_raw(&keys, &trader, 0, MarketOutcome::Yes),
        "InvalidAmount",
    );
    assert_logs_contain(env.merge_raw(&keys, &trader, 0), "InvalidAmount");
    let yes_bal = env.token_amount(ata(trader.pk(), keys.yes_mint));
    assert_logs_contain(
        env.swap_raw_ex(
            &keys,
            &trader,
            yes_bal.min(5_000).max(1),
            MarketOutcome::No,
            u64::MAX,
            ata(trader.pk(), keys.yes_mint),
            ata(trader.pk(), keys.no_mint),
        ),
        "SlippageExceeded",
    );

    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.resolve(&keys);
    assert_logs_contain(
        env.redeem_raw(&keys, &trader, keys.yes_mint, 0),
        "InvalidAmount",
    );
}

#[test]
fn j_balances_mints_atas_and_vault() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(80_000);
    let poor = env.fund_user(1_000);
    let other = env.fund_user(80_000);
    env.bet(&keys, &trader, 30_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 20_000, MarketOutcome::No);
    env.bet(&keys, &other, 25_000, MarketOutcome::Yes);

    assert_logs_fail(
        env.bet_raw(&keys, &poor, 50_000, MarketOutcome::Yes),
        &[
            "insufficient funds",
            "InsufficientFunds",
            "custom program error: 0x1",
            "Custom(1)",
        ],
    );

    let yes_bal = env.token_amount(ata(trader.pk(), keys.yes_mint));
    assert_logs_fail(
        env.swap_raw(&keys, &trader, yes_bal + 1, MarketOutcome::No),
        &[
            "insufficient funds",
            "InsufficientFunds",
            "custom program error: 0x1",
            "Custom(1)",
        ],
    );

    let merge_have = env
        .token_amount(ata(trader.pk(), keys.yes_mint))
        .min(env.token_amount(ata(trader.pk(), keys.no_mint)));
    assert_logs_contain(
        env.merge_raw(&keys, &trader, merge_have + 1),
        "InsufficientBalance",
    );

    assert_logs_fail(
        env.swap_raw_ex(
            &keys,
            &trader,
            1,
            MarketOutcome::No,
            1,
            ata(other.pk(), keys.yes_mint),
            ata(trader.pk(), keys.no_mint),
        ),
        &[
            "ConstraintAssociatedToken",
            "ConstraintTokenOwner",
            "associated token",
        ],
    );

    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.resolve(&keys);

    assert_logs_contain(
        env.redeem_raw(&keys, &trader, env.mint, 1),
        "ConstraintDuplicateMutableAccount",
    );
    let foreign = env.extra_mint();
    env.ensure_ata(trader.pk(), foreign);
    assert_logs_contain(
        env.redeem_raw_accounts(
            &keys,
            &trader,
            foreign,
            ata(trader.pk(), foreign),
            keys.vault,
            1,
        ),
        "InvalidMint",
    );
    let win = env.token_amount(ata(trader.pk(), keys.yes_mint));
    assert_logs_contain(
        env.redeem_raw(&keys, &trader, keys.yes_mint, win + 1),
        "InsufficientBalance",
    );
    assert_logs_fail(
        env.redeem_raw_accounts(
            &keys,
            &trader,
            keys.yes_mint,
            ata(other.pk(), keys.yes_mint),
            keys.vault,
            1,
        ),
        &[
            "ConstraintAssociatedToken",
            "ConstraintTokenOwner",
            "associated token",
        ],
    );
    assert_logs_fail(
        env.redeem_raw_accounts(
            &keys,
            &trader,
            keys.yes_mint,
            ata(trader.pk(), keys.yes_mint),
            ata(other.pk(), env.mint),
            1,
        ),
        &[
            "ConstraintSeeds",
            "seeds constraint",
            "A seeds constraint was violated",
        ],
    );
}

#[test]
fn j_status_conflicts() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(80_000);
    let lp = env.fund_user(1_500_000);
    env.bet(&keys, &trader, 20_000, MarketOutcome::Yes);
    env.add_liquidity(&keys, &lp, 1_000_000);

    env.warp(keys.expiry as i64);
    assert_logs_contain(
        env.bet_raw(&keys, &trader, 1_000, MarketOutcome::Yes),
        "MarketExpired",
    );
    assert_logs_contain(
        env.swap_raw(&keys, &trader, 1, MarketOutcome::No),
        "MarketExpired",
    );
    assert_logs_contain(env.add_liquidity_raw(&keys, &lp, 1_000), "MarketExpired");

    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.resolve(&keys);
    assert_logs_contain(
        env.bet_raw(&keys, &trader, 1_000, MarketOutcome::Yes),
        "MarketNotOpen",
    );
    assert_logs_contain(
        env.swap_raw(&keys, &trader, 1, MarketOutcome::No),
        "MarketNotOpen",
    );
    assert_logs_contain(env.add_liquidity_raw(&keys, &lp, 1_000), "MarketNotOpen");
    assert_logs_contain(env.merge_raw(&keys, &trader, 1), "MarketNotTradable");
    queue_first(&mut env, &keys, keys.threshold + 2, 3);
    assert_logs_contain(env.resolve_raw(&keys), "MarketNotOpen");
    // void checks the 48h window before status, so a just-resolved market still in-window is MarketNotInWindow
    assert_logs_contain(env.void_raw(&keys), "MarketNotInWindow");
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    assert_logs_contain(env.void_raw(&keys), "MarketNotOpen");

    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    env.void_market(&keys);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    assert_logs_contain(env.resolve_raw(&keys), "MarketNotOpen");
}

#[test]
fn j_tampered_report_and_wrong_state_owner_rejected() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.tamper_queued_post();
    assert_logs_fail(
        env.resolve_raw(&keys),
        &[
            "InvalidOracleSignature",
            "UnauthorizedOracleSigner",
            "InvalidOracleInput",
            "OracleDigestMismatch",
            "WrongNumberOfSignatures",
            "DuplicateOracleSigner",
        ],
    );
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Open);
    assert_eq!(m.winner, None);
    assert_eq!(m.finish_ts, 0);
    assert_eq!(m.settled_price, 0);

    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.set_account_owner(keys.ocr2_state, SYSTEM_PROGRAM);
    assert_logs_fail(
        env.resolve_raw(&keys),
        &["ConstraintOwner", "owner constraint was violated"],
    );
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Open);
    assert_eq!(m.winner, None);
    assert_eq!(m.finish_ts, 0);
}

#[test]
fn j_stranger_cannot_withdraw_house_lp() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let stranger = env.fund_user(10_000);
    assert_logs_fail(
        env.withdraw_raw(&keys, &stranger, 1),
        &["AccountNotInitialized", "already initialized"],
    );
    assert_logs_fail(
        env.withdraw_raw_position(&keys, &stranger, keys.lp_position(env.house_pk()), 1),
        &[
            "ConstraintSeeds",
            "seeds constraint",
            "A seeds constraint was violated",
        ],
    );
    assert!(
        env.read_lp(&keys, env.house_pk()).is_some(),
        "house LP must remain"
    );
}

#[test]
fn j_stale_burn_lp_exit_then_sweep() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let lp = env.fund_user(2_000_000);
    env.add_liquidity(&keys, &lp, 2_000_000);
    let trader = env.fund_user(80_000);
    env.bet(&keys, &trader, 20_000, MarketOutcome::Yes);
    env.warp(keys.expiry as i64 + MAX_SETTLE_DELAY + 5);
    let late = keys.expiry as i64 + MAX_SETTLE_DELAY + 5;
    env.queue_ocr2_reports(keys.threshold + 1, late, keys.expiry as i64 - 1);
    env.resolve(&keys);
    assert_eq!(env.read_market(&keys).status, MarketStatus::StaleBurn);

    env.withdraw(&keys, &lp, u64::MAX);
    assert!(
        env.read_lp(&keys, lp.pk()).is_none(),
        "StaleBurn full exit closes extra LP"
    );
    env.ledger(&keys, "j_stale_lp_exit").assert_ok();

    let house = env.house_actor();
    let finish = env.read_market(&keys).finish_ts;
    let vault_before = env.token_amount(keys.vault);
    let house_coll_before = env.token_amount(ata(house.pk(), env.mint));
    env.warp(finish as i64 + CLAIM_WINDOW as i64 + 1);
    let yes_left = env.token_amount(ata(trader.pk(), keys.yes_mint));
    assert!(
        yes_left > 0,
        "unredeemed tokens remain before StaleBurn sweep"
    );
    env.burn_account(&keys, &house);
    assert!(!env.account_alive(keys.market), "StaleBurn market closed");
    assert!(!env.account_alive(keys.vault), "StaleBurn vault closed");
    let house_coll_after = env.token_amount(ata(house.pk(), env.mint));
    assert_eq!(
        house_coll_after - house_coll_before,
        vault_before,
        "creator sweeps remaining vault after StaleBurn"
    );
    assert_eq!(
        env.token_amount(ata(trader.pk(), keys.yes_mint)),
        yes_left,
        "current chain does not enforce TokensOutstanding before sweep"
    );
}

#[test]
fn e_last_lp_drain_empty_pool() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let extra = env.fund_user(2_000_000);
    env.add_liquidity(&keys, &extra, 2_000_000);
    env.withdraw(&keys, &extra, u64::MAX);
    assert!(
        env.read_lp(&keys, extra.pk()).is_none(),
        "extra LP full exit closes position"
    );

    let house = env.house_actor();
    env.withdraw(&keys, &house, u64::MAX);
    assert!(
        env.read_lp(&keys, house.pk()).is_none(),
        "last LP full exit closes house position"
    );
    let m = env.read_market(&keys);
    println!(
        "E last LP: shares={} reserve=({:.6},{:.6}) phys=({},{})",
        bits_f64(m.total_lp_shares),
        bits_f64(m.reserve_yes),
        bits_f64(m.reserve_no),
        env.token_amount(keys.yes_pool),
        env.token_amount(keys.no_pool)
    );
    assert!(
        bits_f64(m.total_lp_shares).abs() <= 1.0,
        "last LP must drain total shares"
    );
    assert!(
        bits_f64(m.reserve_yes).abs() <= 1.0,
        "last LP must drain working yes"
    );
    assert!(
        bits_f64(m.reserve_no).abs() <= 1.0,
        "last LP must drain working no"
    );

    let stranger = env.fund_user(100_000);
    assert_logs_contain(env.add_liquidity_raw(&keys, &stranger, 10_000), "EmptyPool");
    assert_logs_contain(
        env.bet_raw(&keys, &stranger, 1_000, MarketOutcome::Yes),
        "EmptyPool",
    );
    env.ensure_ata(stranger.pk(), keys.yes_mint);
    env.ensure_ata(stranger.pk(), keys.no_mint);
    assert_logs_contain(
        env.swap_raw(&keys, &stranger, 1, MarketOutcome::Yes),
        "EmptyPool",
    );
}

#[test]
fn k_math_vectors_from_oracle_json() {
    let path =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../oracle/test_vectors.json");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let v: serde_json::Value = serde_json::from_str(&raw).expect("test_vectors json");
    let f = |x: f64| I80F48::from_num(x);
    let got = |x: I80F48| x.to_num::<f64>();
    let close = |label: &str, actual: f64, expected: f64, tol: f64| {
        let err = (actual - expected).abs();
        println!(
            "{label}: actual={actual:.12} expected={expected:.12} err={err:.3e} tol={tol:.3e}"
        );
        assert!(err <= tol, "{label}: err {err} > {tol}");
    };

    close(
        "phi0",
        got(phi_fixed(f(0.0)).unwrap()),
        v["phi0"].as_f64().unwrap(),
        1e-8,
    );
    for (k, val) in v["phi"].as_object().expect("phi map") {
        let z: f64 = k.parse().unwrap();
        close(
            &format!("phi({k})"),
            got(phi_fixed(f(z)).unwrap()),
            val.as_f64().unwrap(),
            1e-8,
        );
    }
    for (k, val) in v["capital_phi"].as_object().expect("Phi map") {
        let z: f64 = k.parse().unwrap();
        close(
            &format!("Phi({k})"),
            got(capital_phi_fixed(f(z)).unwrap()),
            val.as_f64().unwrap(),
            1e-6,
        );
    }
    for (k, val) in v["capital_phi_inv"].as_object().expect("Phi_inv map") {
        let p: f64 = k.parse().unwrap();
        let tol = if p <= 0.05 || p >= 0.95 {
            1e-3
        } else if (p - 0.5).abs() < 1e-12 {
            1e-8
        } else {
            1e-6
        };
        close(
            &format!("Phi_inv({k})"),
            got(capital_phi_inv_fixed(f(p)).unwrap()),
            val.as_f64().unwrap(),
            tol,
        );
    }

    let (x, y) = reserves_from_price(f(0.5), f(1000.0)).unwrap();
    close(
        "x*(0.5,1000)",
        got(x),
        v["reserves"]["l_eff_1000_p05"][0].as_f64().unwrap(),
        1e-5,
    );
    close(
        "y*(0.5,1000)",
        got(y),
        v["reserves"]["l_eff_1000_p05"][1].as_f64().unwrap(),
        1e-5,
    );
    assert!((got(x) - got(y)).abs() <= 1e-5, "P=0.5 reserves must match");
    close(
        "P from reserves",
        got(price_from_reserves(x, y, f(1000.0)).unwrap()),
        0.5,
        1e-8,
    );

    let (x3, y3) = reserves_from_price(f(0.3), f(1000.0)).unwrap();
    close(
        "x*(0.3,1000)",
        got(x3),
        v["reserves"]["l_eff_1000_p03"][0].as_f64().unwrap(),
        1e-4,
    );
    close(
        "y*(0.3,1000)",
        got(y3),
        v["reserves"]["l_eff_1000_p03"][1].as_f64().unwrap(),
        1e-4,
    );

    for (k, val) in v["reserves"]["l_eff_1000"]
        .as_object()
        .expect("reserve grid")
    {
        let p: f64 = k.parse().unwrap();
        let (x, y) = reserves_from_price(f(p), f(1000.0)).unwrap();
        let exp_x = val[0].as_f64().unwrap();
        let exp_y = val[1].as_f64().unwrap();
        let tol = if p <= 0.1 || p >= 0.9 { 0.5 } else { 1e-4 };
        close(&format!("x*({p},1000)"), got(x), exp_x, tol);
        close(&format!("y*({p},1000)"), got(y), exp_y, tol);
        close(
            &format!("P from reserves {p}"),
            got(price_from_reserves(x, y, f(1000.0)).unwrap()),
            p,
            1e-4,
        );
    }
    for (k, val) in v["pool_value"].as_object().expect("pool_value") {
        let p: f64 = k.parse().unwrap();
        close(
            &format!("V({p},1000)"),
            got(pool_value(f(p), f(1000.0)).unwrap()),
            val.as_f64().unwrap(),
            1e-4,
        );
    }

    let l0 = suggest_l_zero_for_budget(1_000_000, 86_400).unwrap();
    close(
        "L0(1e6,1d)",
        got(l0),
        v["suggest_l_zero"]["budget_1e6_day"].as_f64().unwrap(),
        1e-6,
    );
    close(
        "L0(1000,1w)",
        got(suggest_l_zero_for_budget(1000, 604_800).unwrap()),
        v["suggest_l_zero"]["budget_1000_week"].as_f64().unwrap(),
        1e-4,
    );
    assert!(
        l_effective(f(1.0), 0).is_err(),
        "L_eff(T=0) InvalidDuration"
    );
    assert!(
        suggest_l_zero_for_budget(0, 86_400).is_err(),
        "L0(budget=0) InvalidBudget"
    );
}

#[test]
fn d_create_binds_allowlisted_ocr2_state() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let m = env.read_market(&keys);
    assert_eq!(m.ocr2_state, prediction_market::ALLOWED_FEEDS[0].state);
    assert_eq!(m.decimals, 8);
    assert!(env.account_alive(keys.snapshot));
    assert_eq!(env.snapshot_len(&keys), 0);

    let eth =
        env.create_market_on_state(SEED, LIFE, true, prediction_market::ALLOWED_FEEDS[1].state);
    let other = env.read_market(&eth);
    assert_eq!(other.ocr2_state, prediction_market::ALLOWED_FEEDS[1].state);
    assert_eq!(other.decimals, 8);
    assert_ne!(other.ocr2_state, m.ocr2_state);

    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold + 1, 2);
    env.resolve(&keys);
    let resolved = env.read_market(&keys);
    assert_eq!(resolved.status, MarketStatus::Resolved);
    assert_eq!(resolved.winner, Some(MarketOutcome::Yes));
    assert_eq!(resolved.settled_price, keys.threshold + 1);
    assert_eq!(resolved.settled_publish_time, keys.expiry as i64 + 2);
}

#[test]
fn g_no_winner_redeems_1_to_1() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 50_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 50_000, MarketOutcome::No);
    env.warp(keys.expiry as i64 + 2);
    queue_first(&mut env, &keys, keys.threshold - 1, 2);
    env.resolve(&keys);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(MarketOutcome::No));
    let yes = env.token_amount(ata(trader.pk(), keys.yes_mint));
    assert!(yes > 0);
    assert_logs_contain(
        env.redeem_raw(&keys, &trader, keys.yes_mint, yes.min(10)),
        "NotWinnerMint",
    );
    let coll_before = env.token_amount(ata(trader.pk(), env.mint));
    let win = env.token_amount(ata(trader.pk(), keys.no_mint));
    env.redeem(&keys, &trader, keys.no_mint, win);
    let coll_after = env.token_amount(ata(trader.pk(), env.mint));
    assert_eq!(coll_after - coll_before, win, "No winner redeems 1:1");
}

#[test]
fn g_void_redeem_is_floor_div_2() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(300_000);
    env.bet(&keys, &trader, 80_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 40_000, MarketOutcome::No);
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    env.void_market(&keys);
    assert_eq!(env.read_market(&keys).status, MarketStatus::WindowBurn);
    assert_logs_contain(
        env.redeem_raw(&keys, &trader, keys.yes_mint, 1),
        "InvalidAmount",
    );
    let cases = [(2u64, 1u64), (4, 2), (5, 2), (6, 3)];
    for (amount, expect) in cases {
        let before = env.token_amount(ata(trader.pk(), env.mint));
        env.redeem(&keys, &trader, keys.yes_mint, amount);
        let got = env.token_amount(ata(trader.pk(), env.mint)) - before;
        assert_eq!(
            got, expect,
            "WindowBurn yes amount={amount} must pay floor(amount/2)={expect}, not floor(amount/3)"
        );
    }
    for (amount, expect) in cases {
        let before = env.token_amount(ata(trader.pk(), env.mint));
        env.redeem(&keys, &trader, keys.no_mint, amount);
        let got = env.token_amount(ata(trader.pk(), env.mint)) - before;
        assert_eq!(
            got, expect,
            "WindowBurn no amount={amount} must pay floor(amount/2)={expect}, not floor(amount/3)"
        );
    }
}

#[test]
fn g_stale_redeem_is_floor_div_2() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(300_000);
    env.bet(&keys, &trader, 80_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 40_000, MarketOutcome::No);
    env.warp(keys.expiry as i64 + 20);
    env.queue_ocr2_reports(
        keys.threshold + 9,
        keys.expiry as i64 + 15,
        keys.expiry as i64 - 1,
    );
    env.resolve(&keys);
    assert_eq!(env.read_market(&keys).status, MarketStatus::StaleBurn);
    assert_logs_contain(
        env.redeem_raw(&keys, &trader, keys.yes_mint, 1),
        "InvalidAmount",
    );
    for (amount, expect) in [(2u64, 1u64), (4, 2), (5, 2)] {
        let before = env.token_amount(ata(trader.pk(), env.mint));
        env.redeem(&keys, &trader, keys.yes_mint, amount);
        assert_eq!(
            env.token_amount(ata(trader.pk(), env.mint)) - before,
            expect,
            "StaleBurn yes amount={amount} must pay floor(amount/2)={expect}"
        );
    }
}

#[test]
fn f1_first_print_at_expiry_settles() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64);
    env.queue_ocr2_reports(
        keys.threshold + 1,
        keys.expiry as i64,
        keys.expiry as i64 - 1,
    );
    env.resolve(&keys);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(MarketOutcome::Yes));
    assert_eq!(m.settled_publish_time, keys.expiry as i64);
}

#[test]
fn j_min_out_exact_boundary() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(400_000);
    env.bet(&keys, &trader, 80_000, MarketOutcome::Yes);
    env.ensure_ata(trader.pk(), keys.yes_mint);
    env.ensure_ata(trader.pk(), keys.no_mint);

    let sell = 5_000u64;
    let quoted = quote_swap_out(&env, &keys, sell, MarketOutcome::No);
    assert!(quoted > 1, "need a real swap quote, got {quoted}");
    let py = python_sim(&json!({
        "seed": SEED,
        "duration": 3_600,
        "start_ts": START,
        "ops": [
            {"op": "create"},
            {"op": "bet", "wallet": "trader", "amount": 80_000, "side": "yes"},
            {"op": "swap", "wallet": "trader", "amount": sell, "side": "no"}
        ]
    }));
    assert_close(
        quoted as f64,
        f64_of(&py["steps"][2]["output"]),
        0.0,
        "min_out crate quote vs python",
    );
    let no_before = env.token_amount(ata(trader.pk(), keys.no_mint));
    env.swap_raw_ex(
        &keys,
        &trader,
        sell,
        MarketOutcome::No,
        quoted,
        ata(trader.pk(), keys.yes_mint),
        ata(trader.pk(), keys.no_mint),
    )
    .unwrap_or_else(|e| {
        panic!(
            "exact min_out must succeed: {:?}\n{}",
            e.err,
            e.meta.logs.join("\n")
        )
    });
    assert_eq!(
        env.token_amount(ata(trader.pk(), keys.no_mint)) - no_before,
        quoted,
        "swap payout must equal quoted min_out"
    );

    let sell2 = 3_000u64;
    let quoted2 = quote_swap_out(&env, &keys, sell2, MarketOutcome::No);
    assert!(quoted2 > 0);
    assert_logs_contain(
        env.swap_raw_ex(
            &keys,
            &trader,
            sell2,
            MarketOutcome::No,
            quoted2 + 1,
            ata(trader.pk(), keys.yes_mint),
            ata(trader.pk(), keys.no_mint),
        ),
        "SlippageExceeded",
    );

    let bet_amt = 20_000u64;
    let quoted_bet = quote_swap_out(&env, &keys, bet_amt, MarketOutcome::Yes);
    assert!(quoted_bet > 0);
    let yes_before = env.token_amount(ata(trader.pk(), keys.yes_mint));
    env.bet_raw_min_out(&keys, &trader, bet_amt, MarketOutcome::Yes, quoted_bet)
        .unwrap_or_else(|e| {
            panic!(
                "exact bet min_out must succeed: {:?}\n{}",
                e.err,
                e.meta.logs.join("\n")
            )
        });
    assert_eq!(
        env.token_amount(ata(trader.pk(), keys.yes_mint)) - yes_before,
        bet_amt + quoted_bet,
        "bet yes keeps minted amount plus exact swap out"
    );
    let quoted_bet2 = quote_swap_out(&env, &keys, bet_amt, MarketOutcome::No);
    assert_logs_contain(
        env.bet_raw_min_out(&keys, &trader, bet_amt, MarketOutcome::No, quoted_bet2 + 1),
        "SlippageExceeded",
    );
}

#[test]
fn e_add_liquidity_asymmetric_after_skew() {
    let req = json!({
        "seed": SEED,
        "duration": LIFE,
        "start_ts": START,
        "ops": [
            {"op": "create"},
            {"op": "bet", "wallet": "trader", "amount": 200_000, "side": "yes"},
            {"op": "add_liquidity", "wallet": "extra", "amount": 500_000}
        ]
    });
    let sim = python_sim(&req);
    let st = &sim["steps"][2];
    let yes_in = f64_of(&st["yes_in"]);
    let no_in = f64_of(&st["no_in"]);
    let add_shares = f64_of(&st["add_shares"]);
    assert!(
        (yes_in - no_in).abs() > 0.5,
        "skewed add must deposit unequal yes/no vs python"
    );

    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let trader = env.fund_user(400_000);
    env.bet(&keys, &trader, 200_000, MarketOutcome::Yes);
    let m0 = env.read_market(&keys);
    assert!(
        m0.reserve_yes != m0.reserve_no,
        "yes bet must skew working reserves"
    );
    let amount = 500_000u64;
    let extra = env.fund_user(amount);
    let pool_yes0 = env.token_amount(keys.yes_pool);
    let pool_no0 = env.token_amount(keys.no_pool);
    env.add_liquidity(&keys, &extra, amount);
    let dy = (env.token_amount(keys.yes_pool) - pool_yes0) as f64;
    let dn = (env.token_amount(keys.no_pool) - pool_no0) as f64;
    env.ledger(&keys, "e_add_after_skew").assert_ok();
    assert_close(dy, yes_in, 0.0, "e_add pool yes_in vs python");
    assert_close(dn, no_in, 0.0, "e_add pool no_in vs python");
    assert_close(
        env.token_amount(ata(extra.pk(), keys.yes_mint)) as f64,
        amount as f64 - yes_in,
        0.0,
        "e_add leftover yes vs python",
    );
    assert_close(
        env.token_amount(ata(extra.pk(), keys.no_mint)) as f64,
        amount as f64 - no_in,
        0.0,
        "e_add leftover no vs python",
    );
    let pos = env.read_lp(&keys, extra.pk()).unwrap();
    assert_close(
        bits_f64(pos.shares),
        add_shares,
        0.01,
        "e_add shares vs python",
    );
}

#[test]
fn p_random_walk_invariants() {
    let mut rng = 0xC0FFEE_u64;
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let trader = env.fund_user(80_000_000);
    let lp = env.fund_user(20_000_000);
    env.add_liquidity(&keys, &lp, 3_000_000);
    env.ensure_ata(trader.pk(), keys.yes_mint);
    env.ensure_ata(trader.pk(), keys.no_mint);
    let mut applied = 0u32;
    for i in 0..60 {
        let roll = mix64(&mut rng) % 7;
        let amt = 1_000 + (mix64(&mut rng) % 40_000);
        let res = match roll {
            0 => env.bet_raw(&keys, &trader, amt, MarketOutcome::Yes),
            1 => env.bet_raw(&keys, &trader, amt, MarketOutcome::No),
            2 => {
                let have = env.token_amount(ata(trader.pk(), keys.no_mint));
                if have < 2 {
                    continue;
                }
                let sell = amt.min(have / 2).max(1);
                env.swap_raw(&keys, &trader, sell, MarketOutcome::Yes)
            }
            3 => {
                let have = env.token_amount(ata(trader.pk(), keys.yes_mint));
                if have < 2 {
                    continue;
                }
                let sell = amt.min(have / 2).max(1);
                env.swap_raw(&keys, &trader, sell, MarketOutcome::No)
            }
            4 => env.add_liquidity_raw(&keys, &lp, amt),
            5 => {
                let Some(pos) = env.read_lp(&keys, lp.pk()) else {
                    continue;
                };
                let shares = bits_f64(pos.shares);
                if shares < 10_000.0 {
                    continue;
                }
                let take = (amt as f64).min(shares * 0.05).max(1.0) as u64;
                env.withdraw_raw(&keys, &lp, take)
            }
            _ => {
                let yes = env.token_amount(ata(trader.pk(), keys.yes_mint));
                let no = env.token_amount(ata(trader.pk(), keys.no_mint));
                let have = yes.min(no);
                if have < 2 {
                    continue;
                }
                let take = amt.min(have / 2).max(1);
                env.merge_raw(&keys, &trader, take)
            }
        };
        res.unwrap_or_else(|e| {
            panic!(
                "random walk step {i} failed unexpectedly: {:?}\n{}",
                e.err,
                e.meta.logs.join("\n")
            )
        });
        env.ops += 1;
        applied += 1;
        let l = env.ledger(&keys, &format!("walk{i}"));
        l.assert_walk_ok(20.0, 2.0);
    }
    println!("random walk applied={applied}/60 clock={}", env.clock);
    assert!(applied >= 20, "random walk applied too few ops: {applied}");
}

#[test]
fn d_create_rejects_token_2022_and_wrong_state_owner() {
    let mut env = Env::new(START);
    let mint_2022 = env.create_mint_with(TOKEN_2022_PROGRAM, DECIMALS);
    env.mint_to_with(env.house_pk(), mint_2022, TOKEN_2022_PROGRAM, SEED * 2);
    let (_keys, res) = env.create_market_with_mint(
        SEED,
        (env.clock + LIFE) as u64,
        true,
        prediction_market::ALLOWED_FEEDS[0].state,
        mint_2022,
        TOKEN_2022_PROGRAM,
    );
    assert_logs_contain(res, "InvalidMint");

    env.ensure_feeds();
    env.set_account_owner(prediction_market::ALLOWED_FEEDS[0].state, SYSTEM_PROGRAM);
    let (_keys, res) = env.create_market_raw(SEED, LIFE, true);
    assert_logs_fail(res, &["ConstraintOwner", "owner constraint was violated"]);
}

#[test]
fn d_create_supports_all_six_allowlisted_feeds_and_varied_decimals() {
    let mut env = Env::new(START);
    env.install_all_feeds();
    for feed in prediction_market::ALLOWED_FEEDS {
        let keys = env.create_market_on_state(SEED, 3_600, true, feed.state);
        let m = env.read_market(&keys);
        assert_eq!(m.ocr2_state, feed.state);
        assert_eq!(m.decimals, 8);
        env.ledger(&keys, &format!("feed_{}", feed.name)).assert_ok();
    }

    for dec in [0u8, 9u8] {
        let mut env = Env::new_with_decimals(START, dec);
        let keys = env.create_market(SEED, 3_600, true);
        let yes_acc = env.svm.get_account(&addr(keys.yes_mint)).unwrap();
        let no_acc = env.svm.get_account(&addr(keys.no_mint)).unwrap();
        assert_eq!(
            <spl_token_interface::state::Mint as solana_program_pack::Pack>::unpack(&yes_acc.data)
                .unwrap()
                .decimals,
            dec
        );
        assert_eq!(
            <spl_token_interface::state::Mint as solana_program_pack::Pack>::unpack(&no_acc.data)
                .unwrap()
                .decimals,
            dec
        );

        let trader = env.fund_user(500_000);
        env.bet(&keys, &trader, 100_000, MarketOutcome::Yes);
        env.bet(&keys, &trader, 50_000, MarketOutcome::No);
        env.swap(&keys, &trader, 10_000, MarketOutcome::No);
        let merge_amt = env
            .token_amount(ata(trader.pk(), keys.yes_mint))
            .min(env.token_amount(ata(trader.pk(), keys.no_mint)))
            .min(5_000);
        assert!(merge_amt > 0);
        env.merge(&keys, &trader, merge_amt);
        env.ledger(&keys, &format!("dec_{dec}_open")).assert_ok();

        env.warp(keys.expiry as i64 + 2);
        queue_first(&mut env, &keys, keys.threshold + 1, 2);
        env.resolve(&keys);
        env.ledger(&keys, &format!("dec_{dec}_resolved")).assert_ok();

        let win = env.token_amount(ata(trader.pk(), keys.yes_mint));
        assert!(win > 0);
        let coll0 = env.token_amount(ata(trader.pk(), env.mint));
        env.redeem(&keys, &trader, keys.yes_mint, win);
        assert_eq!(env.token_amount(ata(trader.pk(), env.mint)) - coll0, win);
        env.ledger(&keys, &format!("dec_{dec}_redeemed")).assert_ok();
    }
}

#[test]
fn j_account_substitution_matrix() {
    let mut env = Env::new(START);
    let a = env.create_market(SEED, 3_600, true);
    let b = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(500_000);
    let other = env.fund_user(500_000);
    let lp = env.fund_user(3_000_000);

    env.bet(&a, &trader, 100_000, MarketOutcome::Yes);
    env.bet(&a, &trader, 30_000, MarketOutcome::No);

    // bet with another user's collateral_ata
    assert_logs_fail(
        env.bet_raw_accounts(
            &a,
            &trader,
            ata(other.pk(), env.mint),
            a.vault,
            10_000,
            MarketOutcome::Yes,
            1,
        ),
        &["ConstraintTokenOwner", "owner constraint was violated"],
    );
    // bet with foreign market's vault
    assert_logs_fail(
        env.bet_raw_accounts(
            &a,
            &trader,
            ata(trader.pk(), env.mint),
            b.vault,
            10_000,
            MarketOutcome::Yes,
            1,
        ),
        &[
            "ConstraintSeeds",
            "seeds constraint",
            "A seeds constraint was violated",
        ],
    );

    // add_liquidity with foreign yes_pool
    assert_logs_fail(
        env.add_liquidity_raw_accounts(
            &a,
            &lp,
            a.lp_position(lp.pk()),
            env.mint,
            b.yes_pool,
            a.no_pool,
            100_000,
        ),
        &[
            "ConstraintSeeds",
            "seeds constraint",
            "A seeds constraint was violated",
        ],
    );
    // add_liquidity with wrong collateral_mint
    let wrong_mint = env.extra_mint();
    env.ensure_ata(lp.pk(), wrong_mint);
    assert_logs_fail(
        env.add_liquidity_raw_accounts(
            &a,
            &lp,
            a.lp_position(lp.pk()),
            wrong_mint,
            a.yes_pool,
            a.no_pool,
            100_000,
        ),
        &[
            "ConstraintTokenMint",
            "ConstraintAssociatedToken",
            "token_mint",
        ],
    );

    // merge with yes >= amt but no < amt -> InsufficientBalance
    let yes_bal = env.token_amount(ata(trader.pk(), a.yes_mint));
    let no_bal = env.token_amount(ata(trader.pk(), a.no_mint));
    assert!(yes_bal > no_bal);
    assert_logs_contain(
        env.merge_raw(&a, &trader, no_bal + 1),
        "InsufficientBalance",
    );
    // merge with another user's yes_token_ata
    env.ensure_ata(other.pk(), a.yes_mint);
    assert_logs_fail(
        env.merge_raw_accounts(
            &a,
            &trader,
            ata(trader.pk(), env.mint),
            a.vault,
            ata(other.pk(), a.yes_mint),
            ata(trader.pk(), a.no_mint),
            1,
        ),
        &[
            "ConstraintAssociatedToken",
            "ConstraintTokenOwner",
            "associated token",
        ],
    );

    // burn_account with foreign snapshot PDA and double-burn rejection
    env.warp(a.expiry as i64 + 2);
    queue_first(&mut env, &a, a.threshold + 1, 2);
    env.resolve(&a);
    queue_first(&mut env, &b, b.threshold + 1, 2);
    env.resolve(&b);

    let finish = env.read_market(&a).finish_ts;
    env.warp(finish as i64 + CLAIM_WINDOW as i64 + 1);
    let house = env.house_actor();
    assert_logs_fail(
        env.burn_account_raw_accounts(&a, &house, b.snapshot, a.vault),
        &[
            "ConstraintSeeds",
            "seeds constraint",
            "A seeds constraint was violated",
        ],
    );
    env.burn_account(&a, &house);
    assert_logs_fail(
        env.burn_account_raw(&a, &house),
        &[
            "AccountNotInitialized",
            "account not found",
            "Custom(3012)",
            "3012",
        ],
    );
}

#[test]
fn j_dust_and_near_expiry_edge_cases() {
    // 1. Near-expiry (T-1s) bet, swap, add_liquidity, withdraw
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(500_000);
    let lp = env.fund_user(500_000);
    env.warp(keys.expiry as i64 - 1);
    env.bet(&keys, &trader, 20_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 10_000, MarketOutcome::No);
    env.swap(&keys, &trader, 2_000, MarketOutcome::Yes);
    env.add_liquidity(&keys, &lp, 100_000);
    env.withdraw(&keys, &lp, 10_000);
    env.ledger(&keys, "near_expiry").assert_ok();

    // 2. Deep skew (P > 0.9999) + warp + withdraw(1): reserves must not inflate
    let mut env = Env::new(START);
    let keys = env.create_market(1_000_001, LIFE, true);
    let house = env.house_actor();
    let whale = env.fund_user(20_000_000);
    loop {
        let m = env.read_market(&keys);
        let l_eff = l_effective(m.l_zero_fixed(), m.end_ts - env.clock).unwrap();
        let p: f64 = price_from_reserves(m.reserve_yes_fixed(), m.reserve_no_fixed(), l_eff)
            .unwrap()
            .to_num();
        if p > 0.9999 {
            break;
        }
        env.bet(&keys, &whale, 500_000, MarketOutcome::Yes);
    }
    let before = env.read_market(&keys);
    env.warp(START + LIFE / 2);
    env.withdraw(&keys, &house, 1);
    let after = env.read_market(&keys);
    assert!(
        after.reserve_yes_fixed() <= before.reserve_yes_fixed()
            && after.reserve_no_fixed() <= before.reserve_no_fixed(),
        "clamped-price accrual must not inflate working reserves"
    );
    env.ledger(&keys, "deep_skew_accrual_wd").assert_backing();

    // 3. Zero add_liquidity(0) -> InvalidAmount, while skewed add_liquidity(1) rounds minor-side input up to 1
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let trader = env.fund_user(500_000);
    let lp = env.fund_user(100_000);
    env.bet(&keys, &trader, 200_000, MarketOutcome::Yes);
    assert_logs_contain(env.add_liquidity_raw(&keys, &lp, 0), "InvalidAmount");
    env.add_liquidity(&keys, &lp, 1);
    env.ledger(&keys, "skewed_add_1").assert_backing();

    // 4. Deeply skewed swap(1, Yes) with min_out=0 where output floors to 0 -> SlippageExceeded
    let mut env = Env::new(START);
    let keys = env.create_market(1_000_001, LIFE, true);
    let whale = env.fund_user(5_000_000);
    let trader2 = env.fund_user(10_000);
    env.bet(&keys, &whale, 2_000_000, MarketOutcome::Yes);
    env.bet(&keys, &trader2, 1_000, MarketOutcome::No);
    assert_logs_contain(
        env.swap_raw_ex(
            &keys,
            &trader2,
            1,
            MarketOutcome::Yes,
            0,
            ata(trader2.pk(), keys.yes_mint),
            ata(trader2.pk(), keys.no_mint),
        ),
        "SlippageExceeded",
    );
}
