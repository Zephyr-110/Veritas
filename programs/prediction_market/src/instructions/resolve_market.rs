use crate::{MAX_SETTLE_DELAY, RESOLVE_WINDOW};
use anchor_lang::Accounts;
use anchor_lang::context::Context;
use anchor_lang::prelude::*;
use crate::{Market, MarketOutcome};
use crate::state::MarketStatus;
use crate::error::ErrorCode;
use crate::math::{apply_accrual, compute_accrual, verify_report};
use crate::constants::*;
use crate::math::ocr2::read_r_max;

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.id.as_ref()],
        constraint = market.status == MarketStatus::Open @ ErrorCode::MarketNotOpen,
        constraint = find_feed(&market.ocr2_state).is_some() @ ErrorCode::WrongOracleState,
        constraint = (clock.unix_timestamp as u64) >= market.expiry @ ErrorCode::MarketNotExpired,
        constraint = (clock.unix_timestamp as u64) <= market.expiry + RESOLVE_WINDOW @ ErrorCode::MarketNotInWindow,
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// CHECK:
    #[account(
        owner = CHAINLINK_OCR2_PROGRAM_ID,
        address = market.ocr2_state @ ErrorCode::WrongOracleState,
    )]
    pub ocr2_state: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ResolveMarketParam {
    pub raw_pre: Vec<u8>,
    pub raw_post: Vec<u8>,
}

pub fn resolve_market(ctx: Context<ResolveMarket>, param: ResolveMarketParam) -> Result<()> {
    let market = &mut ctx.accounts.market;

    let now = ctx.accounts.clock.unix_timestamp;
    let accrual = compute_accrual(market, now)?;
    apply_accrual(market, &accrual);

    let state_data = ctx.accounts.ocr2_state.try_borrow_data()?;

    let pre = verify_report(&param.raw_pre, &state_data)
        .map_err(|e| error!(ErrorCode::from(e)))?;
    let post = verify_report(&param.raw_post, &state_data)
        .map_err(|e| error!(ErrorCode::from(e)))?;
    let r_max = read_r_max(&state_data)
        .map_err(|e| error!(ErrorCode::from(e)))?;
    drop(state_data);

    require!(
        (pre.round == r_max && post.round == 1 && pre.epoch.checked_add(1) == Some(post.epoch))
        || (pre.round < r_max && Some(post.round) == pre.round.checked_add(1) && pre.epoch == post.epoch),
        ErrorCode::NotFirstAfterExpiry
    );

    let pre_ts = i64::from(pre.observations_timestamp);
    let post_ts = i64::from(post.observations_timestamp);
    require!(
        pre_ts < market.end_ts && post_ts >= market.end_ts,
        ErrorCode::NotFirstAfterExpiry
    );
    let settle_price = i64::try_from(post.median).map_err(|_| error!(ErrorCode::InvalidPrice))?;

    if post_ts > market.end_ts + MAX_SETTLE_DELAY {
        market.status = MarketStatus::StaleBurn;
        market.finish_ts = now as u64;
        msg!("market {:?} voided ", market.id);
        return Ok(())
    }

    let yes_wins = if market.settle_above {
        settle_price >= market.threshold
    } else {
        settle_price < market.threshold
    };


    market.winner = if yes_wins { Some(MarketOutcome::Yes) } else { Some(MarketOutcome::No) };
    market.finish_ts = now as u64;
    market.settled_price = settle_price;
    market.settled_publish_time = post_ts;
    market.status = MarketStatus::Resolved;

    msg!("market {:?} resolved, winner {:?} ", market.id, market.winner);
    Ok(())
}