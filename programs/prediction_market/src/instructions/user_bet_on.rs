use anchor_lang::context::{Context, CpiContext};
use anchor_lang::prelude::*;
use anchor_lang::{require, Accounts};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::{mint_to, transfer_checked, MintTo, TransferChecked};
use anchor_spl::token_interface::*;
use fixed::types::I80F48;
use crate::{Market, MarketOutcome, SwapSide};
use crate::state::*;
use crate::error::ErrorCode;
use crate::math::{apply_accrual, compute_accrual, compute_swap_output, l_effective};

#[derive(Accounts)]
pub struct UserBetOn<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
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

    let now = ctx.accounts.clock.unix_timestamp;
    let accrual = compute_accrual(market, now)?;
    apply_accrual(market, &accrual);

    require!(
    market.reserve_yes_fixed() > I80F48::ZERO
        && market.reserve_no_fixed() > I80F48::ZERO,
    ErrorCode::EmptyPool
    );

    let l_eff = l_effective(market.l_zero_fixed(), market.end_ts - now)?;

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

    let swap_in_amount = param.collateral_amount;
    // 入腿手续费
    let in_service_fee = I80F48::from_num(swap_in_amount)
        .checked_mul(I80F48::from_num(market.fee_bps)).ok_or(ErrorCode::MathOverflow)?
        .checked_div(I80F48::from_num(10_000)).ok_or(ErrorCode::MathOverflow)?;
    // 用户的真实属于自己的入池
    let net_in = I80F48::from_num(swap_in_amount)
        .checked_sub(in_service_fee).ok_or(ErrorCode::MathOverflow)?;

    require!(market.total_lp_shares_fixed() > I80F48::ZERO, ErrorCode::InvalidLiquidity);

    let token_type = if param.token_type == MarketOutcome::Yes { true } else { false };
    if token_type {
        // No to Yes
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
        // ① 组装上下文
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
        // ② 计算 result
        let result = compute_swap_output(
            market.reserve_yes_fixed(),
            market.reserve_no_fixed(),
            l_eff,
            net_in,
            SwapSide::No,
            SwapSide::Yes,
        )?;
        // ③ 计算手续费
        let out_service_fee = result.output
            .checked_mul(I80F48::from_num(market.fee_bps)).ok_or(ErrorCode::MathOverflow)?
            .checked_div(I80F48::from_num(10_000)).ok_or(ErrorCode::MathOverflow)?;
        // ④ 计算要换的 Token 的数量
        let return_amount = result.output
            .checked_sub(out_service_fee).ok_or(ErrorCode::MathOverflow)?
            .to_num::<u64>();

        // ⑤ 鉴权加转账
        require!(return_amount > 0 && return_amount >= param.min_out, ErrorCode::SlippageExceeded);
        transfer_checked(yes_input_context, return_amount, decimals)?;

        // ⑥ 计算每份份额因服务费增加了多少
        let total_shares = market.total_lp_shares_fixed();
        let fee_in_per_share = in_service_fee
            .checked_div(total_shares).ok_or(ErrorCode::MathOverflow)?;
        let fee_out_per_share = out_service_fee
            .checked_div(total_shares).ok_or(ErrorCode::MathOverflow)?;

        // ⑦ 计算出要增加的累计
        let new_cum_yes_per_share = market.cum_yes_per_share_fixed().checked_add(fee_out_per_share).ok_or(ErrorCode::MathOverflow)?;
        let new_cum_no_per_share = market.cum_no_per_share_fixed().checked_add(fee_in_per_share).ok_or(ErrorCode::MathOverflow)?;

        // ⑧ 落库
        market.set_cum_yes_per_share_fixed(new_cum_yes_per_share);
        market.set_cum_no_per_share_fixed(new_cum_no_per_share);
        market.set_reserve_yes_fixed(result.x_new);
        market.set_reserve_no_fixed(result.y_new);

        msg!("user bet---------");
        msg!("user {:?} received {:?} Yes", ctx.accounts.signer.key(), return_amount);
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
        // ① 先拼装上下文
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
        // ② 计算 result
        let result = compute_swap_output(
            market.reserve_yes_fixed(),
            market.reserve_no_fixed(),
            l_eff,
            net_in,
            SwapSide::Yes,
            SwapSide::No,
        )?;
        // ③ 计算手续费
        let out_service_fee = result.output
            .checked_mul(I80F48::from_num(market.fee_bps)).ok_or(ErrorCode::MathOverflow)?
            .checked_div(I80F48::from_num(10_000)).ok_or(ErrorCode::MathOverflow)?;
        // ④ 计算要换的 Token 的数量
        let return_amount = result.output
            .checked_sub(out_service_fee).ok_or(ErrorCode::MathOverflow)?
            .to_num::<u64>();

        // ⑤ 鉴权加转账
        require!(return_amount > 0 && return_amount >= param.min_out, ErrorCode::SlippageExceeded);
        transfer_checked(no_input_context, return_amount, decimals)?;

        // ⑥ 计算每份份额因服务费增加了多少
        let total_shares = market.total_lp_shares_fixed();
        let fee_in_per_share = in_service_fee
            .checked_div(total_shares).ok_or(ErrorCode::MathOverflow)?;
        let fee_out_per_share = out_service_fee
            .checked_div(total_shares).ok_or(ErrorCode::MathOverflow)?;

        // ⑦ 计算出要增加的累计
        let new_cum_yes_per_share = market.cum_yes_per_share_fixed().checked_add(fee_in_per_share).ok_or(ErrorCode::MathOverflow)?;
        let new_cum_no_per_share = market.cum_no_per_share_fixed().checked_add(fee_out_per_share).ok_or(ErrorCode::MathOverflow)?;

        // ⑧ 落库
        market.set_cum_yes_per_share_fixed(new_cum_yes_per_share);
        market.set_cum_no_per_share_fixed(new_cum_no_per_share);
        market.set_reserve_yes_fixed(result.x_new);
        market.set_reserve_no_fixed(result.y_new);

        msg!("user bet---------");
        msg!("user {:?} received {:?} No", ctx.accounts.signer.key(), return_amount);
    }

    Ok(())
}