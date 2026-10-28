use crate::RESOLVE_WINDOW;
use anchor_lang::Accounts;
use anchor_lang::context::Context;
use anchor_lang::prelude::*;
use crate::{Market, MarketOutcome};
use crate::state::MarketStatus;
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.id.as_ref()],
        constraint = signer.key() == market.oracle @ ErrorCode::Unauthorized,
        constraint = market.status == MarketStatus::Open @ ErrorCode::MarketNotOpen,
        constraint = (clock.unix_timestamp as u64) >= market.expiry @ ErrorCode::MarketNotExpired,
        constraint = (clock.unix_timestamp as u64) <= market.expiry + RESOLVE_WINDOW @ ErrorCode::MarketNotExpired,
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn resolve_market(ctx: Context<ResolveMarket>, market_winner: MarketOutcome) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.winner = market_winner;
    market.status = MarketStatus::Resolved;
    msg!("盘口 {:?} 裁决完毕，赢家为 {:?} ", market.id, market.winner);
    Ok(())
}