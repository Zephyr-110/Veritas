use anchor_lang::context::{Context, CpiContext};
use anchor_lang::prelude::*;
use anchor_lang::{require, Accounts};
use anchor_spl::token_2022::{transfer_checked, TransferChecked};
use anchor_spl::token_interface::*;
use crate::{get_amount, Market, MarketOutcome};
use crate::state::*;
use crate::error::ErrorCode;


#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = market.status == MarketStatus::Open @ ErrorCode::MarketNotOpen,
        constraint = (clock.unix_timestamp as u64) < market.expiry @ ErrorCode::MarketExpired,
        seeds = [b"market", market.id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump
    )]
    pub yes_mint: Box<InterfaceAccount<'info, Mint>>, // mint

    #[account(
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump
    )]
    pub no_mint: Box<InterfaceAccount<'info, Mint>>, // mint

    #[account(
        mut,
        associated_token::mint = yes_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub yes_token_ata: Box<InterfaceAccount<'info, TokenAccount>>, // user token ATA

    #[account(
        mut,
        associated_token::mint = no_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub no_token_ata: Box<InterfaceAccount<'info, TokenAccount>>, // user token ATA

    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = market,
        seeds = [b"yes_pool", market.key().as_ref()],
        bump
    )]
    pub yes_pool: Box<InterfaceAccount<'info, TokenAccount>>, // Yes pool

    #[account(
        mut,
        token::mint = no_mint,
        token::authority = market,
        seeds = [b"no_pool", market.key().as_ref()],
        bump
    )]
    pub no_pool: Box<InterfaceAccount<'info, TokenAccount>>, // No pool

    pub clock: Sysvar<'info, Clock>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SwapParams {
    pub min_out: u64,
    pub amount_in: u64,
    pub token_type: MarketOutcome,
}

pub fn swap(ctx: Context<Swap>, param: SwapParams) -> Result<()> {
    require!(ctx.accounts.market.oracle != ctx.accounts.signer.key(), ErrorCode::AuthorityCannotTrade);
    require!(param.amount_in > 0, ErrorCode::InvalidAmount);
    let token_type = param.token_type;
    let yes_pool_amount = ctx.accounts.yes_pool.amount;
    let no_pool_amount = ctx.accounts.no_pool.amount;
    require!(yes_pool_amount > 0 && no_pool_amount > 0, ErrorCode::EmptyPool);
    let decimals = ctx.accounts.yes_mint.decimals;
    let seeds: &[&[&[u8]]] = &[&[b"market", ctx.accounts.market.id.as_ref(), &[ctx.accounts.market.bump]]];
    match token_type {
        MarketOutcome::Yes => {
            // 1. No into the pool
            require!(ctx.accounts.no_token_ata.amount >= param.amount_in, ErrorCode::InsufficientBalance); // not enough to deposit, revert
            let no_amount = param.amount_in;
            let no_input_account = TransferChecked {
                from: ctx.accounts.no_token_ata.to_account_info(),
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.no_pool.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            };
            let input_program = ctx.accounts.token_program.key();
            let no_input_context = CpiContext::new(
                input_program,
                no_input_account,
            );
            transfer_checked(no_input_context, no_amount, decimals)?;
            // 2. Yes to the user
            let yes_amount = get_amount(yes_pool_amount, no_pool_amount, param.amount_in);
            require!(yes_amount > 0 && yes_amount >= param.min_out, ErrorCode::SlippageExceeded);
            let yes_input_account = TransferChecked {
                from: ctx.accounts.yes_pool.to_account_info(),
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.yes_token_ata.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            };
            let yes_input_context = CpiContext::new_with_signer(
                input_program,
                yes_input_account,
                seeds,
            );
            transfer_checked(yes_input_context, yes_amount, decimals)?;
            msg!("user swap---------");
            msg!("user {:?} received {:?} Yes", ctx.accounts.signer.key(), yes_amount);
        }

        MarketOutcome::No => {
            // 1. Yes into the pool
            require!(ctx.accounts.yes_token_ata.amount >= param.amount_in, ErrorCode::InsufficientBalance); // not enough to deposit, revert
            let yes_amount = param.amount_in;
            let yes_input_account = TransferChecked {
                from: ctx.accounts.yes_token_ata.to_account_info(),
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.yes_pool.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            };
            let input_program = ctx.accounts.token_program.key();
            let yes_input_context = CpiContext::new(
                input_program,
                yes_input_account,
            );
            transfer_checked(yes_input_context, yes_amount, decimals)?;
            let no_amount = get_amount(no_pool_amount, yes_pool_amount, param.amount_in);
            require!(no_amount > 0 && no_amount >= param.min_out, ErrorCode::SlippageExceeded);
            let no_input_account = TransferChecked {
                from: ctx.accounts.no_pool.to_account_info(),
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.no_token_ata.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            };
            let no_input_context = CpiContext::new_with_signer(
                input_program,
                no_input_account,
                seeds,
            );
            transfer_checked(no_input_context, no_amount, decimals)?;
            msg!("user bet---------");
            msg!("user {:?} received {:?} No", ctx.accounts.signer.key(), no_amount);
        }
    }
    Ok(())
}