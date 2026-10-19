use anchor_lang::*;
use anchor_lang::prelude::Pubkey;
use crate::state::*;

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey, // 谁有权公布结果
    pub expiry: u64, // 过期时间，是否过期我们要在program手动校验，需要外边传
    pub open_at: u64, // 开盘时间，需要外边传
    pub id: [u8; 16],
    pub bump: u8,
    pub yes_mint: Pubkey, // 亲儿子地址
    pub no_mint: Pubkey, // 亲儿子地址
    pub status: MarketStatus, // 当前状态
    pub collateral_mint: Pubkey, // 用什么币结算
    pub winner: MarketOutcome, // 赢家是谁
    pub market_collateral_bump: u8, // 盘口抵押物扰动值
    pub prediction: [u8; 64],
}

impl Market {
    pub fn yes_or_no(&self) -> Option<Pubkey> {
        match self.winner {
            MarketOutcome::Yes => Some(self.yes_mint),
            MarketOutcome::No => Some(self.no_mint),
        }
    }
}