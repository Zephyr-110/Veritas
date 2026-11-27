//! Completeness net for settlement and economic security.
//! Program code is not modified. These tests lock the README spec:
//! Open markets are 1:1 complete-set backed; an OCR2 pair straddling
//! expiry settles or stale-voids; entitled payouts are exact through the
//! claim window; leftover collateral after CLAIM_WINDOW goes to the house.
//! Reports are signed by harness/chainlink.rs. Captured Chainlink bytes
//! are in ocr2_settle.
mod harness;

use harness::*;
use prediction_market::state::{MarketOutcome, MarketStatus};
use serde_json::json;

const START: i64 = 1_700_000_000;
const LIFE: i64 = 7 * 86_400;
const SEED: u64 = 10_000_000;

fn queue_first(env: &mut Env, keys: &MarketKeys, price: i64, delay: i64) {
    env.queue_ocr2_reports(price, keys.expiry as i64 + delay, keys.expiry as i64 - 1);
}

fn resolve_with(env: &mut Env, keys: &MarketKeys, price: i64, delay: i64) {
    env.warp(keys.expiry as i64 + delay.max(0));
    queue_first(env, keys, price, delay);
    env.resolve(keys);
}

fn resolve_yes(env: &mut Env, keys: &MarketKeys) {
    resolve_with(env, keys, keys.threshold + 1, 2);
    let m = env.read_market(keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(MarketOutcome::Yes));
}

fn resolve_no(env: &mut Env, keys: &MarketKeys) {
    resolve_with(env, keys, keys.threshold - 1, 2);
    let m = env.read_market(keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(MarketOutcome::No));
}

fn void_market(env: &mut Env, keys: &MarketKeys) {
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    env.void_market(keys);
    let m = env.read_market(keys);
    assert_eq!(m.status, MarketStatus::WindowBurn);
    assert_eq!(m.winner, None);
}

fn coll(env: &Env, user: &Actor) -> u64 {
    env.token_amount(ata(user.pk(), env.mint))
}

fn tok(env: &Env, user: &Actor, mint: anchor_lang::prelude::Pubkey) -> u64 {
    env.token_amount(ata(user.pk(), mint))
}

fn redeem_all(
    env: &mut Env,
    keys: &MarketKeys,
    user: &Actor,
    mint: anchor_lang::prelude::Pubkey,
) -> u64 {
    let amt = tok(env, user, mint);
    if amt == 0 {
        return 0;
    }
    let before = coll(env, user);
    env.redeem(keys, user, mint, amt);
    coll(env, user) - before
}

fn assert_trades_dead(env: &mut Env, keys: &MarketKeys, trader: &Actor, lp: &Actor, needle: &str) {
    assert_logs_contain(env.bet_raw(keys, trader, 1_000, MarketOutcome::Yes), needle);
    assert_logs_contain(env.swap_raw(keys, trader, 1, MarketOutcome::No), needle);
    assert_logs_contain(env.add_liquidity_raw(keys, lp, 1_000), needle);
}

#[test]
fn s_constants_locked() {
    assert_eq!(prediction_market::SERVICE_FEE, 50);
    assert_eq!(prediction_market::FEE_INCREMENTAL, 250);
    assert_eq!(prediction_market::RESOLVE_WINDOW, 172_800);
    assert_eq!(prediction_market::MAX_SETTLE_DELAY, 10);
    assert_eq!(prediction_market::CLAIM_WINDOW, 2_592_000);
    assert_eq!(RESOLVE_WINDOW, prediction_market::RESOLVE_WINDOW);
    assert_eq!(MAX_SETTLE_DELAY, prediction_market::MAX_SETTLE_DELAY);
    assert_eq!(CLAIM_WINDOW, prediction_market::CLAIM_WINDOW);
}

#[test]
fn s_publish_time_before_expiry_rejected() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    env.warp(keys.expiry as i64 + 5);
    env.queue_ocr2_reports(
        keys.threshold + 1,
        keys.expiry as i64 - 1,
        keys.expiry as i64 - 2,
    );
    assert_logs_contain(env.resolve_raw(&keys), "NotFirstAfterExpiry");
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Open);
    assert_eq!(m.winner, None);
    assert_eq!(m.finish_ts, 0);
    env.ledger(&keys, "s_print_before_expiry").assert_ok();
}

#[test]
fn s_equal_threshold_settle_above_false_is_no() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, false);
    resolve_with(&mut env, &keys, keys.threshold, 2);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(MarketOutcome::No));
    assert_eq!(m.settled_price, keys.threshold);
}

#[test]
fn s_negative_price_below_threshold_is_no() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    resolve_with(&mut env, &keys, -1, 2);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(MarketOutcome::No));
    assert_eq!(m.settled_price, -1);
}

#[test]
fn s_late_print_is_stale_inside_48h_clock() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let delay = MAX_SETTLE_DELAY + 1;
    env.warp(keys.expiry as i64 + delay);
    queue_first(&mut env, &keys, keys.threshold + 1, delay);
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
    assert_eq!(m.finish_ts, keys.expiry + delay as u64);
    assert!(m.finish_ts < keys.expiry + RESOLVE_WINDOW);
}

