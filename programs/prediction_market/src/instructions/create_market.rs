use anchor_lang::{Accounts, AnchorDeserialize, AnchorSerialize};
use anchor_lang::prelude::{Account, Interface, InterfaceAccount, Program, Signer, System};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::entity::{LpPosition, Market};
use crate::error::ErrorCode;
use crate::math::*;

use anchor_lang::prelude::*;
use anchor_spl::token_interface::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use crate::RESOLVE_WINDOW;

#[derive(Accounts)]
#[instruction(param: CreateMarketParams)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>, // the house

    #[account(
        init,
        payer = creator,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", param.market_id.as_ref()],
        constraint = collateral_mint.to_account_info().owner == &anchor_spl::token::ID @ ErrorCode::InvalidMint,
        bump
    )]
    pub market: Box<Account<'info, Market>>, // the market

    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    #[account(
        init,
        payer = creator,
        space = 8 + LpPosition::INIT_SPACE,
        seeds = [b"lp_position", market.key().as_ref(), creator.key().as_ref()],
        bump
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>, // collateral mint; no restriction on which collateral or who creates

    #[account(
        init,
        payer = creator,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump
    )]
    pub yes_mint: Box<InterfaceAccount<'info, Mint>>, // Yes token

    #[account(
        init,
        payer = creator,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump
    )]
    pub no_mint: Box<InterfaceAccount<'info, Mint>>, // No token

    #[account(
        init,
        payer = creator,
        token::mint = collateral_mint,
        token::authority = market,
        seeds = [b"collateral_vault", market.key().as_ref()],
        bump
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>, // collateral vault

    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program
    )]
    pub creator_collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>, // creator collateral ATA, included because initial liquidity is deposited

    #[account(
        init,
        payer = creator,
        token::mint = yes_mint,
        token::authority = market,
        seeds = [b"yes_pool", market.key().as_ref()],
        bump
    )]
    pub yes_pool: Box<InterfaceAccount<'info, TokenAccount>>, // Yes pool

    #[account(
        init,
        payer = creator,
        token::mint = no_mint,
        token::authority = market,
        seeds = [b"no_pool", market.key().as_ref()],
        bump
    )]
    pub no_pool: Box<InterfaceAccount<'info, TokenAccount>>, // No pool

    pub clock: Sysvar<'info, Clock>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateMarketParams {
    pub expiry: u64,
    pub market_id: [u8; 16],
    pub prediction: [u8; 64],
    pub collateral_amount: u64,

    pub threshold: i64,
    pub settle_above: bool,
}

pub fn create_market(ctx: Context<CreateMarket>, param: CreateMarketParams, ) -> Result<()> {
    // The sum of the expiration time and the adjudication window must not exceed Max.
    require!(param.expiry.checked_add(RESOLVE_WINDOW).is_some()
        && param.expiry > (ctx.accounts.clock.unix_timestamp as u64),
        ErrorCode::InvalidAmount); //
    require!(param.collateral_amount > 1_000_000, ErrorCode::InvalidAmount);

    // ===================== assign fields first =====================

    let market = &mut ctx.accounts.market;
    market.creator = ctx.accounts.creator.key();
    market.expiry = param.expiry;
    market.id = param.market_id;
    market.bump = ctx.bumps.market;
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.status = crate::state::MarketStatus::Open;
    market.collateral_mint = ctx.accounts.collateral_mint.key();
    market.market_collateral_bump = ctx.bumps.collateral_vault;
    market.prediction = param.prediction;
    market.finish_ts = 0;

    market.end_ts = param.expiry as i64;
    market.last_accrual_ts = ctx.accounts.clock.unix_timestamp;
    market.fee_bps = crate::SERVICE_FEE as u16;

    market.feed_id = ctx.accounts.price_update.price_message.feed_id;
    market.exponent = ctx.accounts.price_update.price_message.exponent;
    market.threshold = param.threshold;
    market.settle_above = param.settle_above;
    market.settled_price = 0;
    market.settled_publish_time = 0;

    let duration = market.end_ts - market.last_accrual_ts;
    let l_zero = suggest_l_zero_for_budget(param.collateral_amount, duration)?;
    let l_eff = l_effective(l_zero, duration)?;
    let (reserve_yes, reserve_no) = reserves_from_price( // 两种币的当前储备
        fixed::types::I80F48::lit("0.5"),
        l_eff,
    )?;
    market.set_l_zero_fixed(l_zero);
    market.set_reserve_yes_fixed(reserve_yes);
    market.set_reserve_no_fixed(reserve_no);
    market.set_cum_yes_per_share_fixed(fixed::types::I80F48::ZERO);
    market.set_cum_no_per_share_fixed(fixed::types::I80F48::ZERO);
    market.set_total_lp_shares_fixed(fixed::types::I80F48::from_num(param.collateral_amount));
    msg!("create market---------");
    msg!("Market ID：{:?}", param.market_id);
    msg!("create market collateral: {:?}", market.collateral_mint.key());
    // ===================== transfer into the collateral vault =====================

    let decimals = ctx.accounts.collateral_mint.decimals;

    let collateral_cpi_account = TransferChecked {
        mint: ctx.accounts.collateral_mint.to_account_info(),
        from: ctx.accounts.creator_collateral_ata.to_account_info(),
        to: ctx.accounts.collateral_vault.to_account_info(),
        authority: ctx.accounts.creator.to_account_info(),
    };
    let collateral_cpi_program = ctx.accounts.token_program.key();
    let collateral_cpi_context = CpiContext::new(collateral_cpi_program, collateral_cpi_account);
    transfer_checked(collateral_cpi_context, param.collateral_amount, decimals)?;
    msg!("create market---------");
    msg!("house seeded the market with {:?} ", param.collateral_amount);

    // ===================== mint tokens into the pools =====================

    // 1.Yes token
    let yes_cpi_account = MintTo {
        mint: ctx.accounts.yes_mint.to_account_info(),
        to: ctx.accounts.yes_pool.to_account_info(),
        authority: market.to_account_info(),
    };

    let seeds: &[&[&[u8]]] = &[&[b"market", param.market_id.as_ref(), &[ctx.bumps.market]]];
    let yes_cpi_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        yes_cpi_account,
        seeds
    );
    mint_to(yes_cpi_context, param.collateral_amount)?;
    msg!("create market---------");
    msg!("house added {:?} Yes to the pool", param.collateral_amount);

    // 2.No token
    let no_cpi_account = MintTo {
        mint: ctx.accounts.no_mint.to_account_info(),
        to: ctx.accounts.no_pool.to_account_info(),
        authority: market.to_account_info(),
    };
    let seeds: &[&[&[u8]]] = &[&[b"market", param.market_id.as_ref(), &[ctx.bumps.market]]];
    let no_cpi_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        no_cpi_account,
        seeds
    );
    mint_to(no_cpi_context, param.collateral_amount)?;
    msg!("create market---------");
    msg!("house added {:?} No to the pool", param.collateral_amount);

    // ===================== initialize house LP position =====================

    let position = &mut ctx.accounts.lp_position;
    position.owner = ctx.accounts.creator.key();
    position.bump = ctx.bumps.lp_position;
    position.set_shares_fixed(fixed::types::I80F48::from_num(param.collateral_amount));
    position.set_checkpoint_yes_fixed(fixed::types::I80F48::ZERO);
    position.set_checkpoint_no_fixed(fixed::types::I80F48::ZERO);

    Ok(())
}