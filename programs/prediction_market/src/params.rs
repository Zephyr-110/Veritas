use anchor_lang::Accounts;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::*;
use crate::entity::*;

use crate::error::ErrorCode;
use crate::state::{MarketStatus, MarketOutcome};
use crate::constants::ADMIN_PUBKEY;


#[derive(Accounts)]
#[instruction(market_id: [u8; 16])]
pub struct CreateMarket<'info> {

    #[account(
        init,
        payer = signer,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", market_id.as_ref()],
        bump
    )]
    pub market: Account<'info, Market>, // 盘口 PDA 实例

    #[account(
        init,
        payer = signer,
        mint::decimals = 6,
        mint::authority = market,
        mint::freeze_authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump
    )]
    pub yes_mint: InterfaceAccount<'info, Mint>, // Yes 币

    #[account(
        init,
        payer = signer,
        mint::decimals = 6,
        mint::authority = market,
        mint::freeze_authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump
    )]
    pub no_mint: InterfaceAccount<'info, Mint>, // No 币

    pub token_program: Interface<'info, TokenInterface>,

    // #[account(
    //     constraint = collateral_mint.key() == crate::constants::USDT_PUBKEY @ ErrorCode::Unauthorized
    // )]
    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = signer,
        token::mint = collateral_mint,
        token::authority = market,
        seeds = [b"collateral_vault", market.key().as_ref()],
        bump
    )]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        // constraint = signer.key() == crate::constants::ADMIN_PUBKEY @ ErrorCode::Unauthorized, // 如果这里不是管理员公钥的话，会回滚
    )]
    pub signer: Signer<'info>, // 拿签名顺便鉴权。
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenMarket<'info> {
    #[account(
        mut,
        seeds = [b"market", market.id.as_ref()],
        constraint = market.status == MarketStatus::Upcoming @ ErrorCode::MarketStatusException,
        constraint = (clock.unix_timestamp as u64) >= market.open_at @ ErrorCode::MarketNotOpenYet,
        constraint = (clock.unix_timestamp as u64) <= market.expiry @ ErrorCode::MarketExpired,
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    pub signer: Signer<'info>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct UserBetOn<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = market.status == MarketStatus::Open @ ErrorCode::MarketStatusException,
        constraint = (clock.unix_timestamp as u64) >= market.open_at @ ErrorCode::MarketNotOpenYet,
        constraint = (clock.unix_timestamp as u64) <= market.expiry @ ErrorCode::MarketExpired,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        token::mint = collateral_mint,
        token::authority = signer,
    )]
    pub user_collateral: InterfaceAccount<'info, TokenAccount>, // 存放用户抵押物 ATA

    #[account(address = market.collateral_mint)]
    pub collateral_mint: InterfaceAccount<'info, Mint>, // 抵押物铸币厂

    #[account(
        mut,
        seeds = [b"collateral_vault", market.key().as_ref()],
        token::mint = collateral_mint,
        bump,
    )]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>, // 存抵押物的池子

    #[account(
        mut,
        constraint = outcome_mint.key() == market.yes_mint || outcome_mint.key() == market.no_mint @ ErrorCode::Unauthorized
    )]
    pub outcome_mint: InterfaceAccount<'info, Mint>, // 铸币厂

    #[account(
        mut,
        token::mint = outcome_mint,
        token::authority = signer,
    )]
    pub outcome_token_ata: InterfaceAccount<'info, TokenAccount>, // 用户存代币的 ATA

    pub clock: Sysvar<'info, Clock>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.id.as_ref()],
        constraint = signer.key() == market.authority @ ErrorCode::Unauthorized,
        constraint = market.status == MarketStatus::Open @ ErrorCode::MarketStatusException,
        constraint = (clock.unix_timestamp as u64) >= market.expiry @ ErrorCode::MarketExpired,
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct GetCollateral<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        mut,
        constraint = market.status == MarketStatus::Resolved @ ErrorCode::MarketStatusException,
        constraint = (market.yes_mint == token_mint.key()) || (market.no_mint == token_mint.key()) @ ErrorCode::TokenDislocation,
        seeds = [b"market", market.id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        constraint = Some(token_mint.key()) == market.yes_or_no() @ ErrorCode::WinnerException
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = signer,
    )]
    pub token_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: InterfaceAccount<'info, Mint>, // 抵押物铸币厂
    #[account(
        mut,
        seeds = [b"collateral_vault", market.key().as_ref()],
        token::mint = collateral_mint,
        bump = market.market_collateral_bump,
    )]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = collateral_mint,
        token::authority = signer,
    )]
    pub user_collateral_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}