#[test]
fn s_window_burn_does_not_store_price() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    void_market(&mut env, &keys);
    let m = env.read_market(&keys);
    assert_eq!(m.settled_price, 0);
    assert_eq!(m.settled_publish_time, 0);
    assert_eq!(m.winner, None);
    assert_eq!(m.finish_ts, keys.expiry + RESOLVE_WINDOW + 1);
}

#[test]
fn s_resolve_twice_and_void_after_resolve_rejected() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    resolve_yes(&mut env, &keys);
    queue_first(&mut env, &keys, keys.threshold + 2, 3);
    assert_logs_contain(env.resolve_raw(&keys), "MarketNotOpen");
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    assert_logs_contain(env.void_raw(&keys), "MarketNotOpen");
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(MarketOutcome::Yes));
}

#[test]
fn s_redeem_while_open_or_expired_open_rejected() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(80_000);
    env.bet(&keys, &trader, 20_000, MarketOutcome::Yes);
    assert_logs_contain(
        env.redeem_raw(&keys, &trader, keys.yes_mint, 1),
        "MarketNotResolved",
    );
    env.warp(keys.expiry as i64 + 1);
    assert_logs_contain(
        env.redeem_raw(&keys, &trader, keys.yes_mint, 1),
        "MarketNotResolved",
    );
    assert_eq!(env.read_market(&keys).status, MarketStatus::Open);
}

#[test]
fn s_terminal_states_block_trade_and_merge() {
    for kind in ["resolved", "stale", "window"] {
        let mut env = Env::new(START);
        let keys = env.create_market(SEED, 3_600, true);
        let trader = env.fund_user(120_000);
        let lp = env.fund_user(1_500_000);
        env.bet(&keys, &trader, 30_000, MarketOutcome::Yes);
        env.bet(&keys, &trader, 20_000, MarketOutcome::No);
        env.add_liquidity(&keys, &lp, 1_000_000);
        match kind {
            "resolved" => resolve_yes(&mut env, &keys),
            "stale" => {
                let delay = MAX_SETTLE_DELAY + 5;
                env.warp(keys.expiry as i64 + delay);
                queue_first(&mut env, &keys, keys.threshold + 1, delay);
                env.resolve(&keys);
                assert_eq!(env.read_market(&keys).status, MarketStatus::StaleBurn);
            }
            _ => void_market(&mut env, &keys),
        }
        assert_trades_dead(&mut env, &keys, &trader, &lp, "MarketNotOpen");
        assert_logs_contain(env.merge_raw(&keys, &trader, 1), "MarketNotTradable");
        env.ledger(&keys, &format!("s_terminal_{kind}")).assert_ok();
    }
}

#[test]
fn s_finish_ts_equals_clock() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    resolve_yes(&mut env, &keys);
    let m = env.read_market(&keys);
    assert_eq!(m.finish_ts, env.clock as u64);
    assert_eq!(m.finish_ts, keys.expiry + 2);
}

#[test]
fn e_open_ops_keep_exact_complete_set_backing() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    env.ledger(&keys, "create").assert_ok();
    let trader = env.fund_user(2_000_000);
    let lp = env.fund_user(3_000_000);
    env.bet(&keys, &trader, 400_000, MarketOutcome::Yes);
    env.ledger(&keys, "bet_yes").assert_ok();
    env.bet(&keys, &trader, 250_000, MarketOutcome::No);
    env.ledger(&keys, "bet_no").assert_ok();
    env.swap(&keys, &trader, 20_000, MarketOutcome::No);
    env.ledger(&keys, "swap").assert_ok();
    env.add_liquidity(&keys, &lp, 1_000_000);
    env.ledger(&keys, "add_lp").assert_ok();
    env.merge(&keys, &trader, 10_000);
    env.ledger(&keys, "merge").assert_ok();
    env.withdraw(&keys, &lp, 100_000);
    env.ledger(&keys, "wd").assert_ok();
}

#[test]
fn e_swap_does_not_touch_vault_or_supply() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(400_000);
    env.bet(&keys, &trader, 80_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 60_000, MarketOutcome::No);
    let vault = env.token_amount(keys.vault);
    let yes = env.mint_supply(keys.yes_mint);
    let no = env.mint_supply(keys.no_mint);
    env.swap(&keys, &trader, 5_000, MarketOutcome::No);
    assert_eq!(env.token_amount(keys.vault), vault);
    assert_eq!(env.mint_supply(keys.yes_mint), yes);
    assert_eq!(env.mint_supply(keys.no_mint), no);
    env.ledger(&keys, "e_swap_vault").assert_ok();
}

#[test]
fn e_bet_and_merge_move_vault_with_the_pair() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(500_000);
    let vault0 = env.token_amount(keys.vault);
    let yes0 = env.mint_supply(keys.yes_mint);
    env.bet(&keys, &trader, 40_000, MarketOutcome::Yes);
    assert_eq!(env.token_amount(keys.vault) - vault0, 40_000);
    assert_eq!(env.mint_supply(keys.yes_mint) - yes0, 40_000);
    assert_eq!(env.mint_supply(keys.no_mint) - yes0, 40_000);
    env.bet(&keys, &trader, 30_000, MarketOutcome::No);
    let vault1 = env.token_amount(keys.vault);
    let have = tok(&env, &trader, keys.yes_mint).min(tok(&env, &trader, keys.no_mint));
    assert!(have >= 1);
    let take = have.min(5_000);
    let c0 = coll(&env, &trader);
    env.merge(&keys, &trader, take);
    assert_eq!(coll(&env, &trader) - c0, take);
    assert_eq!(vault1 - env.token_amount(keys.vault), take);
    env.ledger(&keys, "e_bet_merge").assert_ok();
}

