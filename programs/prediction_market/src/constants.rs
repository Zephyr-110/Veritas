use anchor_lang::prelude::*;


#[constant]
pub const ADMIN_PUBKEY: Pubkey = pubkey!("DEPaDBPZeXhi8TfLpk4D5Niab6tnb8eF1e2hNUSSKKr8");

#[constant]
pub const USDT_PUBKEY: Pubkey = pubkey!("CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG");

#[constant]
pub const SERVICE_FEE : u64 = 30;

#[constant]
pub const RESOLVE_WINDOW: u64 = 100000;

#[constant]
pub const LP_POSITION_SEED: &[u8] = b"lp_position";

pub const PRICE_LOWER_BOUND: f64 = 1e-6;

pub const PRICE_UPPER_BOUND: f64 = 1.0 - 1e-6;

pub const MAX_SWAP_ITERATIONS: u8 = 12;
