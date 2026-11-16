use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use anchor_lang::prelude::Pubkey;
use fixed::types::I80F48;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_associated_token_account_interface::address::get_associated_token_address;

use super::ids::PROGRAM_ID;

static SEQ: AtomicU64 = AtomicU64::new(1);

pub fn bits_f64(bits: i128) -> f64 {
    I80F48::from_bits(bits).to_num::<f64>()
}

pub fn addr(pk: Pubkey) -> Address {
    Address::from(pk.to_bytes())
}

pub fn pk_from_signer(kp: &Keypair) -> Pubkey {
    Pubkey::new_from_array(kp.pubkey().to_bytes())
}

pub fn meta(pk: Pubkey, writable: bool, signer: bool) -> AccountMeta {
    if writable {
        AccountMeta::new(addr(pk), signer)
    } else {
        AccountMeta::new_readonly(addr(pk), signer)
    }
}

pub fn ata(owner: Pubkey, mint: Pubkey) -> Pubkey {
    get_associated_token_address(&owner, &mint)
}

pub fn next_market_id() -> [u8; 16] {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&n.to_le_bytes());
    id[8..].copy_from_slice(&n.wrapping_mul(0x9E3779B97F4A7C15).to_le_bytes());
    id
}

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

pub fn program_so() -> PathBuf {
    let p = repo_root().join("target/deploy/prediction_market.so");
    assert!(p.exists(), "missing {}, run `anchor build` first", p.display());
    p
}

pub fn band(ops: u32, thickness: f64) -> f64 {
    let _ = thickness;
    f64::from(ops).max(1.0) + 2.0
}

pub fn assert_close(actual: f64, expected: f64, band: f64, label: &str) {
    let err = (actual - expected).abs();
    println!(
        "{label}: actual={actual:.10} expected={expected:.10} err={err:.10} band={band:.10}"
    );
    assert!(
        err <= band,
        "{label}: err {err} > band {band} (actual={actual}, expected={expected})"
    );
}

pub struct Actor {
    pub kp: Keypair,
}

impl Actor {
    pub fn new() -> Self {
        Self { kp: Keypair::new() }
    }
    pub fn pk(&self) -> Pubkey {
        pk_from_signer(&self.kp)
    }
}

pub struct MarketKeys {
    pub id: [u8; 16],
    pub market: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub yes_pool: Pubkey,
    pub no_pool: Pubkey,
    pub vault: Pubkey,
    pub feed_id: [u8; 32],
    pub threshold: i64,
    pub exponent: i32,
    pub settle_above: bool,
    pub expiry: u64,
    pub start_ts: i64,
    pub seed: u64,
}

impl MarketKeys {
    pub fn derive(id: [u8; 16]) -> Self {
        let (market, _) = Pubkey::find_program_address(&[b"market", id.as_ref()], &PROGRAM_ID);
        let (yes_mint, _) = Pubkey::find_program_address(&[b"yes_mint", market.as_ref()], &PROGRAM_ID);
        let (no_mint, _) = Pubkey::find_program_address(&[b"no_mint", market.as_ref()], &PROGRAM_ID);
        let (yes_pool, _) = Pubkey::find_program_address(&[b"yes_pool", market.as_ref()], &PROGRAM_ID);
        let (no_pool, _) = Pubkey::find_program_address(&[b"no_pool", market.as_ref()], &PROGRAM_ID);
        let (vault, _) = Pubkey::find_program_address(&[b"collateral_vault", market.as_ref()], &PROGRAM_ID);
        Self {
            id,
            market,
            yes_mint,
            no_mint,
            yes_pool,
            no_pool,
            vault,
            feed_id: [7u8; 32],
            threshold: 100,
            exponent: -8,
            settle_above: true,
            expiry: 0,
            start_ts: 0,
            seed: 0,
        }
    }

    pub fn lp_position(&self, owner: Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[b"lp_position", self.market.as_ref(), owner.as_ref()],
            &PROGRAM_ID,
        )
        .0
    }
}

#[allow(dead_code)]
pub fn ix(program: Pubkey, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: addr(program), accounts, data }
}