#[test]
fn e_two_yes_winners_both_paid_1_to_1() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let a = env.fund_user(300_000);
    let b = env.fund_user(300_000);
    env.bet(&keys, &a, 50_000, MarketOutcome::Yes);
    env.bet(&keys, &b, 70_000, MarketOutcome::Yes);
    resolve_yes(&mut env, &keys);
    env.ledger(&keys, "e_two_winners_resolved").assert_ok();
    let a_win = tok(&env, &a, keys.yes_mint);
    let b_win = tok(&env, &b, keys.yes_mint);
    assert!(a_win > 0 && b_win > 0);
    let a_got = redeem_all(&mut env, &keys, &a, keys.yes_mint);
    let b_got = redeem_all(&mut env, &keys, &b, keys.yes_mint);
    assert_eq!(
        a_got, a_win,
        "first winner must be paid 1:1, not shorted by the second"
    );
    assert_eq!(b_got, b_win, "second winner must be paid 1:1");
    env.ledger(&keys, "e_two_winners_after").assert_ok();
}

#[test]
fn e_no_winner_paid_1_to_1() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 40_000, MarketOutcome::No);
    resolve_no(&mut env, &keys);
    assert_logs_contain(
        env.redeem_raw(&keys, &trader, keys.yes_mint, 1),
        "NotWinnerMint",
    );
    let have = tok(&env, &trader, keys.no_mint);
    let got = redeem_all(&mut env, &keys, &trader, keys.no_mint);
    assert_eq!(got, have);
    env.ledger(&keys, "e_no_winner").assert_ok();
}

#[test]
fn e_cannot_over_redeem_or_pay_loser() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 40_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 30_000, MarketOutcome::No);
    resolve_yes(&mut env, &keys);
    let have = tok(&env, &trader, keys.yes_mint);
    assert_logs_fail(
        env.redeem_raw(&keys, &trader, keys.yes_mint, have + 1),
        &[
            "InsufficientBalance",
            "insufficient funds",
            "custom program error: 0x1",
        ],
    );
    let loser = tok(&env, &trader, keys.no_mint).min(10).max(1);
    assert_logs_contain(
        env.redeem_raw(&keys, &trader, keys.no_mint, loser),
        "NotWinnerMint",
    );
}

#[test]
fn e_void_floor_table() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(400_000);
    env.bet(&keys, &trader, 80_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 80_000, MarketOutcome::No);
    void_market(&mut env, &keys);
    for amt in [2u64, 3, 4, 5, 7] {
        let expect = amt / 2;
        let before = coll(&env, &trader);
        env.redeem(&keys, &trader, keys.yes_mint, amt);
        assert_eq!(
            coll(&env, &trader) - before,
            expect,
            "void yes {amt} must pay floor/2={expect}"
        );
        let before = coll(&env, &trader);
        env.redeem(&keys, &trader, keys.no_mint, amt);
        assert_eq!(
            coll(&env, &trader) - before,
            expect,
            "void no {amt} must pay floor/2={expect}"
        );
        env.ledger(&keys, &format!("e_void_floor_{amt}"))
            .assert_ok();
    }
    assert_logs_contain(
        env.redeem_raw(&keys, &trader, keys.yes_mint, 1),
        "InvalidAmount",
    );
}

#[test]
fn e_stale_payout_matches_void_floor() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 40_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 40_000, MarketOutcome::No);
    let delay = MAX_SETTLE_DELAY + 4;
    env.warp(keys.expiry as i64 + delay);
    queue_first(&mut env, &keys, keys.threshold + 1, delay);
    env.resolve(&keys);
    assert_eq!(env.read_market(&keys).status, MarketStatus::StaleBurn);
    let before = coll(&env, &trader);
    env.redeem(&keys, &trader, keys.yes_mint, 5);
    assert_eq!(coll(&env, &trader) - before, 2);
    env.ledger(&keys, "e_stale_floor").assert_ok();
}

#[test]
fn e_lp_withdraw_does_not_move_vault() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let lp = env.fund_user(2_000_000);
    env.add_liquidity(&keys, &lp, 2_000_000);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 50_000, MarketOutcome::Yes);
    let vault = env.token_amount(keys.vault);
    env.withdraw(&keys, &lp, 400_000);
    assert_eq!(
        env.token_amount(keys.vault),
        vault,
        "withdraw moves outcome tokens, not collateral"
    );
    env.ledger(&keys, "e_lp_wd_vault").assert_ok();
}

