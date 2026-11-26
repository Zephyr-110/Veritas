use anchor_lang::Accounts;
use anchor_lang::prelude::*;
use crate::{EpochRound, Market, MarketSnapshot, Snapshot};
use crate::state::*;
use crate::constants::*;
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct TakeSnapshot<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        constraint = market.status == MarketStatus::Open @ ErrorCode::MarketNotOpen,
        seeds = [b"market", market.id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"snapshot", market.key().as_ref()],
        bump
    )]
    pub snapshot: Account<'info, MarketSnapshot>,

    /// CHECK: 地址被 market 钉死、owner 由约束校验，handler 里只读原始字节
    #[account(address = market.ocr2_state, owner = CHAINLINK_OCR2_PROGRAM_ID)]
    pub ocr2_state: UncheckedAccount<'info>,

    /// CHECK: 地址在 handler 里按白名单反查校验、owner 由约束校验，只读原始字节
    #[account(owner = CHAINLINK_STORE_PROGRAM_ID)]
    pub feed: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
    pub system_program: Program<'info, System>,
}


// 官方账户偏移常量
pub const STATE_ROUND_OFFSET: usize = 273;
pub const STATE_EPOCH_OFFSET: usize = 276;
pub const FEED_COUNTER_OFFSET: usize = 143;
pub const FEED_TS_OFFSET: usize = 208;
pub const FEED_ANSWER_OFFSET: usize = 216;

pub fn take_snapshot(ctx: Context<TakeSnapshot>) -> Result<()> {
    let state_data = ctx.accounts.ocr2_state.try_borrow_data()?;
    let feed_data = ctx.accounts.feed.try_borrow_data()?;
    let market = &ctx.accounts.market;
    let snapshot = &mut ctx.accounts.snapshot;
    require!(
        snapshot.entries.len() < 16,
        ErrorCode::SnapshotFull
    );
    let now = ctx.accounts.clock.unix_timestamp;
    require!(
        now > market.end_ts - 10
        && now < market.end_ts + 10,
        ErrorCode::SnapshotOutOfWindow
    );

    let feed_info = find_feed(&ctx.accounts.market.ocr2_state)
        .ok_or(ErrorCode::FeedNotAllowed)?;
    require!(
        ctx.accounts.feed.key() == feed_info.feed,
        ErrorCode::BadFeedAccount
    );

    let round = state_data[STATE_ROUND_OFFSET];
    let epoch = u32::from_le_bytes(
        state_data[STATE_EPOCH_OFFSET..STATE_EPOCH_OFFSET + 4]
            .try_into()
            .unwrap(),
    );

    let counter = u32::from_le_bytes(
        feed_data[FEED_COUNTER_OFFSET..FEED_COUNTER_OFFSET + 4]
            .try_into()
            .map_err(|_| error!(ErrorCode::InvalidOracleInput))?,
    );

    let ts = i64::from_le_bytes(
        feed_data[FEED_TS_OFFSET..FEED_TS_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(ErrorCode::InvalidOracleInput))?,
    );

    let price = i128::from_le_bytes(
        feed_data[FEED_ANSWER_OFFSET..FEED_ANSWER_OFFSET + 16]
            .try_into()
            .map_err(|_| error!(ErrorCode::InvalidOracleInput))?,
    );

    let snap = Snapshot {
        at: EpochRound {epoch, round},
        counter,
        price,
        ts,
    };

    if let Some(last) = snapshot.entries.last() {
        require!(
            snap.counter > last.counter,
            ErrorCode::SnapshotStale
        )
    }

    snapshot.entries.push(snap);
    snapshot.bump = ctx.bumps.snapshot;

    Ok(())
}
