pub mod params;
pub use params::*;

pub mod entity;

pub mod error;

mod constants;
pub mod state;
pub use state::MarketOutcome;
pub use entity::*;

use anchor_lang::prelude::*;

declare_id!("GeLQ6ETg5VPU86bCBKAnA7pRygoJaf5uXd5g6upvzfmD");

#[program]
pub mod prediction_market {
    use anchor_spl::token_interface::*;
    use anchor_spl::token_interface::TransferChecked;
    use crate::state::{MarketStatus, MarketOutcome};
    use crate::error::ErrorCode;
    use super::*;

    /// 创建盘口并初始化
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: [u8; 16],
        prediction: [u8; 64],
        open_at: u64,
        expiry: u64,
    ) -> Result<()> {
        require!(expiry > open_at, ErrorCode::ExpirationException);
        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.signer.key();
        market.id = market_id;
        market.prediction = prediction;
        market.expiry = expiry;
        market.open_at = open_at;
        market.bump = ctx.bumps.market;
        market.status = MarketStatus::Upcoming;
        market.collateral_mint = ctx.accounts.collateral_mint.key();
        market.yes_mint = ctx.accounts.yes_mint.key();
        market.no_mint = ctx.accounts.no_mint.key();
        market.market_collateral_bump = ctx.bumps.collateral_vault;
        // 把 id 转化为字符串，方便打印
        let id_str = market.id.iter().map(|b| format!("{:02x}", b)).collect::<String>();
        msg!("成功初始化盘口，盘口id为：{}", id_str);
        msg!("成功初始化账户{:?}！", ctx.accounts.yes_mint.key());
        msg!("成功初始化账户{:?}！", ctx.accounts.no_mint.key());
        // 把预测内容转化为字符串
        let valid_len = prediction.iter().position(|&b| b == 0).unwrap_or(prediction.len());
        let prediction_str = String::from_utf8_lossy(&prediction[..valid_len]);
        msg!("预测内容为：如果{}，则持有 Yes 币的人得到奖励，如若不然，持有 No 币的人得到奖励。", prediction_str);
        msg!("代币精度为：{}", ctx.accounts.yes_mint.decimals);
        Ok(())
    }

    /// 开盘
    pub fn open_market(ctx: Context<OpenMarket>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        market.status = MarketStatus::Open;
        msg!("当前盘口：{:?}，状态修改为：{:?}", market.id, market.status);
        Ok(())
    }

    /// 下注
    pub fn user_bet_on(
        ctx: Context<UserBetOn>,
       outcome_amount: u64,
    ) -> Result<()> {
        // ========================扣钱========================
        let collateral_deduct = outcome_amount;
        require!(collateral_deduct > 0, ErrorCode::InvalidAmount);
        let decimals = ctx.accounts.collateral_mint.decimals;
        // 组装转账清单
        let cpi_account = TransferChecked {
            mint: ctx.accounts.collateral_mint.to_account_info(),
            from: ctx.accounts.user_collateral.to_account_info(),
            to: ctx.accounts.collateral_vault.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };
        // 目标程序地址
        let cpi_program = ctx.accounts.token_program.key();
        let cpi_context = CpiContext::new(cpi_program, cpi_account);
        transfer_checked(cpi_context, collateral_deduct, decimals)?;
        msg!("将代币{:?} 从用户 {:?} ATA 转到公用抵押物池：{:?}",
            ctx.accounts.collateral_mint.key(),
            ctx.accounts.signer.key(),
            ctx.accounts.collateral_vault.key(),
        );

        // ========================发币========================
        let market = & ctx.accounts.market;
        let market_bump = market.bump;
        let market_seeds: &[&[&[u8]]] = &[&[b"market", market.id.as_ref(), &[market_bump]]];
        let outcome_cpi_accounts = MintTo {
            mint: ctx.accounts.outcome_mint.to_account_info(),
            to: ctx.accounts.outcome_token_ata.to_account_info(),
            authority: market.to_account_info(),
        };
        let yes_cpi_context = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            outcome_cpi_accounts,
            market_seeds,
        );
        mint_to(yes_cpi_context, outcome_amount)?;
        msg!("盘口 {:?} 为用户 {:?} 发了 {:?} 个 Yes 币",
            market.key(),
            ctx.accounts.signer.key(),
            outcome_amount,
        );
        Ok(())
    }

    pub fn resolve_market(ctx: Context<ResolveMarket>, market_winner: MarketOutcome) -> Result<()> {
        let market = &mut ctx.accounts.market;
        market.winner = market_winner;
        market.status = MarketStatus::Resolved;
        msg!("盘口 {:?} 裁决完毕，赢家为 {:?} ", market.id, market.winner);
        Ok(())
    }

    pub fn get_collateral(
        ctx: Context<GetCollateral>,
        amount: u64,
    ) -> Result<()> {
        let token_supply = ctx.accounts.token_mint.supply;
        require!(token_supply != 0, ErrorCode::TokenSupplyZero);
        // 算应该退的钱
        let back_amount = amount.checked_mul(ctx.accounts.collateral_vault.amount).ok_or(ErrorCode::InvalidAmount)? / ctx.accounts.token_mint.supply;
        // 判断用户是不是他妈的瞎几把转账了
        require!(amount > 0, ErrorCode::InvalidAmount);
        // 算出用户能不能拿走这么多抵押物
        let balance = ctx.accounts.token_ata.amount;
        require!(balance >= amount, ErrorCode::InvalidAmount);
        // 销毁代币
        let token_cpi_account = Burn {
            mint: ctx.accounts.token_mint.to_account_info(),
            from: ctx.accounts.token_ata.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };
        let token_cpi_program = ctx.accounts.token_program.key();
        let token_cpi_context = CpiContext::new(token_cpi_program, token_cpi_account);
        burn(token_cpi_context, amount)?;
        // 给用户转抵押物
        let market = & ctx.accounts.market;
        // 1.拼抵押物池子的 PDA 签名种子
        let bump = market.bump;
        let seeds: &[&[&[u8]]] = &[&[b"market", market.id.as_ref(), &[bump]]];
        let collateral_cpi_account = TransferChecked {
            mint: ctx.accounts.collateral_mint.to_account_info(),
            from: ctx.accounts.collateral_vault.to_account_info(),
            to: ctx.accounts.user_collateral_ata.to_account_info(),
            authority: market.to_account_info(),
        };
        let collateral_cpi_program = ctx.accounts.token_program.key();
        let collateral_cpi_context = CpiContext::new_with_signer(collateral_cpi_program, collateral_cpi_account, seeds);
        let decimal = ctx.accounts.collateral_mint.decimals;
        transfer_checked(collateral_cpi_context, back_amount, decimal)?;
        Ok(())
    }
}


