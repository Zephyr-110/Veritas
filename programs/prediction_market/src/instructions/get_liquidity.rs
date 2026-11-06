use anchor_lang::context::{Context, CpiContext};
use anchor_lang::prelude::*;
use anchor_lang::{require, Accounts};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::{burn, transfer_checked, Burn, TransferChecked};
use anchor_spl::token_interface::*;
use fixed::types::I80F48;
use crate::{LpPosition, Market};
use crate::error::ErrorCode;
use crate::math::{apply_accrual, compute_accrual, compute_lp_pending};
use crate::state::*;


#[derive(Accounts)]
pub struct GetLiquidity<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        constraint = market.status == MarketStatus::Open || market.status == MarketStatus::Resolved || market.status == MarketStatus::Burn @ ErrorCode::MarketNotTradable,
        constraint = market.oracle.key() != signer.key() @ ErrorCode::AuthorityCannotTrade,
        seeds = [b"market", market.id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"lp_position", market.key().as_ref(), signer.key().as_ref()],
        bump = lp_position.bump,
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

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

    pub clock: Sysvar<'info, Clock>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub fn get_liquidity(ctx: Context<GetLiquidity>, lp_amount: u64) -> Result<()> {
    require!(lp_amount > 0 , ErrorCode::ZeroLp);
    require!(lp_amount <= ctx.accounts.businessman_lp_ata.amount, ErrorCode::InsufficientBalance);

    let market = &mut ctx.accounts.market;
    let now = ctx.accounts.clock.unix_timestamp;
    let acc = compute_accrual(market, now)?;
    apply_accrual(market, &acc);

    let position = &mut ctx.accounts.lp_position;
    let shares_in = I80F48::from_num(lp_amount);
    require!(shares_in <= position.shares_fixed(), ErrorCode::InsufficientBalance);

    let (pending_yes, pending_no) = compute_lp_pending(
        position.shares_fixed(),
        position.checkpoint_yes_fixed(),
        position.checkpoint_no_fixed(),
        market.cum_yes_per_share_fixed(),
        market.cum_no_per_share_fixed(),
    );

    let x = market.reserve_yes_fixed();
    let y = market.reserve_no_fixed();
    let total = market.total_lp_shares_fixed();
    require!(total > I80F48::ZERO, ErrorCode::InvalidLiquidity);

    let share_yes = x * shares_in / total;
    let share_no = y * shares_in / total;
    let yes_amount = (pending_yes + share_yes).to_num::<u64>();
    let no_amount = (pending_no + share_no).to_num::<u64>();
    require!(yes_amount > 0 || no_amount > 0, ErrorCode::InvalidAmount);

    let scale = (total - shares_in) / total;
    let new_l_zero = market.l_zero_fixed() * scale;
    let new_total = total - shares_in;
    let new_shares = position.shares_fixed() - shares_in;
    let cum_yes = market.cum_yes_per_share_fixed();
    let cum_no = market.cum_no_per_share_fixed();

    market.set_l_zero_fixed(new_l_zero);
    market.set_reserve_yes_fixed(x * scale);
    market.set_reserve_no_fixed(y * scale);
    market.set_total_lp_shares_fixed(new_total);

    position.set_shares_fixed(new_shares);
    position.set_checkpoint_yes_fixed(cum_yes);
    position.set_checkpoint_no_fixed(cum_no);

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

    let seeds: &[&[&[u8]]] = &[&[b"market", market.id.as_ref(), &[market.bump]]];
    // Yes
    let yes_cpi_account = TransferChecked {
        from: ctx.accounts.yes_pool.to_account_info(),
        mint: ctx.accounts.yes_mint.to_account_info(),
        to: ctx.accounts.businessman_yes_ata.to_account_info(),
        authority: market.to_account_info(),
    };
    let yes_cpi_program = ctx.accounts.token_program.key();
    let yes_cpi_context = CpiContext::new_with_signer(yes_cpi_program, yes_cpi_account, seeds);
    transfer_checked(yes_cpi_context, yes_amount, ctx.accounts.yes_mint.decimals)?;

    // No
    require!(no_amount > 0 || yes_amount > 0, ErrorCode::InvalidAmount);
    let no_cpi_account = TransferChecked {
        from: ctx.accounts.no_pool.to_account_info(),
        mint: ctx.accounts.no_mint.to_account_info(),
        to: ctx.accounts.businessman_no_ata.to_account_info(),
        authority: market.to_account_info(),
    };
    let no_cpi_program = ctx.accounts.token_program.key();
    let no_cpi_context = CpiContext::new_with_signer(no_cpi_program, no_cpi_account, seeds);
    transfer_checked(no_cpi_context, no_amount, ctx.accounts.no_mint.decimals)?;
    msg!("LP {:?} withdrew:\nYes: {:?}\n No: {:?}", ctx.accounts.signer.key(), yes_amount, no_amount);

    Ok(())
}