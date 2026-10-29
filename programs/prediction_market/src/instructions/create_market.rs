use anchor_lang::{Accounts, AnchorDeserialize, AnchorSerialize};
use anchor_lang::prelude::{Account, Interface, InterfaceAccount, Program, Signer, System};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::entity::Market;
use crate::error::ErrorCode;

use anchor_lang::prelude::*;
use anchor_spl::token_interface::*;

#[derive(Accounts)]
#[instruction(param: CreateMarketParams)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>, // the house

    pub oracle: Signer<'info>, // resolver

    #[account(
        init,
        payer = creator,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", param.market_id.as_ref()],
        bump
    )]
    pub market: Box<Account<'info, Market>>, // the market

    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>, // collateral mint; no restriction on which collateral or who creates

    #[account(
        init,
        payer = creator,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"lp_mint", market.key().as_ref()],
        bump
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>, // LP mint

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
        associated_token::mint = lp_mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program
    )]
    pub lp_creator_ata: Box<InterfaceAccount<'info, TokenAccount>>, // creator LP ATA

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
}

pub fn create_market(ctx: Context<CreateMarket>, param: CreateMarketParams, ) -> Result<()> {
    require!(param.expiry != u64::MAX && param.expiry > (ctx.accounts.clock.unix_timestamp as u64), ErrorCode::InvalidAmount);
    require!(param.collateral_amount > 0, ErrorCode::InvalidAmount);

    // ===================== assign fields first =====================

    let market = &mut ctx.accounts.market;
    market.creator = ctx.accounts.creator.key();
    market.oracle = ctx.accounts.oracle.key();
    market.expiry = param.expiry;
    market.id = param.market_id;
    market.bump = ctx.bumps.market;
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.status = crate::state::MarketStatus::Open;
    market.collateral_mint = ctx.accounts.collateral_mint.key();
    market.market_collateral_bump = ctx.bumps.collateral_vault;
    market.prediction = param.prediction;
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

    // ===================== mint LP =====================

    let lp_cpi_account = MintTo {
        mint: ctx.accounts.lp_mint.to_account_info(),
        to: ctx.accounts.lp_creator_ata.to_account_info(),
        authority: market.to_account_info(),
    };
    let seeds: &[&[&[u8]]] = &[&[b"market", param.market_id.as_ref(), &[ctx.bumps.market]]];
    let lp_cpi_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        lp_cpi_account,
        seeds
    );
    mint_to(lp_cpi_context, param.collateral_amount)?;
    msg!("create market---------");
    msg!("house received {:?} LP", param.collateral_amount);

    Ok(())
}