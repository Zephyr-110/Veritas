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
    pub creator: Signer<'info>, // 庄主

    pub oracle: Signer<'info>, // 裁决者

    #[account(
        init,
        payer = creator,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", param.market_id.as_ref()],
        bump
    )]
    pub market: Box<Account<'info, Market>>, // 盘口

    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>, // 抵押物铸币厂账户，不需要限制抵押物，也不需要限制开盘者

    #[account(
        init,
        payer = creator,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"lp_mint", market.key().as_ref()],
        bump
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>, // 份额币铸币厂

    #[account(
        init,
        payer = creator,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump
    )]
    pub yes_mint: Box<InterfaceAccount<'info, Mint>>, // Yes 币

    #[account(
        init,
        payer = creator,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump
    )]
    pub no_mint: Box<InterfaceAccount<'info, Mint>>, // No 币

    #[account(
        init,
        payer = creator,
        associated_token::mint = lp_mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program
    )]
    pub lp_creator_ata: Box<InterfaceAccount<'info, TokenAccount>>, // 开盘者的份额币 ATA

    #[account(
        init,
        payer = creator,
        token::mint = collateral_mint,
        token::authority = market,
        seeds = [b"collateral_vault", market.key().as_ref()],
        bump
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>, // 抵押物池

    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program
    )]
    pub creator_collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>, // 开盘者抵押物 ATA，因为要注资，所以加上

    #[account(
        init,
        payer = creator,
        token::mint = yes_mint,
        token::authority = market,
        seeds = [b"yes_pool", market.key().as_ref()],
        bump
    )]
    pub yes_pool: Box<InterfaceAccount<'info, TokenAccount>>, // Yes 币池

    #[account(
        init,
        payer = creator,
        token::mint = no_mint,
        token::authority = market,
        seeds = [b"no_pool", market.key().as_ref()],
        bump
    )]
    pub no_pool: Box<InterfaceAccount<'info, TokenAccount>>, // No 币池

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

    // ===================== 先给字段赋值 =====================

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
    msg!("建盘---------");
    msg!("Market ID：{:?}", param.market_id);
    msg!("建盘 Collateral 为：{:?}", market.collateral_mint.key());

    // ===================== 给抵押物池转账 =====================

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
    msg!("建盘---------");
    msg!("庄家给该盘注资 {:?} ", param.collateral_amount);

    // ===================== 往池子里倒币 =====================

    // 1.Yes 币
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
    msg!("建盘---------");
    msg!("庄家入池 Yes 币 {:?} 个", param.collateral_amount);

    // 2.No 币
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
    msg!("建盘---------");
    msg!("庄家入池 No 币 {:?} 个", param.collateral_amount);

    // ===================== 铸份额币 =====================

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
    msg!("建盘---------");
    msg!("庄家得到 份额 币 {:?} 个", param.collateral_amount);

    Ok(())
}