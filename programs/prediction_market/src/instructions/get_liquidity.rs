use anchor_lang::context::{Context, CpiContext};
use anchor_lang::prelude::*;
use anchor_lang::{require, Accounts};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::{burn, transfer_checked, Burn, TransferChecked};
use anchor_spl::token_interface::*;
use crate::{Market};
use crate::error::ErrorCode;
use crate::state::*;


#[derive(Accounts)]
pub struct GetLiquidity<'info> {
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
        mint::authority = market,
        seeds = [b"lp_mint", market.key().as_ref()],
        bump
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump
    )]
    pub yes_mint: Box<InterfaceAccount<'info, Mint>>, // Yes token

    #[account(
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump
    )]
    pub no_mint: Box<InterfaceAccount<'info, Mint>>, // No token

    #[account(
        mut,
        associated_token::mint = yes_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub businessman_yes_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = no_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub businessman_no_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = lp_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub businessman_lp_ata: Box<InterfaceAccount<'info, TokenAccount>>,

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

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub fn get_liquidity(ctx: Context<GetLiquidity>, lp_amount: u64) -> Result<()> {
    let lp_supply = ctx.accounts.lp_mint.supply;
    require!(lp_amount > 0 , ErrorCode::ZeroLp);
    require!(lp_amount <= ctx.accounts.businessman_lp_ata.amount, ErrorCode::InsufficientBalance);

    // ======================== burn LP ========================
    let lp_cpi_account = Burn {
        mint: ctx.accounts.lp_mint.to_account_info(),
        from: ctx.accounts.businessman_lp_ata.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    let lp_cpi_program = ctx.accounts.token_program.key();
    let lo_cpi_context = CpiContext::new(lp_cpi_program, lp_cpi_account);
    burn(lo_cpi_context, lp_amount)?;

    // ======================== withdraw tokens pro rata ========================

    let seeds: &[&[&[u8]]] = &[&[b"market", ctx.accounts.market.id.as_ref(), &[ctx.accounts.market.bump]]];
    // Yes
    let yes_amount = (ctx.accounts.yes_pool.amount as u128)
        .checked_mul(lp_amount as u128)
        .unwrap()
        .checked_div(lp_supply as u128)
        .unwrap() as u64;
    let yes_cpi_account = TransferChecked {
        from: ctx.accounts.yes_pool.to_account_info(),
        mint: ctx.accounts.yes_mint.to_account_info(),
        to: ctx.accounts.businessman_yes_ata.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let yes_cpi_program = ctx.accounts.token_program.key();
    let yes_cpi_context = CpiContext::new_with_signer(yes_cpi_program, yes_cpi_account, seeds);
    transfer_checked(yes_cpi_context, yes_amount, ctx.accounts.yes_mint.decimals)?;

    // No
    let no_amount = (ctx.accounts.no_pool.amount as u128)
        .checked_mul(lp_amount as u128)
        .unwrap()
        .checked_div(lp_supply as u128)
        .unwrap() as u64;
    require!(no_amount > 0 || yes_amount > 0, ErrorCode::InvalidAmount);
    let no_cpi_account = TransferChecked {
        from: ctx.accounts.no_pool.to_account_info(),
        mint: ctx.accounts.no_mint.to_account_info(),
        to: ctx.accounts.businessman_no_ata.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let no_cpi_program = ctx.accounts.token_program.key();
    let no_cpi_context = CpiContext::new_with_signer(no_cpi_program, no_cpi_account, seeds);
    transfer_checked(no_cpi_context, no_amount, ctx.accounts.no_mint.decimals)?;
    msg!("LP {:?} withdrew:\nYes: {:?}\n No: {:?}", ctx.accounts.signer.key(), yes_amount, no_amount);

    Ok(())
}