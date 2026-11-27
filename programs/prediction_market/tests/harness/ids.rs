use anchor_lang::prelude::{pubkey, Pubkey};

pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM: Pubkey = pubkey!("11111111111111111111111111111111");
pub const CLOCK_ID: Pubkey = pubkey!("SysvarC1ock11111111111111111111111111111111");
pub const PROGRAM_ID: Pubkey = prediction_market::ID;
pub const FEE_BPS: f64 = 50.0;
pub const FEE_DEN: f64 = 10_000.0;
pub const RESOLVE_WINDOW: u64 = 172_800;
pub const MAX_SETTLE_DELAY: i64 = 10;
pub const CLAIM_WINDOW: u64 = 2_592_000;
pub const DECIMALS: u8 = 6;