#[test]
fn e_two_lps_cannot_withdraw_each_other() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let lp1 = env.fund_user(2_000_000);
    let lp2 = env.fund_user(2_000_000);
    env.add_liquidity(&keys, &lp1, 1_500_000);
    env.add_liquidity(&keys, &lp2, 1_500_000);
    let stranger = env.fund_user(10_000);
    assert_logs_fail(
        env.withdraw_raw(&keys, &stranger, 1),
        &["AccountNotInitialized", "already initialized"],
    );
    // Real cross-LP account substitution: pass lp1's initialized PDA while signing as stranger or lp2.
    assert_logs_fail(
        env.withdraw_raw_position(&keys, &stranger, keys.lp_position(lp1.pk()), 1),
        &[
            "ConstraintSeeds",
            "seeds constraint",
            "A seeds constraint was violated",
        ],
    );
    assert_logs_fail(
        env.withdraw_raw_position(&keys, &lp2, keys.lp_position(lp1.pk()), 1),
        &[
            "ConstraintSeeds",
            "seeds constraint",
            "A seeds constraint was violated",
        ],
    );
    let s1 = bits_f64(env.read_lp(&keys, lp1.pk()).unwrap().shares);
    env.withdraw(&keys, &lp2, 100_000);
    let s1_after = bits_f64(env.read_lp(&keys, lp1.pk()).unwrap().shares);
    assert_eq!(s1_after, s1, "lp2 withdraw must not change lp1 shares");
    env.ledger(&keys, "e_lp_isolated").assert_ok();
}

#[test]
fn e_foreign_market_cannot_pay() {
    let mut env = Env::new(START);
    let a = env.create_market(SEED, 3_600, true);
    let b = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&a, &trader, 30_000, MarketOutcome::Yes);
    env.bet(&b, &trader, 30_000, MarketOutcome::Yes);
    resolve_yes(&mut env, &a);
    resolve_yes(&mut env, &b);
    assert_logs_contain(env.redeem_raw(&b, &trader, a.yes_mint, 1), "InvalidMint");
    assert_logs_fail(
        env.redeem_raw_accounts(
            &a,
            &trader,
            a.yes_mint,
            ata(trader.pk(), a.yes_mint),
            b.vault,
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
fn e_full_winner_claim_keeps_vault_eq_remaining_yes() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(400_000);
    let lp = env.fund_user(2_000_000);
    env.add_liquidity(&keys, &lp, 2_000_000);
    env.bet(&keys, &trader, 80_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 50_000, MarketOutcome::No);
    resolve_yes(&mut env, &keys);
    let house = env.house_actor();
    env.withdraw(&keys, &lp, u64::MAX);
    env.withdraw(&keys, &house, u64::MAX);
    env.ledger(&keys, "e_full_claim_after_lp").assert_ok();
    let t = tok(&env, &trader, keys.yes_mint);
    let l = tok(&env, &lp, keys.yes_mint);
    let h = tok(&env, &house, keys.yes_mint);
    assert_eq!(redeem_all(&mut env, &keys, &trader, keys.yes_mint), t);
    assert_eq!(redeem_all(&mut env, &keys, &lp, keys.yes_mint), l);
    assert_eq!(redeem_all(&mut env, &keys, &house, keys.yes_mint), h);
    env.ledger(&keys, "e_full_claim_after_redeem").assert_ok();
    assert_eq!(tok(&env, &trader, keys.yes_mint), 0);
    assert_eq!(tok(&env, &lp, keys.yes_mint), 0);
    assert_eq!(tok(&env, &house, keys.yes_mint), 0);
    let leftover = env.mint_supply(keys.yes_mint);
    assert_eq!(env.token_amount(keys.vault), leftover);
    assert!(
        leftover <= 8,
        "after all wallets redeem, leftover yes {leftover} should be pool dust"
    );
}

#[test]
fn e_full_void_claim_never_insolvent() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(400_000);
    env.bet(&keys, &trader, 90_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 70_000, MarketOutcome::No);
    void_market(&mut env, &keys);
    let house = env.house_actor();
    env.withdraw(&keys, &house, u64::MAX);
    env.ledger(&keys, "e_void_after_lp").assert_ok();
    for user in [&trader, &house] {
        let yes = tok(&env, user, keys.yes_mint);
        if yes >= 2 {
            let before = coll(&env, user);
            env.redeem(&keys, user, keys.yes_mint, yes);
            assert_eq!(coll(&env, user) - before, yes / 2);
        }
        let no = tok(&env, user, keys.no_mint);
        if no >= 2 {
            let before = coll(&env, user);
            env.redeem(&keys, user, keys.no_mint, no);
            assert_eq!(coll(&env, user) - before, no / 2);
        }
    }
    env.ledger(&keys, "e_void_after_full_claim").assert_ok();
}

#[test]
fn e_claim_window_last_tick_still_pays() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 40_000, MarketOutcome::Yes);
    resolve_yes(&mut env, &keys);
    let finish = env.read_market(&keys).finish_ts;
    env.warp(finish as i64 + CLAIM_WINDOW as i64);
    assert_logs_contain(
        env.burn_account_raw(&keys, &env.house_actor()),
        "NoArriveFinishTS",
    );
    let have = tok(&env, &trader, keys.yes_mint);
    let got = redeem_all(&mut env, &keys, &trader, keys.yes_mint);
    assert_eq!(got, have, "exact CLAIM_WINDOW tick must still pay 1:1");
    env.ledger(&keys, "e_last_tick").assert_ok();
}

#[test]
fn e_sweep_blocked_in_claim_window() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 40_000, MarketOutcome::Yes);
    resolve_yes(&mut env, &keys);
    let house = env.house_actor();
    assert_logs_contain(env.burn_account_raw(&keys, &house), "NoArriveFinishTS");
    let stranger = env.fund_user(10_000);
    env.warp(env.read_market(&keys).finish_ts as i64 + CLAIM_WINDOW as i64 + 1);
    assert_logs_contain(env.burn_account_raw(&keys, &stranger), "NoCreator");
    assert!(env.account_alive(keys.vault));
    assert!(tok(&env, &trader, keys.yes_mint) > 0);
}

