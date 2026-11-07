use anchor_lang::Accounts;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::{LpPosition, Market};
use crate::error::ErrorCode;
use crate::state::MarketStatus;

use anchor_spl::token_interface::*;
use fixed::types::I80F48;
use crate::math::{apply_accrual, compute_accrual, l_effective, pool_value, price_from_reserves};

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        constraint = market.status == MarketStatus::Open @ ErrorCode::MarketNotOpen,
        constraint = market.expiry > (clock.unix_timestamp as u64) @ ErrorCode::MarketExpired,
        constraint = market.oracle.key() != signer.key() @ ErrorCode::AuthorityCannotTrade,
        seeds = [b"market", market.id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + LpPosition::INIT_SPACE,
        seeds = [b"lp_position", market.key().as_ref(), signer.key().as_ref()],
        bump
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

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

    let now = ctx.accounts.clock.unix_timestamp;
    let accrual = compute_accrual(market, now)?;
    apply_accrual(market, &accrual);
    let l_eff = l_effective(market.l_zero_fixed(), market.end_ts - now)?;

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
    let reserve_yes = market.reserve_yes_fixed(); // Yes Token 当前在工作数量
    let reserve_no = market.reserve_no_fixed(); // No Token 当前在工作数量
    let yes_price = price_from_reserves(reserve_yes, reserve_no, l_eff)?; // Yes Token 价格
    let pool_value = pool_value(yes_price, l_eff)?; // l eff 的池子价值
    let add_collateral = I80F48::from_num(collateral_amount); // 增加的抵押物数量
    let total_lp_shares = market.total_lp_shares_fixed(); // lp 总量
    require!(pool_value > I80F48::ZERO && total_lp_shares > I80F48::ZERO, ErrorCode::InvalidLiquidity);

    // 1. Calculate the transfer amount first.

    let yes_input_amount = if market.reserve_yes > market.reserve_no {
        collateral_amount} else {
        let yes_temp = reserve_yes.checked_mul(add_collateral).ok_or(ErrorCode::MathOverflow)?;
        yes_temp.checked_div(reserve_no).ok_or(ErrorCode::MathOverflow)?.to_num::<u64>()
    }; // yes 应该入池数量
    let no_input_amount = if market.reserve_yes < market.reserve_no {
        collateral_amount} else {
        let no_temp = reserve_no.checked_mul(add_collateral).ok_or(ErrorCode::MathOverflow)?;
        no_temp.checked_div(reserve_yes).ok_or(ErrorCode::MathOverflow)?.to_num::<u64>()
    }; // No 应该入池数量
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
    let lp_temp = (yes_input_amount as u128)
        .checked_mul(ctx.accounts.lp_mint.supply as u128).ok_or(ErrorCode::MathOverflow)?;
    let lp_amount = lp_temp.checked_div(ctx.accounts.yes_pool.amount as u128).ok_or(ErrorCode::MathOverflow)? as u64; // Lp 本轮应铸数量
    let add_shares = I80F48::from_num(lp_amount); // 增加的 lp

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
    require!(lp_amount > 0, ErrorCode::ZeroLp);
    mint_to(lp_cpi_context, lp_amount)?;
    msg!("LP deposit---------");
    msg!("LP received {} LP tokens", lp_amount);

    let scale = (pool_value + add_collateral) / pool_value; // 池子扩充比例
    let new_l_zero = market.l_zero_fixed() * scale; // 新的l0
    let new_total_shares = total_lp_shares + add_shares; // 新的总 Lp数量
    let cum_yes = market.cum_yes_per_share_fixed();
    let cum_no = market.cum_no_per_share_fixed();

    market.set_l_zero_fixed(new_l_zero);
    market.set_reserve_yes_fixed(reserve_yes * scale);
    market.set_reserve_no_fixed(reserve_no * scale);
    market.set_total_lp_shares_fixed(new_total_shares);

    let position = &mut ctx.accounts.lp_position;
    if position.owner == Pubkey::default() {
        position.owner = ctx.accounts.signer.key();
        position.bump = ctx.bumps.lp_position;
    }
    let new_shares = position.shares_fixed() + add_shares;
    position.set_shares_fixed(new_shares);
    position.set_checkpoint_yes_fixed(cum_yes);
    position.set_checkpoint_no_fixed(cum_no);

    Ok(())
}