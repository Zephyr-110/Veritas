use crate::Archive;
use anchor_lang::Accounts;
use anchor_lang::context::Context;
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use crate::Market;
use crate::error::ErrorCode;
use crate::constants::*;
use crate::state::ArchiveStatus;

#[derive(Accounts)]
pub struct ArchivePrice<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [b"market", market.id.as_ref()],
        constraint = (clock.unix_timestamp as u64) >= market.expiry @ ErrorCode::MarketNotExpired,
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = signer,
        space = 8 + Archive::INIT_SPACE,
        seeds = [b"archive", market.key().as_ref()],
        bump
    )]
    pub archive: Account<'info, Archive>,

    #[account(
        seeds = [0u16.to_le_bytes().as_ref(), market.feed_id.as_ref()],
        seeds::program = PYTH_PUBKEY,
        bump
    )]
    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    pub clock: Sysvar<'info, Clock>,

    pub system_program: Program<'info, System>,
}

pub fn archive_price(ctx: Context<ArchivePrice>) -> Result<()> {
    require!(ctx.accounts.price_update.to_account_info().owner == &PYTH_OWNER, ErrorCode::PythOwnerException);

    let market = &ctx.accounts.market;
    let price_message = &ctx.accounts.price_update.price_message;
    let archive = &mut ctx.accounts.archive;
    require!(market.feed_id == price_message.feed_id, ErrorCode::FeedIdException);
    require!(market.exponent == price_message.exponent, ErrorCode::ExponentMismatch);
    if price_message.publish_time >= market.end_ts
    && price_message.prev_publish_time < market.end_ts {
        archive.archive_status = ArchiveStatus::Finish;
    } else if price_message.prev_publish_time >= market.end_ts { 
        archive.archive_status = ArchiveStatus::Fail;
    } else { 
        archive.archive_status = ArchiveStatus::Incomplete;
    }

    archive.feed_id = price_message.feed_id;
    archive.price = price_message.price;
    archive.conf = price_message.conf;
    archive.exponent = price_message.exponent;
    archive.publish_time = price_message.publish_time;
    archive.prev_publish_time = price_message.prev_publish_time;
    archive.ema_price = price_message.ema_price;
    archive.ema_conf = price_message.ema_conf;

    Ok(())
}