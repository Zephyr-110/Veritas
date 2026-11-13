use anchor_lang::prelude::*;

#[constant]
pub const SERVICE_FEE : u64 = 30;

#[constant]
pub const RESOLVE_WINDOW: u64 = 172800;

#[constant]
pub const MAX_SETTLE_DELAY: i64 = 10;

#[constant]
pub const CLAIM_WINDOW: u64 = 2_592_000;