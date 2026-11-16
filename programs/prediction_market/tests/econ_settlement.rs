//! Completeness net for settlement and economic security.
//! Program code is not modified. These tests lock the README spec:
//! Open markets are 1:1 complete-set backed; Pyth first-print settles
//! or stale-voids; entitled payouts are exact through the claim window;
//! leftover collateral after CLAIM_WINDOW goes to the house.
mod harness;

use harness::*;
use prediction_market::state::{MarketOutcome, MarketStatus};

const START: i64 = 1_700_000_000;
const LIFE: i64 = 7 * 86_400;
const SEED: u64 = 10_000_000;

fn logs_contain(
    res: Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>,
    needle: &str,
) {
    logs_fail(res, &[needle]);
}

fn logs_fail(
    res: Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>,
    needles: &[&str],
) {
    let err = res.expect_err("expected failure");
    let blob = format!("{:?}\n{}", err.err, err.meta.logs.join("\n"));
    assert!(
        needles.iter().any(|n| blob.contains(n)),
        "wanted one of {needles:?} in:\n{blob}"
    );
}

fn inject_first(env: &mut Env, keys: &MarketKeys, price: i64, delay: i64) -> anchor_lang::prelude::Pubkey {
    env.inject_pyth(
        price,
        keys.expiry as i64 + delay,
        keys.expiry as i64 - 1,
        keys.exponent,
        keys.feed_id,
    )
}

fn resolve_with(env: &mut Env, keys: &MarketKeys, price: i64, delay: i64) {
    env.warp(keys.expiry as i64 + delay.max(0));
    let pyth = inject_first(env, keys, price, delay);
    env.resolve(keys, pyth);
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

fn redeem_all(env: &mut Env, keys: &MarketKeys, user: &Actor, mint: anchor_lang::prelude::Pubkey) -> u64 {
    let amt = tok(env, user, mint);
    if amt == 0 {
        return 0;
    }
    let before = coll(env, user);
    env.redeem(keys, user, mint, amt);
    coll(env, user) - before
}

fn assert_trades_dead(env: &mut Env, keys: &MarketKeys, trader: &Actor, lp: &Actor, needle: &str) {
    logs_contain(env.bet_raw(keys, trader, 1_000, MarketOutcome::Yes), needle);
    logs_contain(env.swap_raw(keys, trader, 1, MarketOutcome::No), needle);
    logs_contain(env.add_liquidity_raw(keys, lp, 1_000), needle);
}

#[test]
fn s_constants_locked() {
    assert_eq!(prediction_market::SERVICE_FEE, 30);
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
    let pyth = env.inject_pyth(
        keys.threshold + 1,
        keys.expiry as i64 - 1,
        keys.expiry as i64 - 2,
        keys.exponent,
        keys.feed_id,
    );
    logs_contain(env.resolve_raw(&keys, pyth), "NotFirstAfterExpiry");
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
    let pyth = inject_first(&mut env, &keys, keys.threshold + 1, delay);
    env.resolve(&keys, pyth);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::StaleBurn);
    assert_eq!(m.winner, None);
    assert_eq!(m.settled_price, keys.threshold + 1);
    assert_eq!(m.settled_publish_time, keys.expiry as i64 + delay);
    assert_eq!(m.finish_ts, keys.expiry + delay as u64);
    assert!(m.finish_ts < keys.expiry + RESOLVE_WINDOW);
}

