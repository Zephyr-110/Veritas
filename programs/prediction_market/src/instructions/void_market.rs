use crate::RESOLVE_WINDOW;
use anchor_lang::Accounts;
use anchor_lang::context::Context;
use anchor_lang::prelude::*;
use crate::{Market};
use crate::state::MarketStatus;
use crate::error::ErrorCode;
use crate::math::{apply_accrual, compute_accrual};

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.id.as_ref()],
        constraint = ((clock.unix_timestamp as u64) > market.expiry + RESOLVE_WINDOW) @ ErrorCode::MarketNotOpen,
        constraint = market.status == MarketStatus::Open @ ErrorCode::MarketNotOpen,
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    let now = ctx.accounts.clock.unix_timestamp;
    let accrual = compute_accrual(market, now)?;
    apply_accrual(market, &accrual);

    market.status = MarketStatus::Burn;
    msg!("market {:?} voided ", market.id);
    Ok(())
}