use anchor_lang::Accounts;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::Market;
use crate::error::ErrorCode;
use crate::state::MarketStatus;

use anchor_spl::token_interface::*;

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = market.status == MarketStatus::Open @ ErrorCode::MarketNotOpen,
        constraint = market.expiry > (clock.unix_timestamp as u64) @ ErrorCode::MarketExpired,
        seeds = [b"market", market.id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"lp_mint", market.key().as_ref()],
        bump
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump
    )]
    pub yes_mint: Box<InterfaceAccount<'info, Mint>>, // Yes Token Mint

    #[account(
        mut,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump
    )]
    pub no_mint: Box<InterfaceAccount<'info, Mint>>, // No Token Mint

    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = yes_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub businessman_yes_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = no_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub businessman_no_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = lp_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub lp_creator_ata: Box<InterfaceAccount<'info, TokenAccount>>, // Market Maker Lp Token ATA

    #[account(
        mut,
        token::mint = collateral_mint,
        token::authority = market,
        seeds = [b"collateral_vault", market.key().as_ref()],
        bump
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>, // Collateral Pool

    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub businessman_collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = market,
        seeds = [b"yes_pool", market.key().as_ref()],
        bump
    )]
    pub yes_pool: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = no_mint,
        token::authority = market,
        seeds = [b"no_pool", market.key().as_ref()],
        bump
    )]
    pub no_pool: Box<InterfaceAccount<'info, TokenAccount>>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub clock: Sysvar<'info, Clock>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub fn add_liquidity(ctx: Context<AddLiquidity>, collateral_amount: u64) -> Result<()> {
    require!(collateral_amount > 0, ErrorCode::InvalidAmount);
    require!(ctx.accounts.no_pool.amount > 0 && ctx.accounts.yes_pool.amount > 0, ErrorCode::EmptyPool);
    let decimals = ctx.accounts.collateral_mint.decimals;
    let market = &mut ctx.accounts.market;

    // ===================== Deposit of Collateral =====================

    let collateral_cpi_account = TransferChecked {
        mint: ctx.accounts.collateral_mint.to_account_info(),
        from: ctx.accounts.businessman_collateral_ata.to_account_info(),
        to: ctx.accounts.collateral_vault.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    let collateral_cpi_program = ctx.accounts.token_program.key();
    let collateral_cpi_context = CpiContext::new(collateral_cpi_program, collateral_cpi_account);
    transfer_checked(collateral_cpi_context, collateral_amount, decimals)?;
    msg!("Market Maker Capital Injection---------");
    msg!("LP {:?} deposited {:?} collateral", ctx.accounts.signer.key(), collateral_amount);

    // ===================== Transfer tokens to the market maker's own ATA =====================

    // 1.Yes Token
    let yes_cpi_account = MintTo {
        mint: ctx.accounts.yes_mint.to_account_info(),
        to: ctx.accounts.businessman_yes_ata.to_account_info(),
        authority: market.to_account_info(),
    };

    let seeds: &[&[&[u8]]] = &[&[b"market", market.id.as_ref(), &[market.bump]]];
    let yes_cpi_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        yes_cpi_account,
        seeds
    );
    mint_to(yes_cpi_context, collateral_amount)?;
    msg!("LP deposit---------");
    msg!("LP received {:?} Yes", collateral_amount);

    // 2.No Token
    let no_cpi_account = MintTo {
        mint: ctx.accounts.no_mint.to_account_info(),
        to: ctx.accounts.businessman_no_ata.to_account_info(),
        authority: market.to_account_info(),
    };
    let seeds: &[&[&[u8]]] = &[&[b"market", market.id.as_ref(), &[market.bump]]];
    let no_cpi_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        no_cpi_account,
        seeds
    );
    mint_to(no_cpi_context, collateral_amount)?;
    msg!("LP deposit---------");
    msg!("LP received {:?} No", collateral_amount);

    // ===================== Adding Tokens to a Pool =====================
    let yes_pool_amount = ctx.accounts.yes_pool.amount;
    let no_pool_amount = ctx.accounts.no_pool.amount;

    // 1. Calculate the transfer amount first.
    let yes_input_amount = if ctx.accounts.yes_pool.amount > ctx.accounts.no_pool.amount {
        collateral_amount } else {
        (collateral_amount as u128)
            .checked_mul(ctx.accounts.yes_pool.amount as u128)
            .unwrap()
            .checked_div(ctx.accounts.no_pool.amount as u128)
            .unwrap() as u64
    };
    let no_input_amount = (yes_input_amount as u128)
        .checked_mul(no_pool_amount as u128)
        .unwrap()
        .checked_div(yes_pool_amount as u128)
        .unwrap() as u64;
    require!(yes_input_amount > 0 && no_input_amount > 0, ErrorCode::InvalidAmount);

    // 2. Officially added to the pool

    let yes_pool_cpi_account = TransferChecked {
        from: ctx.accounts.businessman_yes_ata.to_account_info(),
        mint: ctx.accounts.yes_mint.to_account_info(),
        to: ctx.accounts.yes_pool.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    let yes_pool_cpi_program = ctx.accounts.token_program.key();
    let yes_pool_cpi_context = CpiContext::new(yes_pool_cpi_program, yes_pool_cpi_account);
    transfer_checked(yes_pool_cpi_context, yes_input_amount, decimals)?;

    let no_pool_cpi_account = TransferChecked {
        from: ctx.accounts.businessman_no_ata.to_account_info(),
        mint: ctx.accounts.no_mint.to_account_info(),
        to: ctx.accounts.no_pool.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    let no_pool_cpi_program = ctx.accounts.token_program.key();
    let no_pool_cpi_context = CpiContext::new(no_pool_cpi_program, no_pool_cpi_account);
    transfer_checked(no_pool_cpi_context, no_input_amount, decimals)?;
    msg!("LP deposit---------");
    msg!("LP added Yes {:?} and No {:?} to the pools", yes_input_amount, no_input_amount);

    // ===================== Mint Lp Token =====================

    let lp_cpi_account = MintTo {
        mint: ctx.accounts.lp_mint.to_account_info(),
        to: ctx.accounts.lp_creator_ata.to_account_info(),
        authority: market.to_account_info(),
    };
    let seeds: &[&[&[u8]]] = &[&[b"market", market.id.as_ref(), &[market.bump]]];
    let lp_cpi_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        lp_cpi_account,
        seeds
    );
    let lp_amount = (yes_input_amount as u128) // Prevent overflow
        .checked_mul(ctx.accounts.lp_mint.supply as u128)
        .unwrap()
        .checked_div(yes_pool_amount as u128)
        .unwrap() as u64;
    require!(lp_amount > 0, ErrorCode::ZeroLp);
    mint_to(lp_cpi_context, lp_amount)?;
    msg!("LP deposit---------");
    msg!("LP received {} LP tokens", lp_amount);

    Ok(())
}