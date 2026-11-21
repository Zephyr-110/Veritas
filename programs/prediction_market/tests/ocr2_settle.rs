use harness::*;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData};
use k256::ecdsa::SigningKey;
use prediction_market::instruction::{BurnAccount, CreateMarket, ResolveMarket, TakeSnapshot};
use prediction_market::instructions::{CreateMarketParams, ResolveMarketParam};
use prediction_market::math::ocr2::{verify_report, Ocr2Error};
use prediction_market::state::MarketStatus;
use prediction_market::{
    MarketOutcome, MarketSnapshot, ALLOWED_FEEDS, CHAINLINK_OCR2_PROGRAM_ID,
    CHAINLINK_STORE_PROGRAM_ID,
};
use solana_account::Account as SolAccount;
use solana_instruction::Instruction;
use solana_keccak_hasher::hash as keccak_hash;
use solana_secp256k1_recover::secp256k1_recover;
use solana_sha256_hasher::hashv;

mod harness;

const BTC_STATE: &[u8] = include_bytes!("fixtures/btc_state.bin");
const ETH_STATE: &[u8] = include_bytes!("fixtures/eth_state.bin");
const BTC_FEED: &[u8] = include_bytes!("fixtures/btc_feed.bin");
const R800_1: &[u8] = include_bytes!("fixtures/e7190800_r1.bin");
const R800_2: &[u8] = include_bytes!("fixtures/e7190800_r2.bin");
const R800_3: &[u8] = include_bytes!("fixtures/e7190800_r3.bin");
const R800_4: &[u8] = include_bytes!("fixtures/e7190800_r4.bin");
const R799_5: &[u8] = include_bytes!("fixtures/e7190799_r5.bin");
const R799_6: &[u8] = include_bytes!("fixtures/e7190799_r6.bin");
const R798_5: &[u8] = include_bytes!("fixtures/e7190798_r5.bin");
const R800_6: &[u8] = include_bytes!("fixtures/e7190800_r6.bin");

const VERIFY_ERRORS: &[&str] = &[
    "InvalidOracleSignature",
    "UnauthorizedOracleSigner",
    "InvalidOracleInput",
    "OracleDigestMismatch",
    "WrongNumberOfSignatures",
    "DuplicateOracleSigner",
];

struct Seen {
    epoch: u32,
    round: u8,
    ts: i64,
    median: i64,
}

fn seen(raw: &[u8]) -> Seen {
    assert!(
        raw.len() >= 1 + 96 + 61,
        "captured transmit shorter than a report"
    );
    let ctx = &raw[1..1 + 96];
    let report = &raw[1 + 96..1 + 96 + 61];
    let median = i128::from_be_bytes(report[37..53].try_into().unwrap());
    Seen {
        epoch: u32::from_be_bytes(ctx[59..63].try_into().unwrap()),
        round: ctx[63],
        ts: i64::from(u32::from_be_bytes(report[0..4].try_into().unwrap())),
        median: i64::try_from(median).expect("captured median fits i64"),
    }
}

fn snapshot_of(keys: &MarketKeys) -> Pubkey {
    Pubkey::find_program_address(&[b"snapshot", keys.market.as_ref()], &PROGRAM_ID).0
}

