use anchor_lang::Accounts;
use anchor_lang::context::Context;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use anchor_spl::token_2022::{transfer_checked, TransferChecked, burn, Burn, close_account, CloseAccount};
use crate::{Market};
use crate::error::ErrorCode;
use crate::constants::*;
use crate::state::*;

#[derive(Accounts)]
pub struct BurnAccount<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        constraint = market.creator.key() == signer.key() @ ErrorCode::NoCreator,
        constraint = (clock.unix_timestamp as u64) > market.finish_ts + CLAIM_WINDOW @ ErrorCode::NoArriveFinishTS,
        constraint = market.status == MarketStatus::Resolved
        || market.status == MarketStatus::WindowBurn
        || market.status == MarketStatus::StaleBurn @ ErrorCode::MarketIsOpen,
        seeds = [b"market", market.id.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

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
        mut,
        token::mint = collateral_mint,
        token::authority = signer,
    )]
    pub collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>, // user collateral ATA

    #[account(
        mut,
        seeds = [b"collateral_vault", market.key().as_ref()],
        bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>, // collateral vault

    #[account(address = market.collateral_mint)]
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>, // collateral mint

    pub system_program: Program<'info, System>,

    pub token_program: Interface<'info, TokenInterface>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn burn_account(ctx: Context<BurnAccount>) -> Result<()> {
    // ======================== 把抵押物得底子转给庄家 ========================
    let collateral_account = TransferChecked {
        from: ctx.accounts.collateral_vault.to_account_info(),
        mint: ctx.accounts.collateral_mint.to_account_info(),
        to: ctx.accounts.collateral_ata.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let collateral_program = ctx.accounts.token_program.key();
    let market_seeds: &[&[&[u8]]] = &[&[b"market", ctx.accounts.market.id.as_ref(), &[ctx.accounts.market.bump]]];
    let collateral_cpi_context = CpiContext::new_with_signer(
        collateral_program,
        collateral_account,
        market_seeds
    );
    let transfer_amount = ctx.accounts.collateral_vault.amount;
    let decimals = ctx.accounts.collateral_mint.decimals;
    transfer_checked(collateral_cpi_context, transfer_amount, decimals)?;

    // ======================== 销毁池中代币 ========================
    // Yes
    let yes_burn_account = Burn {
        mint: ctx.accounts.yes_mint.to_account_info(),
        from: ctx.accounts.yes_pool.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let yes_burn_program = ctx.accounts.token_program.key();
    let yes_burn_cpi_context = CpiContext::new_with_signer(
        yes_burn_program,
        yes_burn_account,
        market_seeds
    );
    burn(yes_burn_cpi_context, ctx.accounts.yes_pool.amount)?;

    // No
    let no_burn_account = Burn {
        mint: ctx.accounts.no_mint.to_account_info(),
        from: ctx.accounts.no_pool.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let no_burn_program = ctx.accounts.token_program.key();
    let no_burn_cpi_context = CpiContext::new_with_signer(
        no_burn_program,
        no_burn_account,
        market_seeds
    );
    burn(no_burn_cpi_context, ctx.accounts.no_pool.amount)?;

    // ======================== 销毁金库及双边代币池 ========================
    // Yes
    let close_yes = CloseAccount {
        account: ctx.accounts.yes_pool.to_account_info(),
        destination: ctx.accounts.signer.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let yes_close_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        close_yes,
        market_seeds,
    );
    close_account(yes_close_context)?;

    // No
    let close_no = CloseAccount {
        account: ctx.accounts.no_pool.to_account_info(),
        destination: ctx.accounts.signer.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let no_close_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        close_no,
        market_seeds,
    );
    close_account(no_close_context)?;
    // Collateral
    let close_collateral = CloseAccount {
        account: ctx.accounts.collateral_vault.to_account_info(),
        destination: ctx.accounts.signer.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let collateral_close_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        close_collateral,
        market_seeds,
    );
    close_account(collateral_close_context)?;

    // ======================== 销毁 Market ========================
    ctx.accounts.market.close(ctx.accounts.signer.to_account_info())?;

    Ok(())
}