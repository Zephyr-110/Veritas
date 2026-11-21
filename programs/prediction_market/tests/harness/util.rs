use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::SystemTime;

use anchor_lang::prelude::Pubkey;
use fixed::types::I80F48;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_associated_token_account_interface::address::{
    get_associated_token_address, get_associated_token_address_with_program_id,
};

use super::ids::PROGRAM_ID;

static SEQ: AtomicU64 = AtomicU64::new(1);
static SO_FRESHNESS: OnceLock<Option<String>> = OnceLock::new();

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

pub fn ata_with(owner: Pubkey, mint: Pubkey, token_program: Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(&owner, &mint, &token_program)
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

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

fn check_so_fresh(so_path: &Path) -> Option<String> {
    if std::env::var_os("PM_ALLOW_STALE_SO").is_some() {
        return None;
    }
    let so_mtime: SystemTime = std::fs::metadata(so_path)
        .and_then(|m| m.modified())
        .unwrap_or_else(|e| panic!("stat {}: {e}", so_path.display()));
    let crate_dir = repo_root().join("programs/prediction_market");
    let mut files = vec![crate_dir.join("Cargo.toml")];
    collect_rs_files(&crate_dir.join("src"), &mut files);
    for path in files {
        let mtime = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .unwrap_or_else(|e| panic!("stat {}: {e}", path.display()));
        if mtime > so_mtime {
            return Some(format!(
                "stale prediction_market.so: {} is newer than {}; run 'cargo build-sbf --arch v0' (or set PM_ALLOW_STALE_SO=1)",
                path.display(),
                so_path.display()
            ));
        }
    }
    None
}

pub fn program_so() -> PathBuf {
    let p = repo_root().join("target/deploy/prediction_market.so");
    assert!(
        p.exists(),
        "missing {}, run `anchor build` first",
        p.display()
    );
    if let Some(msg) = SO_FRESHNESS.get_or_init(|| check_so_fresh(&p)) {
        panic!("{msg}");
    }
    p
}

pub fn band(ops: u32, thickness: f64) -> f64 {
    let _ = thickness;
    f64::from(ops).max(1.0) + 2.0
}

pub fn assert_close(actual: f64, expected: f64, band: f64, label: &str) {
    let err = (actual - expected).abs();
    println!("{label}: actual={actual:.10} expected={expected:.10} err={err:.10} band={band:.10}");
    assert!(
        err <= band,
        "{label}: err {err} > band {band} (actual={actual}, expected={expected})"
    );
}

pub fn assert_logs_contain(
    res: Result<TransactionMetadata, FailedTransactionMetadata>,
    needle: &str,
) {
    assert_logs_fail(res, &[needle]);
}

pub fn assert_logs_fail(
    res: Result<TransactionMetadata, FailedTransactionMetadata>,
    needles: &[&str],
) {
    let err = res.expect_err("expected failure");
    let blob = format!("{:?}\n{}", err.err, err.meta.logs.join("\n"));
    assert!(
        needles.iter().any(|n| blob.contains(n)),
        "wanted one of {needles:?} in:\n{blob}"
    );
}

pub fn mix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
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
    pub snapshot: Pubkey,
    pub ocr2_state: Pubkey,
    pub threshold: i64,
    pub settle_above: bool,
    pub expiry: u64,
    pub start_ts: i64,
    pub seed: u64,
}

impl MarketKeys {
    pub fn derive(id: [u8; 16]) -> Self {
        let (market, _) = Pubkey::find_program_address(&[b"market", id.as_ref()], &PROGRAM_ID);
        let (yes_mint, _) =
            Pubkey::find_program_address(&[b"yes_mint", market.as_ref()], &PROGRAM_ID);
        let (no_mint, _) =
            Pubkey::find_program_address(&[b"no_mint", market.as_ref()], &PROGRAM_ID);
        let (yes_pool, _) =
            Pubkey::find_program_address(&[b"yes_pool", market.as_ref()], &PROGRAM_ID);
        let (no_pool, _) =
            Pubkey::find_program_address(&[b"no_pool", market.as_ref()], &PROGRAM_ID);
        let (vault, _) =
            Pubkey::find_program_address(&[b"collateral_vault", market.as_ref()], &PROGRAM_ID);
        let (snapshot, _) =
            Pubkey::find_program_address(&[b"snapshot", market.as_ref()], &PROGRAM_ID);
        Self {
            id,
            market,
            yes_mint,
            no_mint,
            yes_pool,
            no_pool,
            vault,
            snapshot,
            ocr2_state: prediction_market::ALLOWED_FEEDS[0].state,
            threshold: 100,
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
    Instruction {
        program_id: addr(program),
        accounts,
        data,
    }
}
