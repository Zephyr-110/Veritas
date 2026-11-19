use anchor_lang::prelude::*;

#[constant]
pub const SERVICE_FEE : u64 = 30;

#[constant]
pub const RESOLVE_WINDOW: u64 = 172800;

#[constant]
pub const MAX_SETTLE_DELAY: i64 = 600;

#[constant]
pub const CLAIM_WINDOW: u64 = 2_592_000;

pub const PYTH_PUBKEY: Pubkey = pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

pub const PYTH_OWNER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");