#[test]
fn e_unredeemed_forfeit_after_claim_window() {
    // README spec: after CLAIM_WINDOW the creator sweeps leftover vault.
    // Unclaimed tokens are then unredeemable because accounts close.
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 40_000, MarketOutcome::Yes);
    resolve_yes(&mut env, &keys);
    let have = tok(&env, &trader, keys.yes_mint);
    assert!(have > 0);
    let vault = env.token_amount(keys.vault);
    let house = env.house_actor();
    let house_before = coll(&env, &house);
    env.warp(env.read_market(&keys).finish_ts as i64 + CLAIM_WINDOW as i64 + 1);
    env.burn_account(&keys, &house);
    assert_eq!(coll(&env, &house) - house_before, vault);
    assert!(!env.account_alive(keys.vault));
    assert!(!env.account_alive(keys.market));
    assert_eq!(
        tok(&env, &trader, keys.yes_mint),
        have,
        "user tokens remain in the wallet"
    );
    let err = env
        .redeem_raw(&keys, &trader, keys.yes_mint, have)
        .expect_err("redeem after sweep must fail");
    let blob = format!("{:?}\n{}", err.err, err.meta.logs.join("\n"));
    assert!(
        blob.contains("AccountNotInitialized")
            || blob.contains("account not found")
            || blob.contains("Custom(3012)")
            || blob.contains("3012"),
        "expected closed-account redeem failure, got {blob}"
    );
}

#[test]
fn e_full_claim_then_sweep_only_dust() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, 3_600, true);
    let trader = env.fund_user(300_000);
    env.bet(&keys, &trader, 50_000, MarketOutcome::Yes);
    resolve_yes(&mut env, &keys);
    let house = env.house_actor();
    env.withdraw(&keys, &house, u64::MAX);
    let _ = redeem_all(&mut env, &keys, &trader, keys.yes_mint);
    let _ = redeem_all(&mut env, &keys, &house, keys.yes_mint);
    env.ledger(&keys, "e_dust_before_sweep").assert_ok();
    let leftover = env.token_amount(keys.vault);
    assert_eq!(leftover, env.mint_supply(keys.yes_mint));
    assert!(
        leftover <= 8,
        "house sweep after full claim should be dust, got {leftover}"
    );
    env.warp(env.read_market(&keys).finish_ts as i64 + CLAIM_WINDOW as i64 + 1);
    let before = coll(&env, &house);
    env.burn_account(&keys, &house);
    assert_eq!(coll(&env, &house) - before, leftover);
}

