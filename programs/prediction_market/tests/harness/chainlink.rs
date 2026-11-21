//! In-process OCR2 reports for the spec and economic tests.
//!
//! Captured Chainlink transmits have fixed prices and timestamps, so they
//! cannot walk the settlement table (above/below, exactly 10s, stale).
//! These tests sign their own reports. The state account is the allowlisted
//! BTC address, owned by the OCR2 program. `f`, the signer roster, and
//! `latest_config_digest` are patched; `r_max` stays the captured protobuf
//! value. `ocr2_settle` overwrites this account with captured bytes whenever
//! it needs a real roster.

use anchor_lang::prelude::Pubkey;
use k256::ecdsa::SigningKey;
use prediction_market::math::verify_report;
use prediction_market::{ALLOWED_FEEDS, CHAINLINK_OCR2_PROGRAM_ID};
use solana_account::Account as SolAccount;
use solana_keccak_hasher::hash as keccak_hash;
use solana_secp256k1_recover::secp256k1_recover;
use solana_sha256_hasher::hashv;

use super::env::Env;
use super::util::addr;

const BTC_STATE: &[u8] = include_bytes!("../fixtures/btc_state.bin");
const ETH_STATE: &[u8] = include_bytes!("../fixtures/eth_state.bin");

const F_OFFSET: usize = 272;
const DIGEST_OFFSET: usize = 320;
const SIGNER0: usize = 4512;
const ORACLE_STRIDE: usize = 128;
const ORACLE_LEN_OFFSET: usize = 6912;
const STATE_LEN: usize = 6920;

const EPOCH: u32 = 1;
const PRE_ROUND: u8 = 1;
const POST_ROUND: u8 = 2;
const CONFIG_DIGEST: [u8; 32] = *b"pm-ocr2-synthetic-config-v1!!!!!";

pub fn btc_state() -> Pubkey {
    ALLOWED_FEEDS[0].state
}

pub fn eth_state() -> Pubkey {
    ALLOWED_FEEDS[1].state
}

fn signer_set() -> Vec<(SigningKey, [u8; 20])> {
    let mut rows: Vec<(SigningKey, [u8; 20])> = [[1u8; 32], [2u8; 32]]
        .into_iter()
        .map(|seed| {
            let sk = SigningKey::from_slice(&seed).expect("test signing key");
            let address = address_of(&sk);
            (sk, address)
        })
        .collect();
    rows.sort_by(|a, b| a.1.cmp(&b.1));
    rows
}

fn address_of(sk: &SigningKey) -> [u8; 20] {
    let digest = [9u8; 32];
    let (sig, recid) = sk
        .sign_prehash_recoverable(&digest)
        .expect("address signature");
    let pk = secp256k1_recover(
        digest.as_slice(),
        recid.to_byte(),
        sig.to_bytes().as_slice(),
    )
    .expect("recover test signer");
    let hash = keccak_hash(&pk.0);
    hash.as_ref()[12..32].try_into().expect("20 byte address")
}

pub fn synthetic_btc_state() -> Vec<u8> {
    assert_eq!(
        BTC_STATE.len(),
        STATE_LEN,
        "captured BTC state length drifted"
    );
    assert_eq!(BTC_STATE[F_OFFSET], 1, "f offset is not the captured BTC f");
    assert_eq!(
        &BTC_STATE[DIGEST_OFFSET..DIGEST_OFFSET + 2],
        &[0x00, 0x03],
        "digest offset drifted"
    );
    let mut data = BTC_STATE.to_vec();
    data[F_OFFSET] = 1;
    data[DIGEST_OFFSET..DIGEST_OFFSET + 32].copy_from_slice(&CONFIG_DIGEST);
    for (i, (_, address)) in signer_set().iter().enumerate() {
        let off = SIGNER0 + i * ORACLE_STRIDE;
        data[off..off + 20].copy_from_slice(address);
    }
    data[ORACLE_LEN_OFFSET..ORACLE_LEN_OFFSET + 8].copy_from_slice(&2u64.to_le_bytes());
    data
}

pub fn sign_report(ts: u32, median: i128, round: u8) -> Vec<u8> {
    let mut context = [0u8; 96];
    context[..32].copy_from_slice(&CONFIG_DIGEST);
    context[59..63].copy_from_slice(&EPOCH.to_be_bytes());
    context[63] = round;

    let mut raw = [0u8; 61];
    raw[..4].copy_from_slice(&ts.to_be_bytes());
    raw[4] = 4;
    raw[37..53].copy_from_slice(&median.to_be_bytes());

    let digest = hashv(&[&[raw.len() as u8], &raw, &context]);
    let mut out = Vec::with_capacity(1 + 96 + 61 + 65 * 2);
    out.push(0);
    out.extend_from_slice(&context);
    out.extend_from_slice(&raw);
    for (sk, _) in signer_set() {
        let (sig, recid) = sk
            .sign_prehash_recoverable(digest.as_ref())
            .expect("sign report");
        out.extend_from_slice(sig.to_bytes().as_slice());
        out.push(recid.to_byte());
    }
    out
}

pub fn queue_i128(env: &mut Env, median: i128, publish: i64, prev: i64) {
    let post_ts = u32::try_from(publish).expect("publish_time must fit a Chainlink u32 timestamp");
    let pre_ts = u32::try_from(prev).expect("prev_publish_time must fit a Chainlink u32 timestamp");
    let pre = sign_report(pre_ts, median, PRE_ROUND);
    let post = sign_report(post_ts, median, POST_ROUND);
    env.pending_reports = Some((pre, post));
}

pub fn queue(env: &mut Env, price: i64, publish: i64, prev: i64) {
    queue_i128(env, i128::from(price), publish, prev);
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
        .expect("install oracle account");
}

pub fn install(env: &mut Env) {
    let state = synthetic_btc_state();
    let sample = sign_report(1_700_000_000, 42, PRE_ROUND);
    verify_report(&sample, &state)
        .expect("synthetic OCR2 report must verify against the patched state");
    put(env, btc_state(), CHAINLINK_OCR2_PROGRAM_ID, state);
    put(
        env,
        eth_state(),
        CHAINLINK_OCR2_PROGRAM_ID,
        ETH_STATE.to_vec(),
    );
}

pub fn install_all_allowed_feeds(env: &mut Env) {
    install(env);
    for feed in &ALLOWED_FEEDS[2..] {
        put(
            env,
            feed.state,
            CHAINLINK_OCR2_PROGRAM_ID,
            BTC_STATE.to_vec(),
        );
    }
}
