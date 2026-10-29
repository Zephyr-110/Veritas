use anchor_lang::context::{Context, CpiContext};
use anchor_lang::prelude::*;
use anchor_lang::{require, Accounts};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::{mint_to, transfer_checked, MintTo, TransferChecked};
use anchor_spl::token_interface::*;
use crate::{get_amount, Market, MarketOutcome};
use crate::state::*;
use crate::error::ErrorCode;


#[derive(Accounts)]
pub struct UserBetOn<'info> {
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
        mut,
        token::mint = collateral_mint,
        token::authority = signer,
    )]
    pub collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>, // user collateral ATA

    #[account(address = market.collateral_mint)]
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>, // collateral mint

    #[account(
        mut,
        seeds = [b"collateral_vault", market.key().as_ref()],
        token::mint = collateral_mint,
        bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>, // collateral vault

    #[account(
        mut,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump
    )]
    pub yes_mint: Box<InterfaceAccount<'info, Mint>>, // mint

    #[account(
        mut,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump
    )]
    pub no_mint: Box<InterfaceAccount<'info, Mint>>, // mint

    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = yes_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub yes_token_ata: Box<InterfaceAccount<'info, TokenAccount>>, // user token ATA

    #[account(
        init_if_needed,
        payer = signer,
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

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct UserBetOnParams {
    pub min_out: u64,
    pub collateral_amount: u64,
    pub token_type: MarketOutcome,
}


pub fn user_bet_on(ctx: Context<UserBetOn>, param: UserBetOnParams, ) -> Result<()> {
    require!(ctx.accounts.market.oracle != ctx.accounts.signer.key(), ErrorCode::AuthorityCannotTrade);
    let collateral_deduct = param.collateral_amount;
    require!(collateral_deduct > 0, ErrorCode::InvalidAmount);
    let decimals = ctx.accounts.collateral_mint.decimals;
    let market = &mut ctx.accounts.market;
    // ======================== take collateral ========================

    let collateral_cpi_account = TransferChecked {
        from: ctx.accounts.collateral_ata.to_account_info(),
        mint: ctx.accounts.collateral_mint.to_account_info(),
        to: ctx.accounts.collateral_vault.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    let collateral_cpi_program = ctx.accounts.token_program.key();
    let collateral_cpi_context = CpiContext::new(
        collateral_cpi_program,
        collateral_cpi_account
    );
    transfer_checked(collateral_cpi_context, param.collateral_amount, decimals)?;
    msg!("user bet---------");
    msg!("user {:?} bet {:?} collateral", ctx.accounts.signer.key(), param.collateral_amount);

    // ======================== mint tokens ========================
    let market_seeds: &[&[&[u8]]] = &[&[b"market", market.id.as_ref(), &[market.bump]]];
    // 1. Yes token

    let yes_cpi_account = MintTo {
        mint: ctx.accounts.yes_mint.to_account_info(),
        to: ctx.accounts.yes_token_ata.to_account_info(),
        authority: market.to_account_info(),
    };
    let yes_cpi_program = ctx.accounts.token_program.key();
    let yes_cpi_context = CpiContext::new_with_signer(yes_cpi_program, yes_cpi_account, market_seeds);
    mint_to(yes_cpi_context, param.collateral_amount)?;
    // 1. No token

    let no_cpi_account = MintTo {
        mint: ctx.accounts.no_mint.to_account_info(),
        to: ctx.accounts.no_token_ata.to_account_info(),
        authority: market.to_account_info(),
    };
    let no_cpi_program = ctx.accounts.token_program.key();
    let no_cpi_context = CpiContext::new_with_signer(no_cpi_program, no_cpi_account, market_seeds);
    mint_to(no_cpi_context, param.collateral_amount)?;

    // ======================== swap into the token the user wants ========================

    let yes_pool_amount = ctx.accounts.yes_pool.amount;
    require!(yes_pool_amount > 0, ErrorCode::EmptyPool);
    let no_pool_amount = ctx.accounts.no_pool.amount;
    require!(no_pool_amount > 0, ErrorCode::EmptyPool);
    let token_type = if param.token_type == MarketOutcome::Yes { true } else { false };
    if token_type {// No to Yes
        // 1. No into the pool
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
        transfer_checked(no_input_context, param.collateral_amount, decimals)?;
        // 2. Yes to the user
        let yes_input_account = TransferChecked {
            from: ctx.accounts.yes_pool.to_account_info(),
            mint: ctx.accounts.yes_mint.to_account_info(),
            to: ctx.accounts.yes_token_ata.to_account_info(),
            authority: market.to_account_info(),
        };
        let yes_input_context = CpiContext::new_with_signer(
            input_program,
            yes_input_account,
            market_seeds,
        );
        let input_amount = get_amount(yes_pool_amount, no_pool_amount, param.collateral_amount);
        require!(input_amount > 0 && input_amount >= param.min_out, ErrorCode::SlippageExceeded);
        transfer_checked(yes_input_context, input_amount, decimals)?;
        msg!("user bet---------");
        msg!("user {:?} received {:?} Yes", ctx.accounts.signer.key(), input_amount);
    } else {
        // Yes to No
        // 1. Yes into the pool
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
        transfer_checked(yes_input_context, param.collateral_amount, decimals)?;
        // 2. No to the user
        let no_input_account = TransferChecked {
            from: ctx.accounts.no_pool.to_account_info(),
            mint: ctx.accounts.no_mint.to_account_info(),
            to: ctx.accounts.no_token_ata.to_account_info(),
            authority: market.to_account_info(),
        };
        let no_input_context = CpiContext::new_with_signer(
            input_program,
            no_input_account,
            market_seeds,
        );
        let input_amount = get_amount(no_pool_amount, yes_pool_amount, param.collateral_amount);
        require!(input_amount > 0 && input_amount >= param.min_out, ErrorCode::SlippageExceeded);
        transfer_checked(no_input_context, input_amount, decimals)?;
        msg!("user bet---------");
        msg!("user {:?} received {:?} No", ctx.accounts.signer.key(), input_amount);
    }

    Ok(())
}