fn put(env: &mut Env, pk: Pubkey, owner: Pubkey, data: Vec<u8>) {
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm
        .set_account(
            addr(pk),
            SolAccount {
                lamports,
                data,
                owner: addr(owner),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

fn install_btc(env: &mut Env) {
    put(
        env,
        ALLOWED_FEEDS[0].state,
        CHAINLINK_OCR2_PROGRAM_ID,
        BTC_STATE.to_vec(),
    );
    put(
        env,
        ALLOWED_FEEDS[0].feed,
        CHAINLINK_STORE_PROGRAM_ID,
        BTC_FEED.to_vec(),
    );
}

fn install_eth(env: &mut Env) {
    put(
        env,
        ALLOWED_FEEDS[1].state,
        CHAINLINK_OCR2_PROGRAM_ID,
        ETH_STATE.to_vec(),
    );
}

fn lamports(env: &Env, pk: Pubkey) -> u64 {
    env.svm
        .get_account(&addr(pk))
        .map(|a| a.lamports)
        .unwrap_or(0)
}

fn read_snap(env: &Env, keys: &MarketKeys) -> MarketSnapshot {
    let acc = env
        .svm
        .get_account(&addr(snapshot_of(keys)))
        .expect("snapshot account");
    let mut data: &[u8] = &acc.data;
    MarketSnapshot::try_deserialize(&mut data).expect("snapshot decodes")
}

fn feed_counter(feed: &[u8]) -> u32 {
    u32::from_le_bytes(feed[143..147].try_into().unwrap())
}

fn state_with_round(epoch: u32, round: u8) -> Vec<u8> {
    let mut data = BTC_STATE.to_vec();
    data[273] = round;
    data[276..280].copy_from_slice(&epoch.to_le_bytes());
    data
}

fn feed_with_counter(counter: u32) -> Vec<u8> {
    let mut data = BTC_FEED.to_vec();
    data[143..147].copy_from_slice(&counter.to_le_bytes());
    data
}

fn open(
    env: &mut Env,
    expiry: u64,
    threshold: i64,
    settle_above: bool,
    state: Pubkey,
) -> MarketKeys {
    let mut keys = MarketKeys::derive(next_market_id());
    keys.expiry = expiry;
    keys.threshold = threshold;
    keys.settle_above = settle_above;
    keys.start_ts = env.clock;
    let param = CreateMarketParams {
        expiry,
        market_id: keys.id,
        prediction: [b'v'; 64],
        collateral_amount: 2_000_000,
        threshold,
        settle_above,
    };
    let ix = Instruction {
        program_id: addr(PROGRAM_ID),
        accounts: vec![
            meta(env.house_pk(), true, true),
            meta(keys.market, true, false),
            meta(state, false, false),
            meta(snapshot_of(&keys), true, false),
            meta(keys.lp_position(env.house_pk()), true, false),
            meta(env.mint, false, false),
            meta(keys.yes_mint, true, false),
            meta(keys.no_mint, true, false),
            meta(keys.vault, true, false),
            meta(ata(env.house_pk(), env.mint), true, false),
            meta(keys.yes_pool, true, false),
            meta(keys.no_pool, true, false),
            meta(CLOCK_ID, false, false),
            meta(ATA_PROGRAM, false, false),
            meta(TOKEN_PROGRAM, false, false),
            meta(SYSTEM_PROGRAM, false, false),
        ],
        data: CreateMarket { param }.data(),
    };
    env.send(&[ix], &[]);
    keys
}

fn resolve_ix(
    env: &Env,
    keys: &MarketKeys,
    pre: &[u8],
    post: &[u8],
    snapshot: Option<Pubkey>,
    state: Pubkey,
) -> Instruction {
    Instruction {
        program_id: addr(PROGRAM_ID),
        accounts: vec![
            meta(env.house_pk(), true, true),
            meta(keys.market, true, false),
            meta(snapshot.unwrap_or(PROGRAM_ID), false, false),
            meta(state, false, false),
            meta(CLOCK_ID, false, false),
        ],
        data: ResolveMarket {
            param: ResolveMarketParam {
                raw_pre: pre.to_vec(),
                raw_post: post.to_vec(),
            },
        }
        .data(),
    }
}

fn unchanged(env: &Env, keys: &MarketKeys) {
    let m = env.read_market(keys);
    assert_eq!(
        m.status,
        MarketStatus::Open,
        "rejected market must stay open"
    );
    assert_eq!(m.winner, None, "rejected market must not set a winner");
    assert_eq!(m.settled_price, 0, "rejected market must not store a price");
    assert_eq!(m.finish_ts, 0, "rejected market must not set finish_ts");
}

fn reject(
    env: &mut Env,
    keys: &MarketKeys,
    pre: &[u8],
    post: &[u8],
    snapshot: Option<Pubkey>,
    state: Pubkey,
    error_name: &str,
) {
    let ix = resolve_ix(env, keys, pre, post, snapshot, state);
    env.expect_err(&[ix], &[], error_name);
    unchanged(env, keys);
}

fn reject_verify(env: &mut Env, keys: &MarketKeys, pre: &[u8], post: &[u8]) {
    let ix = resolve_ix(env, keys, pre, post, None, ALLOWED_FEEDS[0].state);
    let err = env
        .send_raw(&[ix], &[])
        .expect_err("tampered report must be rejected");
    let logs = err.meta.logs.join("\n");
    assert!(
        VERIFY_ERRORS.iter().any(|name| logs.contains(name)),
        "tamper must fail verification, logs:\n{logs}\nerr={:?}",
        err.err
    );
    unchanged(env, keys);
}

fn expect_settled(
    env: &Env,
    keys: &MarketKeys,
    winner: MarketOutcome,
    price: i64,
    publish: i64,
    now: i64,
) {
    let m = env.read_market(keys);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, Some(winner));
    assert_eq!(m.settled_price, price);
    assert_eq!(m.settled_publish_time, publish);
    assert_eq!(m.finish_ts, now as u64);
}

fn flip(raw: &[u8], at: usize) -> Vec<u8> {
    let mut out = raw.to_vec();
    out[at] ^= 0x01;
    out
}

fn btc_env() -> Env {
    let mut env = Env::new(1_795_254_000);
    install_btc(&mut env);
    env
}

fn snap_ix(env: &Env, keys: &MarketKeys) -> Instruction {
    snap_ix_with(
        env.house_pk(),
        keys,
        ALLOWED_FEEDS[0].state,
        ALLOWED_FEEDS[0].feed,
    )
}

fn snap_ix_with(caller: Pubkey, keys: &MarketKeys, state: Pubkey, feed: Pubkey) -> Instruction {
    Instruction {
        program_id: addr(PROGRAM_ID),
        accounts: vec![
            meta(caller, true, true),
            meta(keys.market, false, false),
            meta(snapshot_of(keys), true, false),
            meta(state, false, false),
            meta(feed, false, false),
            meta(CLOCK_ID, false, false),
            meta(SYSTEM_PROGRAM, false, false),
        ],
        data: TakeSnapshot {}.data(),
    }
}

fn record_pair(
    env: &mut Env,
    keys: &MarketKeys,
    pre_epoch: u32,
    pre_round: u8,
    pre_counter: u32,
    post_epoch: u32,
    post_round: u8,
    post_counter: u32,
    now: i64,
) {
    env.warp(now);
    put(
        env,
        ALLOWED_FEEDS[0].state,
        CHAINLINK_OCR2_PROGRAM_ID,
        state_with_round(pre_epoch, pre_round),
    );
    put(
        env,
        ALLOWED_FEEDS[0].feed,
        CHAINLINK_STORE_PROGRAM_ID,
        feed_with_counter(pre_counter),
    );
    env.send(&[snap_ix(env, keys)], &[]);
    put(
        env,
        ALLOWED_FEEDS[0].state,
        CHAINLINK_OCR2_PROGRAM_ID,
        state_with_round(post_epoch, post_round),
    );
    put(
        env,
        ALLOWED_FEEDS[0].feed,
        CHAINLINK_STORE_PROGRAM_ID,
        feed_with_counter(post_counter),
    );
    env.send(&[snap_ix(env, keys)], &[]);
}

#[test]
fn verify_real_adjacent_reports_settle_above_yes() {
    let post = seen(R800_3);
    let pre = seen(R800_2);
    assert!(pre.ts < post.ts);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        post.ts as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(post.ts);
    env.send(
        &[resolve_ix(
            &env,
            &keys,
            R800_2,
            R800_3,
            None,
            ALLOWED_FEEDS[0].state,
        )],
        &[],
    );
    expect_settled(
        &env,
        &keys,
        MarketOutcome::Yes,
        post.median,
        post.ts,
        post.ts,
    );
}

#[test]
fn verify_real_adjacent_reports_settle_below_no() {
    let post = seen(R800_3);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        post.ts as u64,
        post.median,
        false,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(post.ts);
    env.send(
        &[resolve_ix(
            &env,
            &keys,
            R800_2,
            R800_3,
            None,
            ALLOWED_FEEDS[0].state,
        )],
        &[],
    );
    expect_settled(
        &env,
        &keys,
        MarketOutcome::No,
        post.median,
        post.ts,
        post.ts,
    );
}

#[test]
fn real_report_yes_redeem_is_one_to_one() {
    let post = seen(R800_3);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        post.ts as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    let trader = env.fund_user(500_000);
    env.bet(&keys, &trader, 100_000, MarketOutcome::Yes);
    let yes = env.token_amount(ata(trader.pk(), keys.yes_mint));
    let no = env.token_amount(ata(trader.pk(), keys.no_mint));
    assert!(yes > 0, "bet must leave YES to redeem");
    env.warp(post.ts);
    env.send(
        &[resolve_ix(
            &env,
            &keys,
            R800_2,
            R800_3,
            None,
            ALLOWED_FEEDS[0].state,
        )],
        &[],
    );
    expect_settled(
        &env,
        &keys,
        MarketOutcome::Yes,
        post.median,
        post.ts,
        post.ts,
    );

    let coll = env.token_amount(ata(trader.pk(), env.mint));
    env.redeem(&keys, &trader, keys.yes_mint, yes);
    assert_eq!(
        env.token_amount(ata(trader.pk(), env.mint)) - coll,
        yes,
        "winner redeems 1:1"
    );
    if no > 0 {
        let err = env
            .redeem_raw(&keys, &trader, keys.no_mint, 1)
            .expect_err("loser mint");
        let logs = err.meta.logs.join("\n");
        assert!(
            logs.contains("NotWinnerMint"),
            "loser must not be paid:\n{logs}"
        );
    }
    assert_eq!(
        env.token_amount(keys.vault),
        env.mint_supply(keys.yes_mint),
        "resolved vault is remaining YES"
    );
    env.ledger(&keys, "real_yes_redeem").assert_backing();
}

// Note: time-travels to expiry - 5 to populate MarketSnapshot in order to exercise
// resolve_market's `certified && post_ts > end_ts + 10` branch; in real-time chain
// execution take_snapshot rejects `now >= end_ts + 10` (see
// `take_snapshot_blocked_when_stale_report_lands_and_adjacent_stale_burn_works_realistically`).
#[test]
fn snapshot_gap_over_ten_seconds_stale_burns_and_pays_floor() {
    let pre = seen(R798_5);
    let post = seen(R800_6);
    assert!(
        post.ts - pre.ts > 10,
        "fixture pair must be wide enough to stale-burn"
    );
    let expiry = (post.ts - 11) as u64;
    assert!(pre.ts < expiry as i64 && post.ts > expiry as i64 + MAX_SETTLE_DELAY);
    let mut env = btc_env();
    let keys = open(&mut env, expiry, post.median, true, ALLOWED_FEEDS[0].state);
    let trader = env.fund_user(400_000);
    env.bet(&keys, &trader, 80_000, MarketOutcome::Yes);
    env.bet(&keys, &trader, 40_000, MarketOutcome::No);
    let counter = feed_counter(BTC_FEED);
    record_pair(
        &mut env,
        &keys,
        pre.epoch,
        pre.round,
        counter,
        post.epoch,
        post.round,
        counter + 1,
        expiry as i64 - 5,
    );
    env.warp(post.ts);
    env.send(
        &[resolve_ix(
            &env,
            &keys,
            R798_5,
            R800_6,
            Some(snapshot_of(&keys)),
            ALLOWED_FEEDS[0].state,
        )],
        &[],
    );
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::StaleBurn);
    assert_eq!(m.winner, None);
    assert_eq!(
        m.settled_price, 0,
        "StaleBurn does not store the late print"
    );
    assert_eq!(m.settled_publish_time, 0);
    assert_eq!(m.finish_ts, post.ts as u64);

    let yes = env.token_amount(ata(trader.pk(), keys.yes_mint));
    let no = env.token_amount(ata(trader.pk(), keys.no_mint));
    assert!(
        yes >= 4 && no >= 4,
        "need both sides to check floor payout, yes={yes} no={no}"
    );
    let err = env
        .redeem_raw(&keys, &trader, keys.yes_mint, 1)
        .expect_err("odd token");
    assert!(err.meta.logs.join("\n").contains("InvalidAmount"));
    let before = env.token_amount(ata(trader.pk(), env.mint));
    env.redeem(&keys, &trader, keys.yes_mint, 4);
    env.redeem(&keys, &trader, keys.no_mint, 4);
    assert_eq!(
        env.token_amount(ata(trader.pk(), env.mint)) - before,
        4,
        "4+4 stale tokens pay floor 2+2"
    );
    env.ledger(&keys, "real_stale_floor").assert_backing();
}

#[test]
fn verify_tampered_price_timestamp_or_round_rejected() {
    let post = seen(R800_3);
    for bad in [
        flip(R800_3, 1 + 96 + 37),
        flip(R800_3, 1 + 96),
        flip(R800_3, 1 + 63),
    ] {
        let mut env = btc_env();
        let keys = open(
            &mut env,
            post.ts as u64,
            post.median,
            true,
            ALLOWED_FEEDS[0].state,
        );
        env.warp(post.ts);
        reject_verify(&mut env, &keys, R800_2, &bad);
    }
}

#[test]
fn verify_too_few_signatures_rejected() {
    let post = seen(R800_3);
    let mut short = R800_3.to_vec();
    short.truncate(short.len() - 65);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        post.ts as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(post.ts);
    reject(
        &mut env,
        &keys,
        R800_2,
        &short,
        None,
        ALLOWED_FEEDS[0].state,
        "WrongNumberOfSignatures",
    );
}

#[test]
fn verify_duplicate_signer_rejected() {
    let post = seen(R800_3);
    let mut dup = R800_3.to_vec();
    let sigs = 1 + 96 + 61;
    let first = dup[sigs..sigs + 65].to_vec();
    dup[sigs + 65..sigs + 130].copy_from_slice(&first);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        post.ts as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(post.ts);
    reject(
        &mut env,
        &keys,
        R800_2,
        &dup,
        None,
        ALLOWED_FEEDS[0].state,
        "DuplicateOracleSigner",
    );
}

#[test]
fn verify_report_against_other_feed_state_rejected() {
    let post = seen(R800_3);
    let mut env = btc_env();
    install_eth(&mut env);
    let keys = open(
        &mut env,
        post.ts as u64,
        post.median,
        true,
        ALLOWED_FEEDS[1].state,
    );
    env.warp(post.ts);
    reject(
        &mut env,
        &keys,
        R800_2,
        R800_3,
        None,
        ALLOWED_FEEDS[1].state,
        "OracleDigestMismatch",
    );
}

#[test]
fn adjacent_same_epoch_rounds_pass() {
    let pre = seen(R800_2);
    let post = seen(R800_3);
    assert_eq!(pre.epoch, post.epoch);
    assert_eq!(post.round, pre.round + 1);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        post.ts as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(post.ts);
    env.send(
        &[resolve_ix(
            &env,
            &keys,
            R800_2,
            R800_3,
            None,
            ALLOWED_FEEDS[0].state,
        )],
        &[],
    );
    expect_settled(
        &env,
        &keys,
        MarketOutcome::Yes,
        post.median,
        post.ts,
        post.ts,
    );
}

#[test]
fn epoch_boundary_round6_to_next_round1_passes() {
    let pre = seen(R799_6);
    let post = seen(R800_1);
    assert_eq!(pre.round, 6);
    assert_eq!(post.round, 1);
    assert_eq!(post.epoch, pre.epoch + 1);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        post.ts as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(post.ts);
    env.send(
        &[resolve_ix(
            &env,
            &keys,
            R799_6,
            R800_1,
            None,
            ALLOWED_FEEDS[0].state,
        )],
        &[],
    );
    expect_settled(
        &env,
        &keys,
        MarketOutcome::Yes,
        post.median,
        post.ts,
        post.ts,
    );
}

#[test]
fn non_max_round_does_not_cross_epoch() {
    let pre = seen(R799_5);
    let post = seen(R800_1);
    assert_ne!(pre.round, 6);
    let end = pre.ts + 3;
    assert!(pre.ts < end && end <= post.ts);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        end as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(post.ts);
    reject(
        &mut env,
        &keys,
        R799_5,
        R800_1,
        None,
        ALLOWED_FEEDS[0].state,
        "UnableCompleteCheckout",
    );
}

#[test]
fn skipped_round_rejected() {
    let pre = seen(R800_2);
    let post = seen(R800_4);
    assert_eq!(post.round, pre.round + 2);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        (pre.ts + 3) as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(post.ts);
    reject(
        &mut env,
        &keys,
        R800_2,
        R800_4,
        None,
        ALLOWED_FEEDS[0].state,
        "UnableCompleteCheckout",
    );
}

#[test]
fn reversed_rounds_rejected() {
    let later = seen(R800_3);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        later.ts as u64,
        later.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(later.ts);
    reject(
        &mut env,
        &keys,
        R800_3,
        R800_2,
        None,
        ALLOWED_FEEDS[0].state,
        "UnableCompleteCheckout",
    );
}

#[test]
fn pre_timestamp_already_at_expiry_rejected() {
    let pre = seen(R800_2);
    let post = seen(R800_3);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        pre.ts as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(post.ts);
    reject(
        &mut env,
        &keys,
        R800_2,
        R800_3,
        None,
        ALLOWED_FEEDS[0].state,
        "NotFirstAfterExpiry",
    );
}

#[test]
fn snapshot_consecutive_counter_settles_nonadjacent_reports() {
    let pre = seen(R800_2);
    let post = seen(R800_4);
    let counter = feed_counter(BTC_FEED);
    let mut env = btc_env();
    let end = pre.ts + 3;
    let keys = open(
        &mut env,
        end as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    record_pair(
        &mut env,
        &keys,
        pre.epoch,
        pre.round,
        counter,
        post.epoch,
        post.round,
        counter + 1,
        end - 5,
    );
    let book = read_snap(&env, &keys);
    assert_eq!(book.entries.len(), 2);
    assert_eq!(book.entries[0].counter, counter);
    assert_eq!(book.entries[1].counter, counter + 1);
    assert_eq!(book.entries[0].at.round, pre.round);
    assert_eq!(book.entries[1].at.round, post.round);
    env.warp(post.ts);
    env.send(
        &[resolve_ix(
            &env,
            &keys,
            R800_2,
            R800_4,
            Some(snapshot_of(&keys)),
            ALLOWED_FEEDS[0].state,
        )],
        &[],
    );
    expect_settled(
        &env,
        &keys,
        MarketOutcome::Yes,
        post.median,
        post.ts,
        post.ts,
    );
}

#[test]
fn snapshot_counter_gap_of_two_rejected() {
    let pre = seen(R800_2);
    let post = seen(R800_4);
    let counter = feed_counter(BTC_FEED);
    let mut env = btc_env();
    let end = pre.ts + 3;
    let keys = open(
        &mut env,
        end as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    record_pair(
        &mut env,
        &keys,
        pre.epoch,
        pre.round,
        counter,
        post.epoch,
        post.round,
        counter + 2,
        end - 5,
    );
    env.warp(post.ts);
    reject(
        &mut env,
        &keys,
        R800_2,
        R800_4,
        Some(snapshot_of(&keys)),
        ALLOWED_FEEDS[0].state,
        "UnableCompleteCheckout",
    );
}

#[test]
fn snapshot_without_pre_entry_rejected() {
    let pre = seen(R800_2);
    let other = seen(R800_1);
    let post = seen(R800_4);
    let counter = feed_counter(BTC_FEED);
    let mut env = btc_env();
    let end = pre.ts + 3;
    let keys = open(
        &mut env,
        end as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    record_pair(
        &mut env,
        &keys,
        other.epoch,
        other.round,
        counter,
        post.epoch,
        post.round,
        counter + 1,
        end - 5,
    );
    env.warp(post.ts);
    reject(
        &mut env,
        &keys,
        R800_2,
        R800_4,
        Some(snapshot_of(&keys)),
        ALLOWED_FEEDS[0].state,
        "UnableCompleteCheckout",
    );
}

#[test]
fn snapshot_next_round_mismatch_rejected() {
    let pre = seen(R800_2);
    let mid = seen(R800_3);
    let post = seen(R800_4);
    let counter = feed_counter(BTC_FEED);
    let mut env = btc_env();
    let end = pre.ts + 3;
    let keys = open(
        &mut env,
        end as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    record_pair(
        &mut env,
        &keys,
        pre.epoch,
        pre.round,
        counter,
        mid.epoch,
        mid.round,
        counter + 1,
        end - 5,
    );
    env.warp(post.ts);
    reject(
        &mut env,
        &keys,
        R800_2,
        R800_4,
        Some(snapshot_of(&keys)),
        ALLOWED_FEEDS[0].state,
        "UnableCompleteCheckout",
    );
}

#[test]
fn omitted_snapshot_uses_primary_path() {
    let post = seen(R800_3);
    let mut env = btc_env();
    let keys = open(
        &mut env,
        post.ts as u64,
        post.median,
        true,
        ALLOWED_FEEDS[0].state,
    );
    env.warp(post.ts);
    env.send(
        &[resolve_ix(
            &env,
            &keys,
            R800_2,
            R800_3,
            None,
            ALLOWED_FEEDS[0].state,
        )],
        &[],
    );
    expect_settled(
        &env,
        &keys,
        MarketOutcome::Yes,
        post.median,
        post.ts,
        post.ts,
    );
}

#[test]
fn take_snapshot_window_and_counter_rules() {
    let sample = seen(R800_2);
    let counter = feed_counter(BTC_FEED);
    let expiry = 2_000_000_000u64;
    let mut env = Env::new(1_999_999_000);
    install_btc(&mut env);
    let keys = open(&mut env, expiry, 1, true, ALLOWED_FEEDS[0].state);
    assert!(env.account_alive(snapshot_of(&keys)));
    assert_eq!(read_snap(&env, &keys).entries.len(), 0);

    env.warp(expiry as i64 - 10);
    put(
        &mut env,
        ALLOWED_FEEDS[0].state,
        CHAINLINK_OCR2_PROGRAM_ID,
        state_with_round(sample.epoch, sample.round),
    );
    put(
        &mut env,
        ALLOWED_FEEDS[0].feed,
        CHAINLINK_STORE_PROGRAM_ID,
        feed_with_counter(counter),
    );
    env.expect_err(&[snap_ix(&env, &keys)], &[], "SnapshotOutOfWindow");
    assert_eq!(read_snap(&env, &keys).entries.len(), 0);

    env.warp(expiry as i64 - 9);
    env.send(&[snap_ix(&env, &keys)], &[]);
    let book = read_snap(&env, &keys);
    assert_eq!(book.entries.len(), 1);
    assert_eq!(book.entries[0].at.epoch, sample.epoch);
    assert_eq!(book.entries[0].at.round, sample.round);
    assert_eq!(book.entries[0].counter, counter);

    env.expect_err(&[snap_ix(&env, &keys)], &[], "SnapshotStale");
    assert_eq!(read_snap(&env, &keys).entries.len(), 1);

    let mut env = Env::new(1_999_999_000);
    install_btc(&mut env);
    let keys = open(&mut env, expiry, 1, true, ALLOWED_FEEDS[0].state);
    env.warp(expiry as i64 + 10);
    env.expect_err(&[snap_ix(&env, &keys)], &[], "SnapshotOutOfWindow");
    assert_eq!(read_snap(&env, &keys).entries.len(), 0);

    let mut env = Env::new(1_999_999_000);
    install_btc(&mut env);
    let keys = open(&mut env, expiry, 1, true, ALLOWED_FEEDS[0].state);
    env.warp(expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    env.void_market(&keys);
    env.warp(expiry as i64 - 9);
    env.expect_err(&[snap_ix(&env, &keys)], &[], "MarketNotOpen");
}

#[test]
fn take_snapshot_stops_at_sixteen() {
    let sample = seen(R800_2);
    let counter = feed_counter(BTC_FEED);
    let expiry = 2_000_000_000u64;
    let mut env = Env::new(1_999_999_000);
    install_btc(&mut env);
    let keys = open(&mut env, expiry, 1, true, ALLOWED_FEEDS[0].state);
    env.warp(expiry as i64 - 9);
    for i in 0..16u32 {
        put(
            &mut env,
            ALLOWED_FEEDS[0].state,
            CHAINLINK_OCR2_PROGRAM_ID,
            state_with_round(sample.epoch, sample.round),
        );
        put(
            &mut env,
            ALLOWED_FEEDS[0].feed,
            CHAINLINK_STORE_PROGRAM_ID,
            feed_with_counter(counter + i),
        );
        env.send(&[snap_ix(&env, &keys)], &[]);
    }
    let book = read_snap(&env, &keys);
    assert_eq!(book.entries.len(), 16);
    assert_eq!(book.entries[0].counter, counter);
    assert_eq!(book.entries[15].counter, counter + 15);
    put(
        &mut env,
        ALLOWED_FEEDS[0].feed,
        CHAINLINK_STORE_PROGRAM_ID,
        feed_with_counter(counter + 16),
    );
    env.expect_err(&[snap_ix(&env, &keys)], &[], "SnapshotFull");
    assert_eq!(read_snap(&env, &keys).entries.len(), 16);
}

#[test]
fn create_opens_empty_snapshot_and_burn_returns_its_rent() {
    let mut env = btc_env();
    let expiry = (env.clock + 3_600) as u64;
    let keys = open(&mut env, expiry, 1, true, ALLOWED_FEEDS[0].state);
    let snap = snapshot_of(&keys);
    assert!(env.account_alive(snap));
    assert_eq!(read_snap(&env, &keys).entries.len(), 0);

    env.warp(expiry as i64 + RESOLVE_WINDOW as i64 + 1);
    env.void_market(&keys);
    let finish = env.read_market(&keys).finish_ts;
    env.warp(finish as i64 + CLAIM_WINDOW as i64 + 1);

    let creator = env.house_pk();
    let before = lamports(&env, creator);
    let returned = lamports(&env, snap)
        + lamports(&env, keys.market)
        + lamports(&env, keys.yes_pool)
        + lamports(&env, keys.no_pool)
        + lamports(&env, keys.vault);
    let ix = Instruction {
        program_id: addr(PROGRAM_ID),
        accounts: vec![
            meta(creator, true, true),
            meta(keys.market, true, false),
            meta(snap, true, false),
            meta(keys.yes_pool, true, false),
            meta(keys.no_pool, true, false),
            meta(keys.yes_mint, true, false),
            meta(keys.no_mint, true, false),
            meta(ata(creator, env.mint), true, false),
            meta(keys.vault, true, false),
            meta(env.mint, false, false),
            meta(TOKEN_PROGRAM, false, false),
            meta(CLOCK_ID, false, false),
        ],
        data: BurnAccount {}.data(),
    };
    env.send(&[ix], &[]);
    assert!(!env.account_alive(snap), "snapshot account must be closed");
    assert_eq!(lamports(&env, creator), before + returned - 5_000);
}

#[test]
fn take_snapshot_rejects_wrong_feed_account() {
    let mut env = btc_env();
    let expiry = (env.clock + 3_600) as u64;
    let keys = open(&mut env, expiry, 1, true, ALLOWED_FEEDS[0].state);
    put(
        &mut env,
        ALLOWED_FEEDS[1].feed,
        CHAINLINK_STORE_PROGRAM_ID,
        BTC_FEED.to_vec(),
    );
    env.warp(expiry as i64 - 5);
    let ix = snap_ix_with(
        env.house_pk(),
        &keys,
        ALLOWED_FEEDS[0].state,
        ALLOWED_FEEDS[1].feed,
    );
    env.expect_err(&[ix], &[], "BadFeedAccount");
}

#[test]
fn take_snapshot_rejects_wrong_feed_owner() {
    let mut env = btc_env();
    let expiry = (env.clock + 3_600) as u64;
    let keys = open(&mut env, expiry, 1, true, ALLOWED_FEEDS[0].state);
    put(&mut env, ALLOWED_FEEDS[0].feed, SYSTEM_PROGRAM, BTC_FEED.to_vec());
    env.warp(expiry as i64 - 5);
    env.expect_err(&[snap_ix(&env, &keys)], &[], "ConstraintOwner");
}

#[test]
fn take_snapshot_rejects_wrong_ocr2_state_and_owner() {
    let mut env = btc_env();
    install_eth(&mut env);
    let expiry = (env.clock + 3_600) as u64;
    let keys = open(&mut env, expiry, 1, true, ALLOWED_FEEDS[0].state);
    env.warp(expiry as i64 - 5);
    let ix = snap_ix_with(
        env.house_pk(),
        &keys,
        ALLOWED_FEEDS[1].state,
        ALLOWED_FEEDS[0].feed,
    );
    env.expect_err(&[ix], &[], "ConstraintAddress");

    env.set_account_owner(ALLOWED_FEEDS[0].state, SYSTEM_PROGRAM);
    env.expect_err(&[snap_ix(&env, &keys)], &[], "ConstraintOwner");
}

#[test]
fn take_snapshot_is_permissionless_and_checks_price_ts_and_right_edge() {
    let mut env = btc_env();
    let expiry = (env.clock + 3_600) as u64;
    let keys = open(&mut env, expiry, 1, true, ALLOWED_FEEDS[0].state);
    let stranger = env.fund_user(10_000);
    let sample = seen(R800_2);
    let counter = feed_counter(BTC_FEED);
    let expected_ts = i64::from_le_bytes(BTC_FEED[208..216].try_into().unwrap());
    let expected_price = i128::from_le_bytes(BTC_FEED[216..232].try_into().unwrap());

    for (offset, ts) in [
        (0u32, expiry as i64 - 9),
        (1, expiry as i64),
        (2, expiry as i64 + 9),
    ] {
        env.warp(ts);
        put(
            &mut env,
            ALLOWED_FEEDS[0].state,
            CHAINLINK_OCR2_PROGRAM_ID,
            state_with_round(sample.epoch, sample.round + offset as u8),
        );
        put(
            &mut env,
            ALLOWED_FEEDS[0].feed,
            CHAINLINK_STORE_PROGRAM_ID,
            feed_with_counter(counter + offset),
        );
        let ix = snap_ix_with(
            stranger.pk(),
            &keys,
            ALLOWED_FEEDS[0].state,
            ALLOWED_FEEDS[0].feed,
        );
        env.send(&[ix], &[&stranger.kp]);
    }

    let book = read_snap(&env, &keys);
    assert_eq!(book.entries.len(), 3);
    for (offset, entry) in book.entries.iter().enumerate() {
        assert_eq!(entry.counter, counter + offset as u32);
        assert_eq!(entry.ts, expected_ts);
        assert_eq!(entry.price, expected_price);
        assert_eq!(entry.at.epoch, sample.epoch);
        assert_eq!(entry.at.round, sample.round + offset as u8);
    }
}

#[test]
fn snapshot_matches_pair_at_nonzero_index() {
    let r1 = seen(R800_1);
    let pre = seen(R800_2);
    let post = seen(R800_4);
    let r6 = seen(R800_6);
    let counter = feed_counter(BTC_FEED);
    let end = pre.ts + 3;
    let mut env = btc_env();
    let keys = open(&mut env, end as u64, post.median, true, ALLOWED_FEEDS[0].state);

    record_pair(
        &mut env,
        &keys,
        r1.epoch,
        r1.round,
        counter,
        pre.epoch,
        pre.round,
        counter + 1,
        end - 5,
    );
    record_pair(
        &mut env,
        &keys,
        post.epoch,
        post.round,
        counter + 2,
        r6.epoch,
        r6.round,
        counter + 3,
        end - 4,
    );
    assert_eq!(read_snap(&env, &keys).entries.len(), 4);

    env.warp(post.ts);
    env.send(
        &[resolve_ix(
            &env,
            &keys,
            R800_2,
            R800_4,
            Some(snapshot_of(&keys)),
            ALLOWED_FEEDS[0].state,
        )],
        &[],
    );
    expect_settled(
        &env,
        &keys,
        MarketOutcome::Yes,
        post.median,
        post.ts,
        post.ts,
    );
}

#[test]
fn resolve_rejects_foreign_market_snapshot_pda() {
    let pre = seen(R800_2);
    let post = seen(R800_4);
    let counter = feed_counter(BTC_FEED);
    let end = pre.ts + 3;
    let mut env = btc_env();
    let market_a = open(&mut env, end as u64, post.median, true, ALLOWED_FEEDS[0].state);
    let market_b = open(&mut env, end as u64, post.median, true, ALLOWED_FEEDS[0].state);

    record_pair(
        &mut env,
        &market_a,
        pre.epoch,
        pre.round,
        counter,
        post.epoch,
        post.round,
        counter + 1,
        end - 5,
    );
    env.warp(post.ts);
    reject(
        &mut env,
        &market_b,
        R800_2,
        R800_4,
        Some(snapshot_of(&market_a)),
        ALLOWED_FEEDS[0].state,
        "ConstraintSeeds",
    );
}

#[test]
fn take_snapshot_blocked_when_stale_report_lands_and_adjacent_stale_burn_works_realistically() {
    let mut env = Env::new(1_700_000_000);
    env.ensure_feeds();
    put(
        &mut env,
        ALLOWED_FEEDS[0].feed,
        CHAINLINK_STORE_PROGRAM_ID,
        BTC_FEED.to_vec(),
    );
    let expiry = (env.clock + 3_600) as u64;
    let keys = open(&mut env, expiry, 100, true, ALLOWED_FEEDS[0].state);
    let trader = env.fund_user(200_000);
    env.bet(&keys, &trader, 40_000, MarketOutcome::Yes);

    env.warp(expiry as i64 + 11);
    env.expect_err(&[snap_ix(&env, &keys)], &[], "SnapshotOutOfWindow");

    env.queue_ocr2_reports(101, expiry as i64 + 11, expiry as i64 - 1);
    env.resolve(&keys);
    let m = env.read_market(&keys);
    assert_eq!(m.status, MarketStatus::StaleBurn);
    assert_eq!(m.settled_price, 0);
    assert_eq!(m.settled_publish_time, 0);
    let before = env.token_amount(ata(trader.pk(), env.mint));
    env.redeem(&keys, &trader, keys.yes_mint, 5);
    assert_eq!(env.token_amount(ata(trader.pk(), env.mint)) - before, 2);
}

fn synthetic_sign_with_keys(
    keys: &[SigningKey],
    digest_cfg: [u8; 32],
    ts: u32,
    observer_count: u8,
    median: i128,
) -> (Vec<u8>, Vec<u8>) {
    let mut rows: Vec<(&SigningKey, [u8; 20])> = keys
        .iter()
        .map(|sk| {
            let d = [9u8; 32];
            let (sig, recid) = sk.sign_prehash_recoverable(&d).unwrap();
            let pk = secp256k1_recover(&d, recid.to_byte(), sig.to_bytes().as_slice()).unwrap();
            let addr: [u8; 20] = keccak_hash(&pk.0).as_ref()[12..32].try_into().unwrap();
            (sk, addr)
        })
        .collect();
    rows.sort_by(|a, b| a.1.cmp(&b.1));

    let mut state = BTC_STATE.to_vec();
    state[272] = (keys.len() as u8).saturating_sub(1);
    state[320..352].copy_from_slice(&digest_cfg);
    for (i, (_, addr)) in rows.iter().enumerate() {
        let off = 4512 + i * 128;
        state[off..off + 20].copy_from_slice(addr);
    }
    state[6912..6920].copy_from_slice(&(rows.len() as u64).to_le_bytes());

    let mut ctx = [0u8; 96];
    ctx[..32].copy_from_slice(&digest_cfg);
    ctx[59..63].copy_from_slice(&1u32.to_be_bytes());
    ctx[63] = 2;

    let mut raw = [0u8; 61];
    raw[..4].copy_from_slice(&ts.to_be_bytes());
    raw[4] = observer_count;
    raw[37..53].copy_from_slice(&median.to_be_bytes());

    let digest = hashv(&[&[raw.len() as u8], &raw, &ctx]);
    let mut report = Vec::with_capacity(1 + 96 + 61 + 65 * rows.len());
    report.push(0);
    report.extend_from_slice(&ctx);
    report.extend_from_slice(&raw);
    for (sk, _) in rows {
        let (sig, recid) = sk.sign_prehash_recoverable(digest.as_ref()).unwrap();
        report.extend_from_slice(sig.to_bytes().as_slice());
        report.push(recid.to_byte());
    }
    (state, report)
}

#[test]
fn verify_report_rejects_empty_short_and_unaligned_signatures() {
    assert_eq!(verify_report(&[], BTC_STATE), Err(Ocr2Error::InvalidInput));
    assert_eq!(
        verify_report(&R800_3[..1 + 96 + 61], BTC_STATE),
        Err(Ocr2Error::InvalidInput)
    );
    let mut unaligned = R800_3.to_vec();
    unaligned.push(0xAA);
    assert_eq!(
        verify_report(&unaligned, BTC_STATE),
        Err(Ocr2Error::InvalidInput)
    );
}

#[test]
fn verify_report_rejects_invalid_recovery_id_and_zero_signature() {
    let mut bad_recid = R800_3.to_vec();
    let sig0_recid_off = 1 + 96 + 61 + 64;
    bad_recid[sig0_recid_off] = 4;
    assert_eq!(
        verify_report(&bad_recid, BTC_STATE),
        Err(Ocr2Error::InvalidInput)
    );

    let mut zero_sig = R800_3.to_vec();
    let sig0_off = 1 + 96 + 61;
    zero_sig[sig0_off..sig0_off + 64].fill(0);
    zero_sig[sig0_recid_off] = 0;
    assert_eq!(
        verify_report(&zero_sig, BTC_STATE),
        Err(Ocr2Error::InvalidSignature)
    );
}

#[test]
fn verify_report_rejects_excess_oracle_len_and_low_observer_count() {
    let mut bad_state = BTC_STATE.to_vec();
    bad_state[6912..6920].copy_from_slice(&20u64.to_le_bytes());
    assert_eq!(
        verify_report(R800_3, &bad_state),
        Err(Ocr2Error::InvalidInput)
    );

    let k1 = SigningKey::from_slice(&[10u8; 32]).unwrap();
    let k2 = SigningKey::from_slice(&[11u8; 32]).unwrap();
    let (state, report) = synthetic_sign_with_keys(&[k1, k2], *b"pm-ocr2-low-observer-count-test!", 1_700_000_000, 1, 42);
    assert_eq!(verify_report(&report, &state), Err(Ocr2Error::InvalidInput));
}

#[test]
fn verify_report_supports_f_zero_and_f_two() {
    let k1 = SigningKey::from_slice(&[10u8; 32]).unwrap();
    let k2 = SigningKey::from_slice(&[11u8; 32]).unwrap();
    let k3 = SigningKey::from_slice(&[12u8; 32]).unwrap();

    let (state_f0, report_f0) = synthetic_sign_with_keys(&[k1.clone()], *b"pm-ocr2-f-zero-config-test-v1!!!", 1_700_000_000, 3, 123);
    let ok0 = verify_report(&report_f0, &state_f0).expect("f=0 with 1 sig");
    assert_eq!(ok0.median, 123);
    let mut extra_sig = report_f0.clone();
    extra_sig.extend_from_slice(&report_f0[1 + 96 + 61..]);
    assert_eq!(
        verify_report(&extra_sig, &state_f0),
        Err(Ocr2Error::WrongNumberOfSignatures)
    );

    let (state_f2, report_f2) = synthetic_sign_with_keys(&[k1, k2, k3], *b"pm-ocr2-f-two-config-test-v1!!!!", 1_700_000_000, 7, 456);
    let ok2 = verify_report(&report_f2, &state_f2).expect("f=2 with 3 sigs");
    assert_eq!(ok2.median, 456);
    let mut short_f2 = report_f2.clone();
    short_f2.truncate(short_f2.len() - 65);
    assert_eq!(
        verify_report(&short_f2, &state_f2),
        Err(Ocr2Error::WrongNumberOfSignatures)
    );
}

#[test]
fn resolve_rejects_median_overflowing_i64() {
    let mut env = Env::new(1_700_000_000);
    env.ensure_feeds();
    let expiry = (env.clock + 3_600) as u64;
    let keys = open(&mut env, expiry, 100, true, ALLOWED_FEEDS[0].state);
    env.warp(expiry as i64 + 2);

    env.queue_ocr2_reports_i128(i128::from(i64::MAX) + 1, expiry as i64 + 2, expiry as i64 - 1);
    assert_logs_contain(env.resolve_raw(&keys), "InvalidPrice");
    unchanged(&env, &keys);

    env.queue_ocr2_reports_i128(i128::from(i64::MIN) - 1, expiry as i64 + 2, expiry as i64 - 1);
    assert_logs_contain(env.resolve_raw(&keys), "InvalidPrice");
    unchanged(&env, &keys);
}