#[test]
fn s_window_burn_does_not_store_pyth() {
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
    let pyth = inject_first(&mut env, &keys, keys.threshold + 2, 3);
    logs_contain(env.resolve_raw(&keys, pyth), "MarketNotOpen");
    env.warp(keys.expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    logs_contain(env.void_raw(&keys), "MarketNotOpen");
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
    logs_contain(env.redeem_raw(&keys, &trader, keys.yes_mint, 1), "MarketNotResolved");
    env.warp(keys.expiry as i64 + 1);
    logs_contain(env.redeem_raw(&keys, &trader, keys.yes_mint, 1), "MarketNotResolved");
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
                let pyth = inject_first(&mut env, &keys, keys.threshold + 1, delay);
                env.resolve(&keys, pyth);
                assert_eq!(env.read_market(&keys).status, MarketStatus::StaleBurn);
            }
            _ => void_market(&mut env, &keys),
        }
        assert_trades_dead(&mut env, &keys, &trader, &lp, "MarketNotOpen");
        logs_contain(env.merge_raw(&keys, &trader, 1), "MarketNotTradable");
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
    assert_eq!(a_got, a_win, "first winner must be paid 1:1, not shorted by the second");
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
    logs_contain(env.redeem_raw(&keys, &trader, keys.yes_mint, 1), "NotWinnerMint");
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
    logs_fail(
        env.redeem_raw(&keys, &trader, keys.yes_mint, have + 1),
        &["InsufficientBalance", "insufficient funds", "custom program error: 0x1"],
    );
    let loser = tok(&env, &trader, keys.no_mint).min(10).max(1);
    logs_contain(env.redeem_raw(&keys, &trader, keys.no_mint, loser), "NotWinnerMint");
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
        assert_eq!(coll(&env, &trader) - before, expect, "void yes {amt} must pay floor/2={expect}");
        let before = coll(&env, &trader);
        env.redeem(&keys, &trader, keys.no_mint, amt);
        assert_eq!(coll(&env, &trader) - before, expect, "void no {amt} must pay floor/2={expect}");
        env.ledger(&keys, &format!("e_void_floor_{amt}")).assert_ok();
    }
    logs_contain(env.redeem_raw(&keys, &trader, keys.yes_mint, 1), "InvalidAmount");
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
    let pyth = inject_first(&mut env, &keys, keys.threshold + 1, delay);
    env.resolve(&keys, pyth);
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
    assert_eq!(env.token_amount(keys.vault), vault, "withdraw moves outcome tokens, not collateral");
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
    logs_fail(
        env.withdraw_raw(&keys, &stranger, 1),
        &["AccountNotInitialized", "already initialized"],
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
    logs_contain(env.redeem_raw(&b, &trader, a.yes_mint, 1), "InvalidMint");
    logs_fail(
        env.redeem_raw_accounts(
            &a,
            &trader,
            a.yes_mint,
            ata(trader.pk(), a.yes_mint),
            b.vault,
            1,
        ),
        &["ConstraintSeeds", "seeds constraint", "A seeds constraint was violated"],
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
    assert!(leftover <= 8, "after all wallets redeem, leftover yes {leftover} should be pool dust");
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
    logs_contain(env.burn_account_raw(&keys, &env.house_actor()), "NoArriveFinishTS");
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
    logs_contain(env.burn_account_raw(&keys, &house), "NoArriveFinishTS");
    let stranger = env.fund_user(10_000);
    env.warp(env.read_market(&keys).finish_ts as i64 + CLAIM_WINDOW as i64 + 1);
    logs_contain(env.burn_account_raw(&keys, &stranger), "NoCreator");
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
    assert_eq!(tok(&env, &trader, keys.yes_mint), have, "user tokens remain in the wallet");
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
    assert!(leftover <= 8, "house sweep after full claim should be dust, got {leftover}");
    env.warp(env.read_market(&keys).finish_ts as i64 + CLAIM_WINDOW as i64 + 1);
    let before = coll(&env, &house);
    env.burn_account(&keys, &house);
    assert_eq!(coll(&env, &house) - before, leftover);
}

fn mix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
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
        if res.is_ok() {
            env.ops += 1;
            applied += 1;
        }
        env.ledger(&keys, &format!("e_walk_open_{i}")).assert_backing();
    }
    assert!(applied >= 12, "walk applied too few ops: {applied}");
    resolve_yes(&mut env, &keys);
    let resolved = env.ledger(&keys, "e_walk_resolved");
    resolved.assert_backing();
    assert!(resolved.err_yes <= 16.0 && resolved.err_no <= 16.0, "walk resolve conservation");
    let have = tok(&env, &trader, keys.yes_mint);
    if have > 0 {
        assert_eq!(redeem_all(&mut env, &keys, &trader, keys.yes_mint), have);
    }
    let loser = tok(&env, &trader, keys.no_mint);
    if loser > 0 {
        logs_contain(env.redeem_raw(&keys, &trader, keys.no_mint, loser.min(2)), "NotWinnerMint");
    }
    let claimed = env.ledger(&keys, "e_walk_claimed");
    claimed.assert_backing();
    assert!(claimed.err_yes <= 16.0 && claimed.err_no <= 16.0, "walk claim conservation");
}



