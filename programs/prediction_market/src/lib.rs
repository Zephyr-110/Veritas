pub mod entity;

pub mod error;

pub mod constants;
pub mod state;
pub mod instructions;
pub mod math;

pub use math::amm::*;
pub use constants::*;
pub use state::MarketOutcome;
pub use entity::*;
use instructions::*;

use anchor_lang::prelude::*;

declare_id!("CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER");

#[program]
pub mod prediction_market {
    use super::*;
    pub fn create_market(ctx: Context<CreateMarket>, param: CreateMarketParams, ) -> Result<()> {
        instructions::create_market(ctx, param)
    }

    pub fn add_liquidity(ctx: Context<AddLiquidity>, collateral_amount: u64) -> Result<()> {
        instructions::add_liquidity(ctx, collateral_amount)
    }


    /// 下注
    pub fn user_bet_on(ctx: Context<UserBetOn>, param: UserBetOnParams, ) -> Result<()> {
        instructions::user_bet_on(ctx, param)
    }

    pub fn merge_token(ctx: Context<MergeToken>, merge_amount: u64) -> Result<()>{
        instructions::merge_token(ctx, merge_amount)
    }

    pub fn get_liquidity(ctx: Context<GetLiquidity>, lp_amount: u64) -> Result<()> {
        instructions::get_liquidity(ctx, lp_amount)
    }

    pub fn swap(ctx: Context<Swap>, param: SwapParams) -> Result<()> {
        instructions::swap(ctx, param)
    }

    pub fn resolve_market(ctx: Context<ResolveMarket>, market_winner: MarketOutcome) -> Result<()> {
        instructions::resolve_market(ctx, market_winner)
    }

    pub fn get_collateral(ctx: Context<GetCollateral>, amount: u64, ) -> Result<()> {
        instructions::get_collateral(ctx, amount)
    }

    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        instructions::void_market(ctx)
    }
}