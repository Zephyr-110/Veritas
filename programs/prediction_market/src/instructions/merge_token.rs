use anchor_lang::context::{Context, CpiContext};
use anchor_lang::prelude::*;
use anchor_lang::{require, Accounts};
use anchor_spl::token_2022::{burn, transfer_checked, Burn, TransferChecked};
use anchor_spl::token_interface::*;
use crate::{Market};
use crate::error::ErrorCode;
use crate::state::*;

#[derive(Accounts)]
pub struct MergeToken<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = market.status == MarketStatus::Open || market.status == MarketStatus::Resolved || market.status == MarketStatus::Burn @ ErrorCode::MarketNotTradable,
        seeds = [b"market", market.id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        token::mint = collateral_mint,
        token::authority = signer,
    )]
    pub collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = market.collateral_mint)]
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,// user collateral ATA

    #[account(
        mut,
        seeds = [b"collateral_vault", market.key().as_ref()],
        token::mint = collateral_mint,
        bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump
    )]
    pub yes_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump
    )]
    pub no_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = yes_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub yes_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = no_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub no_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn merge_token(ctx: Context<MergeToken>, merge_amount: u64) -> Result<()> {
    let input_or = ctx.accounts.no_token_ata.amount > 0
        && ctx.accounts.yes_token_ata.amount > 0
        && ctx.accounts.yes_token_ata.amount >= merge_amount
        && ctx.accounts.no_token_ata.amount >= merge_amount;
    require!(merge_amount > 0, ErrorCode::InvalidAmount);
    require!(input_or, ErrorCode::InsufficientBalance);

    // ======================== merge tokens ========================

    // 1. burn the tokens first

    // Yes
    let yes_cpi_account = Burn {
        mint: ctx.accounts.yes_mint.to_account_info(),
        from: ctx.accounts.yes_token_ata.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    let yes_cpi_program = ctx.accounts.token_program.key();
    let yes_cpi_context = CpiContext::new(yes_cpi_program, yes_cpi_account);
    burn(yes_cpi_context, merge_amount)?;

    // No
    let no_cpi_account = Burn {
        mint: ctx.accounts.no_mint.to_account_info(),
        from: ctx.accounts.no_token_ata.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    let no_cpi_program = ctx.accounts.token_program.key();
    let no_cpi_context = CpiContext::new(no_cpi_program, no_cpi_account);
    burn(no_cpi_context, merge_amount)?;

    // 2. pay the user
    let collateral_seeds: &[&[&[u8]]] = &[&[b"market", ctx.accounts.market.id.as_ref(), &[ctx.accounts.market.bump]]];
    let collateral_cpi_account = TransferChecked {
        from: ctx.accounts.collateral_vault.to_account_info(),
        mint: ctx.accounts.collateral_mint.to_account_info(),
        to: ctx.accounts.collateral_ata.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let collateral_cpi_program = ctx.accounts.token_program.key();
    let collateral_cpi_context = CpiContext::new_with_signer(
        collateral_cpi_program,
        collateral_cpi_account,
        collateral_seeds,
    );
    msg!("merge tokens---------");
    msg!("user {:?} merged {:?} tokens", ctx.accounts.signer.key(), merge_amount);
    transfer_checked(collateral_cpi_context, merge_amount, ctx.accounts.collateral_mint.decimals)?;
    Ok(())
}