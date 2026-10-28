use anchor_lang::{require, Accounts};
use anchor_lang::context::{Context, CpiContext};
use anchor_lang::prelude::*;
use anchor_spl::token_2022::{burn, transfer_checked, Burn, TransferChecked};
use anchor_spl::token_interface::*;
use crate::Market;
use crate::error::ErrorCode;
use crate::state::*;

#[derive(Accounts)]
pub struct GetCollateral<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = market.status == MarketStatus::Resolved || market.status == MarketStatus::Burn @ ErrorCode::MarketNotResolved,
        constraint = (market.yes_mint == token_mint.key()) || (market.no_mint == token_mint.key()) @ ErrorCode::InvalidMint,
        seeds = [b"market", market.id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        constraint = Some(token_mint.key()) == market.yes_or_no() && market.status == MarketStatus::Resolved
        || market.status == MarketStatus::Burn @ ErrorCode::NotWinnerMint,
    )]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = signer,
    )]
    pub token_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = market.collateral_mint)]
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>, // 抵押物铸币厂

    #[account(
        mut,
        seeds = [b"collateral_vault", market.key().as_ref()],
        token::mint = collateral_mint,
        bump = market.market_collateral_bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = signer,
    )]
    pub user_collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn get_collateral(ctx: Context<GetCollateral>, amount: u64, ) -> Result<()> {
    require!(amount > 0 && ctx.accounts.market.status == MarketStatus::Resolved || amount >= 2 && ctx.accounts.market.status == MarketStatus::Burn, ErrorCode::InvalidAmount);
    require!(ctx.accounts.token_ata.amount >= amount, ErrorCode::InsufficientBalance);

    // 销毁代币
    let token_cpi_account = Burn {
        mint: ctx.accounts.token_mint.to_account_info(),
        from: ctx.accounts.token_ata.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    let token_cpi_program = ctx.accounts.token_program.key();
    let token_cpi_context = CpiContext::new(
        token_cpi_program,
        token_cpi_account,
    );
    burn(token_cpi_context, amount)?;
    // 为赢家发放对应额度的抵押物

    let seeds: &[&[&[u8]]] = &[&[b"market", ctx.accounts.market.id.as_ref(), &[ctx.accounts.market.bump]]];
    let collateral_cpi_account = TransferChecked {
        from: ctx.accounts.collateral_vault.to_account_info(),
        mint: ctx.accounts.collateral_mint.to_account_info(),
        to: ctx.accounts.user_collateral_ata.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let collateral_cpi_program = ctx.accounts.token_program.key();
    let collateral_cpi_context = CpiContext::new_with_signer(
        collateral_cpi_program,
        collateral_cpi_account,
        seeds,
    );

    if ctx.accounts.market.status == MarketStatus::Burn {
        let get_amount = amount.checked_div(2).unwrap();
        transfer_checked(collateral_cpi_context, get_amount, ctx.accounts.collateral_mint.decimals)?;
        msg!("赢家 {:?} 兑换了 {:?} 枚抵押物", ctx.accounts.signer.key(), get_amount);
    } else {
        transfer_checked(collateral_cpi_context, amount, ctx.accounts.collateral_mint.decimals)?;
        msg!("赢家 {:?} 兑换了 {:?} 枚抵押物", ctx.accounts.signer.key(), amount);
    }

    Ok(())
}