#[test]
fn e_walk_open_backing_then_settle_and_claim() {
    let mut rng = 0xA5A5_u64;
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let trader = env.fund_user(40_000_000);
    let lp = env.fund_user(10_000_000);
    env.add_liquidity(&keys, &lp, 2_000_000);
    env.ensure_ata(trader.pk(), keys.yes_mint);
    env.ensure_ata(trader.pk(), keys.no_mint);
    let mut applied = 0u32;
    for i in 0..40 {
        let roll = mix64(&mut rng) % 7;
        let amt = 1_000 + (mix64(&mut rng) % 25_000);
        let res = match roll {
            0 => env.bet_raw(&keys, &trader, amt, MarketOutcome::Yes),
            1 => env.bet_raw(&keys, &trader, amt, MarketOutcome::No),
            2 => {
                let have = tok(&env, &trader, keys.no_mint);
                if have < 2 {
                    continue;
                }
                env.swap_raw(&keys, &trader, amt.min(have / 2).max(1), MarketOutcome::Yes)
            }
            3 => {
                let have = tok(&env, &trader, keys.yes_mint);
                if have < 2 {
                    continue;
                }
                env.swap_raw(&keys, &trader, amt.min(have / 2).max(1), MarketOutcome::No)
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
                env.withdraw_raw(&keys, &lp, (amt as f64).min(shares * 0.05).max(1.0) as u64)
            }
            _ => {
                let have = tok(&env, &trader, keys.yes_mint).min(tok(&env, &trader, keys.no_mint));
                if have < 2 {
                    continue;
                }
                env.merge_raw(&keys, &trader, amt.min(have / 2).max(1))
            }
        };
        res.unwrap_or_else(|e| panic!("e_walk step {i} failed unexpectedly: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        env.ops += 1;
        applied += 1;
        env.ledger(&keys, &format!("e_walk_open_{i}"))
            .assert_walk_ok(15.0, 2.0);
    }
    assert!(applied >= 12, "walk applied too few ops: {applied}");
    resolve_yes(&mut env, &keys);
    let resolved = env.ledger(&keys, "e_walk_resolved");
    resolved.assert_walk_ok(15.0, 2.0);
    let have = tok(&env, &trader, keys.yes_mint);
    if have > 0 {
        assert_eq!(redeem_all(&mut env, &keys, &trader, keys.yes_mint), have);
    }
    let loser = tok(&env, &trader, keys.no_mint);
    if loser > 0 {
        assert_logs_contain(
            env.redeem_raw(&keys, &trader, keys.no_mint, loser.min(2)),
            "NotWinnerMint",
        );
    }
    let claimed = env.ledger(&keys, "e_walk_claimed");
    claimed.assert_walk_ok(15.0, 2.0);
}

#[test]
fn e_multi_lp_fairness_with_fees_and_accrual_vs_python() {
    let req = json!({
        "seed": SEED,
        "duration": LIFE,
        "start_ts": START,
        "ops": [
            {"op": "create"},
            {"op": "bet", "wallet": "trader", "amount": 250_000, "side": "yes"},
            {"op": "warp", "ts": START + LIFE / 4},
            {"op": "add_liquidity", "wallet": "lp2", "amount": 2_000_000},
            {"op": "bet", "wallet": "trader", "amount": 150_000, "side": "no"},
            {"op": "swap", "wallet": "trader", "amount": 40_000, "side": "yes"},
            {"op": "warp", "ts": START + LIFE * 3 / 4},
            {"op": "withdraw", "wallet": "lp2", "shares": 500_000},
            {"op": "add_liquidity", "wallet": "house", "amount": 1_000_000},
            {"op": "warp", "ts": START + LIFE * 9 / 10},
            {"op": "withdraw", "wallet": "lp2", "shares": 1_000_000_000_000u64},
            {"op": "withdraw", "wallet": "house", "shares": 1_000_000_000_000u64}
        ]
    });
    let sim = python_sim(&req);
    let steps = sim["steps"].as_array().expect("steps");

    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let house = env.house_actor();
    let lp2 = env.fund_user(2_500_000);
    let trader = env.fund_user(600_000);

    env.bet(&keys, &trader, 250_000, MarketOutcome::Yes);
    env.warp(START + LIFE / 4);

    // lp2 enters after fees and 1/4 lifetime accrual: must receive 0 pre-entry pending.
    env.add_liquidity(&keys, &lp2, 2_000_000);
    let st_lp2_add = &steps[3];
    let m_add = env.read_market(&keys);
    let p_lp2 = env.read_lp(&keys, lp2.pk()).unwrap();
    assert_close(
        bits_f64(p_lp2.shares),
        f64_of(&st_lp2_add["add_shares"]),
        0.05,
        "multi_lp lp2 shares",
    );
    assert_close(
        bits_f64(p_lp2.checkpoint_yes),
        bits_f64(m_add.cum_yes_per_share),
        1e-9,
        "multi_lp lp2 checkpoint_yes == cum_yes",
    );
    assert_close(
        bits_f64(p_lp2.checkpoint_no),
        bits_f64(m_add.cum_no_per_share),
        1e-9,
        "multi_lp lp2 checkpoint_no == cum_no",
    );
    env.ledger(&keys, "multi_lp_add_lp2").assert_ok();

    env.bet(&keys, &trader, 150_000, MarketOutcome::No);
    env.swap(&keys, &trader, 40_000, MarketOutcome::Yes);
    env.warp(START + LIFE * 3 / 4);

    // lp2 partial withdraw
    let y0 = tok(&env, &lp2, keys.yes_mint);
    let n0 = tok(&env, &lp2, keys.no_mint);
    env.withdraw(&keys, &lp2, 500_000);
    let st_lp2_part = &steps[7];
    let m_part = env.read_market(&keys);
    assert_close(
        (tok(&env, &lp2, keys.yes_mint) - y0) as f64,
        f64_of(&st_lp2_part["pay_yes"]),
        2.0,
        "multi_lp lp2 partial yes",
    );
    assert_close(
        (tok(&env, &lp2, keys.no_mint) - n0) as f64,
        f64_of(&st_lp2_part["pay_no"]),
        2.0,
        "multi_lp lp2 partial no",
    );
    assert_close(
        bits_f64(m_part.reserve_yes),
        f64_of(&st_lp2_part["reserve_yes"]),
        1.0,
        "multi_lp reserve_yes after partial",
    );
    assert_close(
        bits_f64(m_part.reserve_no),
        f64_of(&st_lp2_part["reserve_no"]),
        1.0,
        "multi_lp reserve_no after partial",
    );
    env.ledger(&keys, "multi_lp_part_wd").assert_ok();

    // house second add: checkpoint weighted average
    env.add_liquidity(&keys, &house, 1_000_000);
    let st_house_add = &steps[8];
    let m_hadd = env.read_market(&keys);
    let p_house = env.read_lp(&keys, house.pk()).unwrap();
    assert_close(
        bits_f64(p_house.shares),
        f64_of(&st_house_add["shares"]["house"]),
        0.05,
        "multi_lp house shares after 2nd add",
    );
    assert_close(
        bits_f64(p_house.checkpoint_yes),
        f64_of(&st_house_add["checkpoint"]["house"]["yes"]),
        1e-5,
        "multi_lp house checkpoint_yes",
    );
    assert_close(
        bits_f64(p_house.checkpoint_no),
        f64_of(&st_house_add["checkpoint"]["house"]["no"]),
        1e-5,
        "multi_lp house checkpoint_no",
    );
    assert_close(
        bits_f64(m_hadd.cum_yes_per_share),
        f64_of(&st_house_add["cum_yes"]),
        1e-5,
        "multi_lp cum_yes",
    );
    assert_close(
        bits_f64(m_hadd.cum_no_per_share),
        f64_of(&st_house_add["cum_no"]),
        1e-5,
        "multi_lp cum_no",
    );
    env.ledger(&keys, "multi_lp_house_add").assert_ok();

    env.warp(START + LIFE * 9 / 10);

    // Full exit for both LPs
    let y0 = tok(&env, &lp2, keys.yes_mint);
    let n0 = tok(&env, &lp2, keys.no_mint);
    env.withdraw(&keys, &lp2, u64::MAX);
    let st_lp2_full = &steps[10];
    assert!(env.read_lp(&keys, lp2.pk()).is_none(), "lp2 closed");
    assert_close(
        (tok(&env, &lp2, keys.yes_mint) - y0) as f64,
        f64_of(&st_lp2_full["pay_yes"]),
        2.0,
        "multi_lp lp2 full yes",
    );
    assert_close(
        (tok(&env, &lp2, keys.no_mint) - n0) as f64,
        f64_of(&st_lp2_full["pay_no"]),
        2.0,
        "multi_lp lp2 full no",
    );

    let hy0 = tok(&env, &house, keys.yes_mint);
    let hn0 = tok(&env, &house, keys.no_mint);
    env.withdraw(&keys, &house, u64::MAX);
    let st_house_full = &steps[11];
    assert!(env.read_lp(&keys, house.pk()).is_none(), "house closed");
    assert_close(
        (tok(&env, &house, keys.yes_mint) - hy0) as f64,
        f64_of(&st_house_full["pay_yes"]),
        2.0,
        "multi_lp house full yes",
    );
    assert_close(
        (tok(&env, &house, keys.no_mint) - hn0) as f64,
        f64_of(&st_house_full["pay_no"]),
        2.0,
        "multi_lp house full no",
    );
    env.ledger(&keys, "multi_lp_all_exited").assert_ok();
}

#[test]
fn e_warped_multi_lp_walk_full_exit_and_claim() {
    for (seed_rng, settle_by_resolve) in [(0x5EED_0001u64, true), (0x5EED_0002u64, false)] {
        let mut rng = seed_rng;
        let mut env = Env::new(START);
        let keys = env.create_market(SEED, LIFE, true);
        let house = env.house_actor();
        let lp1 = env.fund_user(20_000_000);
        let lp2 = env.fund_user(20_000_000);
        let trader_a = env.fund_user(50_000_000);
        let trader_b = env.fund_user(50_000_000);

        env.add_liquidity(&keys, &lp1, 2_000_000);
        env.add_liquidity(&keys, &lp2, 1_500_000);
        for t in [&trader_a, &trader_b] {
            env.ensure_ata(t.pk(), keys.yes_mint);
            env.ensure_ata(t.pk(), keys.no_mint);
        }

        let mut applied = 0u32;
        let steps = 45i64;
        for i in 0..steps {
            // Advance clock monotonically across market lifetime so accrual interacts with fees and LP checkpoints.
            let target_ts = (START + (LIFE - 60) * (i + 1) / (steps + 1)).min(keys.expiry as i64 - 60);
            if target_ts > env.clock {
                env.warp(target_ts);
            }
            let roll = mix64(&mut rng) % 8;
            let amt = 2_000 + (mix64(&mut rng) % 30_000);
            let trader = if (mix64(&mut rng) & 1) == 0 {
                &trader_a
            } else {
                &trader_b
            };
            let lp = match mix64(&mut rng) % 3 {
                0 => &house,
                1 => &lp1,
                _ => &lp2,
            };

            let res = match roll {
                0 => env.bet_raw(&keys, trader, amt, MarketOutcome::Yes),
                1 => env.bet_raw(&keys, trader, amt, MarketOutcome::No),
                2 => {
                    let have = tok(&env, trader, keys.no_mint);
                    if have < 4 {
                        continue;
                    }
                    env.swap_raw(&keys, trader, amt.min(have / 2).max(1), MarketOutcome::Yes)
                }
                3 => {
                    let have = tok(&env, trader, keys.yes_mint);
                    if have < 4 {
                        continue;
                    }
                    env.swap_raw(&keys, trader, amt.min(have / 2).max(1), MarketOutcome::No)
                }
                4 | 5 => env.add_liquidity_raw(&keys, lp, amt),
                6 => {
                    let Some(pos) = env.read_lp(&keys, lp.pk()) else {
                        continue;
                    };
                    let shares = bits_f64(pos.shares);
                    if shares < 20_000.0 {
                        continue;
                    }
                    env.withdraw_raw(&keys, lp, (amt as f64).min(shares * 0.05).max(1.0) as u64)
                }
                _ => {
                    let have = tok(&env, trader, keys.yes_mint).min(tok(&env, trader, keys.no_mint));
                    if have < 4 {
                        continue;
                    }
                    env.merge_raw(&keys, trader, amt.min(have / 2).max(1))
                }
            };
            res.unwrap_or_else(|e| {
                panic!(
                    "warped walk seed={seed_rng:#x} step={i} failed: {:?}\n{}",
                    e.err,
                    e.meta.logs.join("\n")
                )
            });
            env.ops += 1;
            applied += 1;
            env.ledger(&keys, &format!("warped_{seed_rng:#x}_{i}"))
                .assert_walk_ok(30.0, 3.0);
        }
        assert!(applied >= 20, "warped walk applied too few ops: {applied}");

        if settle_by_resolve {
            resolve_yes(&mut env, &keys);
        } else {
            void_market(&mut env, &keys);
        }

        // All LPs must be able to exit in full after settlement/void.
        for lp in [&house, &lp1, &lp2] {
            if env.read_lp(&keys, lp.pk()).is_some() {
                env.withdraw(&keys, lp, u64::MAX);
                assert!(
                    env.read_lp(&keys, lp.pk()).is_none(),
                    "LP full exit must close position"
                );
            }
        }
        env.ledger(&keys, &format!("warped_{seed_rng:#x}_all_lp_exited"))
            .assert_walk_ok(30.0, 3.0);

        // All actors redeem all entitled tokens.
        let actors = [&house, &lp1, &lp2, &trader_a, &trader_b];
        for actor in actors {
            if settle_by_resolve {
                let win = tok(&env, actor, keys.yes_mint);
                if win > 0 {
                    assert_eq!(redeem_all(&mut env, &keys, actor, keys.yes_mint), win);
                }
            } else {
                let y = tok(&env, actor, keys.yes_mint);
                if y >= 2 {
                    assert_eq!(redeem_all(&mut env, &keys, actor, keys.yes_mint), y / 2);
                }
                let n = tok(&env, actor, keys.no_mint);
                if n >= 2 {
                    assert_eq!(redeem_all(&mut env, &keys, actor, keys.no_mint), n / 2);
                }
            }
        }
        let post_claim = env.ledger(&keys, &format!("warped_{seed_rng:#x}_claimed"));
        post_claim.assert_backing();

        let leftover = env.token_amount(keys.vault);
        let finish = env.read_market(&keys).finish_ts;
        env.warp(finish as i64 + CLAIM_WINDOW as i64 + 1);
        let house_before = coll(&env, &house);
        env.burn_account(&keys, &house);
        assert_eq!(coll(&env, &house) - house_before, leftover);
        assert!(!env.account_alive(keys.market));
        assert!(!env.account_alive(keys.vault));
    }
}

#[test]
fn e_repeated_skewed_add_liquidity_deficit_bricks_last_lp_exit() {
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let house = env.house_actor();
    let trader = env.fund_user(5_000_000);
    let lp = env.fund_user(5_000_000);
    env.bet(&keys, &trader, 3_000_000, MarketOutcome::Yes);

    for _ in 0..25 {
        env.add_liquidity(&keys, &lp, 10_001);
    }

    let l = env.ledger(&keys, "skewed_add_deficit");
    assert!(
        l.deficit_yes <= 0.5 && l.deficit_no <= 0.5,
        "skewed add_liquidity created book>phys deficit: yes={} no={}",
        l.deficit_yes,
        l.deficit_no
    );
    env.withdraw(&keys, &lp, u64::MAX);
    env.withdraw(&keys, &house, u64::MAX);
}

#[test]
fn e_extreme_bet_past_z_bound_rejected_and_clamped_accrual_swap_safe() {
    // 1. Oversized bets near expiry that would push reserves past Z_SEARCH_MAX must fail cleanly.
    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let whale = env.fund_user(50_000_000);
    env.warp(keys.expiry as i64 - 10);
    assert_logs_contain(
        env.bet_raw(&keys, &whale, 20_000_000, MarketOutcome::Yes),
        "InvalidPrice",
    );
    env.ledger(&keys, "over_z_yes_rejected").assert_backing();

    let mut env = Env::new(START);
    let keys = env.create_market(SEED, LIFE, true);
    let whale = env.fund_user(50_000_000);
    env.warp(keys.expiry as i64 - 10);
    assert_logs_contain(
        env.bet_raw(&keys, &whale, 20_000_000, MarketOutcome::No),
        "InvalidPrice",
    );
    env.ledger(&keys, "over_z_no_rejected").assert_backing();

    // 2. Push P > 0.9999, warp so compute_accrual clamps price to 0.9999 (reserves below curve),
    //    then confirm small trades/swaps never panic and backing + full LP exit hold.
    let mut env = Env::new(START);
    let keys = env.create_market(1_000_001, LIFE, true);
    let house = env.house_actor();
    let whale = env.fund_user(20_000_000);
    let trader = env.fund_user(1_000_000);
    loop {
        let m = env.read_market(&keys);
        let l_eff = prediction_market::math::l_effective(
            m.l_zero_fixed(),
            m.end_ts - env.clock,
        )
        .unwrap();
        let p: f64 = prediction_market::math::price_from_reserves(
            m.reserve_yes_fixed(),
            m.reserve_no_fixed(),
            l_eff,
        )
        .unwrap()
        .to_num();
        if p > 0.9999 {
            break;
        }
        env.bet(&keys, &whale, 500_000, MarketOutcome::Yes);
    }

    env.warp(START + 60);
    env.ensure_ata(trader.pk(), keys.yes_mint);
    env.ensure_ata(trader.pk(), keys.no_mint);
    env.ensure_ata(whale.pk(), keys.no_mint);

    for res in [
        env.bet_raw(&keys, &trader, 5_000, MarketOutcome::Yes),
        env.swap_raw(&keys, &whale, 1_000, MarketOutcome::No),
    ] {
        if let Err(err) = res {
            let logs = err.meta.logs.join("\n");
            assert!(!logs.contains("panicked"), "unexpected panic:\n{logs}");
            assert!(
                logs.contains("Error Code:"),
                "expected clean Anchor error, got:\n{logs}"
            );
        }
    }

    env.ledger(&keys, "clamped_accrual_swap_safe").assert_backing();
    env.withdraw(&keys, &house, u64::MAX);
}
