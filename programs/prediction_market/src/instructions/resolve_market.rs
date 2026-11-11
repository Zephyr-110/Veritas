use crate::{MAX_SETTLE_DELAY, RESOLVE_WINDOW};
use anchor_lang::Accounts;
use anchor_lang::context::Context;
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use crate::{Market, MarketOutcome};
use crate::state::MarketStatus;
use crate::error::ErrorCode;
use crate::math::{apply_accrual, compute_accrual};

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.id.as_ref()],
        constraint = market.status == MarketStatus::Open @ ErrorCode::MarketNotOpen,
        constraint = (clock.unix_timestamp as u64) >= market.expiry @ ErrorCode::MarketNotExpired,
        constraint = (clock.unix_timestamp as u64) <= market.expiry + RESOLVE_WINDOW @ ErrorCode::MarketNotExpired,
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn resolve_market(ctx: Context<ResolveMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    let now = ctx.accounts.clock.unix_timestamp;
    let accrual = compute_accrual(market, now)?;
    apply_accrual(market, &accrual);

    let price = ctx.accounts.price_update
        .get_price_no_older_than(
            &ctx.accounts.clock, u64::MAX, &market.feed_id
        )?;
    let prev_publish_time = ctx.accounts.price_update.price_message.prev_publish_time;

    require!(price.publish_time >= market.end_ts
    && prev_publish_time < market.end_ts,
    ErrorCode::NotFirstAfterExpiry);
    require!(price.exponent == market.exponent, ErrorCode::ExponentMismatch);
    // 超 10 秒直接销毁盘子
    if price.publish_time > market.end_ts + MAX_SETTLE_DELAY {
        market.status = MarketStatus::Burn;
        msg!("market {:?} voided ", market.id);
        return Ok(())
    }

    let yes_wins = if market.settle_above {
        price.price >= market.threshold
    } else {
        price.price < market.threshold
    };

    market.winner = if yes_wins { MarketOutcome::Yes } else { MarketOutcome::No };
    market.settled_price = price.price;
    market.settled_publish_time = price.publish_time;
    market.status = MarketStatus::Resolved;

    msg!("market {:?} resolved, winner {:?} ", market.id, market.winner);
    Ok(())
}