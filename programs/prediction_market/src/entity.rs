use anchor_lang::*;
use anchor_lang::prelude::Pubkey;
use crate::state::*;
use fixed::types::I80F48;

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub expiry: u64, // expiry; the program must check it, caller has to pass it in
    pub creator: Pubkey, // the house
    pub id: [u8; 16],
    pub bump: u8,
    pub yes_mint: Pubkey, // the market's own mint
    pub no_mint: Pubkey, // the market's own mint
    pub status: MarketStatus, // current status
    pub collateral_mint: Pubkey, // which token is used for settlement
    pub winner: MarketOutcome, // who won
    pub market_collateral_bump: u8, // market collateral bump
    pub prediction: [u8; 64],

    pub l_zero: i128, // 初始流动性参数
    pub last_accrual_ts: i64, // 上次 accrual 时间戳
    pub cum_yes_per_share: i128, // Yes 累计器
    pub cum_no_per_share: i128, // No 累计器
    pub fee_bps:u16,

    pub reserve_yes: i128,
    pub reserve_no: i128,
    pub total_lp_shares: i128,
    pub end_ts: i64,

    pub feed_id: [u8; 32], // Pyth 数据源编号
    pub threshold: i64, // 阈值
    pub exponent: i32, // 这个数据源的小数位指数
    pub settle_above: bool, // true 就是大于阈值，判 Yes 赢， 反之 No赢

    pub settled_price: i64, // 结算用掉的读数
    pub settled_publish_time: i64, // 读数的发布时间
}

impl Market {
    pub fn yes_or_no(&self) -> Option<Pubkey> {
        match self.winner {
            MarketOutcome::Yes => Some(self.yes_mint),
            MarketOutcome::No => Some(self.no_mint),
        }
    }

    pub fn l_zero_fixed(&self) -> I80F48 {
        I80F48::from_bits(self.l_zero)
    }

    pub fn set_l_zero_fixed(&mut self, v: I80F48) {
        self.l_zero = v.to_bits();
    }

    pub fn cum_yes_per_share_fixed(&self) -> I80F48 {
        I80F48::from_bits(self.cum_yes_per_share)
    }

    pub fn set_cum_yes_per_share_fixed(&mut self, v: I80F48) {
        self.cum_yes_per_share = v.to_bits();
    }

    pub fn cum_no_per_share_fixed(&self) -> I80F48 {
        I80F48::from_bits(self.cum_no_per_share)
    }

    pub fn set_cum_no_per_share_fixed(&mut self, v: I80F48) {
        self.cum_no_per_share = v.to_bits();
    }

    pub fn total_lp_shares_fixed(&self) -> I80F48 {
        I80F48::from_bits(self.total_lp_shares)
    }

    pub fn set_total_lp_shares_fixed(&mut self, v: I80F48) {
        self.total_lp_shares = v.to_bits();
    }

    pub fn reserve_yes_fixed(&self) -> I80F48 {
        I80F48::from_bits(self.reserve_yes)
    }

    pub fn set_reserve_yes_fixed(&mut self, v: I80F48) {
        self.reserve_yes = v.to_bits();
    }

    pub fn reserve_no_fixed(&self) -> I80F48 {
        I80F48::from_bits(self.reserve_no)
    }

    pub fn set_reserve_no_fixed(&mut self, v: I80F48) {
        self.reserve_no = v.to_bits();
    }

    pub fn resolved(&self) -> bool {
        matches!(self.status, MarketStatus::Resolved | MarketStatus::Burn)
    }
}

#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    pub owner: Pubkey,
    pub shares: i128,
    pub checkpoint_yes: i128,
    pub checkpoint_no: i128,
    pub bump: u8,
}

impl LpPosition {
    pub fn shares_fixed(&self) -> I80F48 {
        I80F48::from_bits(self.shares)
    }

    pub fn set_shares_fixed(&mut self, v: I80F48) {
        self.shares = v.to_bits();
    }

    pub fn checkpoint_yes_fixed(&self) -> I80F48 {
        I80F48::from_bits(self.checkpoint_yes)
    }

    pub fn set_checkpoint_yes_fixed(&mut self, v:I80F48) {
        self.checkpoint_yes = v.to_bits();
    }

    pub fn checkpoint_no_fixed(&self) -> I80F48 {
        I80F48::from_bits(self.checkpoint_no)
    }

    pub fn set_checkpoint_no_fixed(&mut self, v:I80F48) {
        self.checkpoint_no = v.to_bits();
    }
}

impl LpPosition {
    pub const LEN: usize = 32 + 16 + 16 + 16 + 1;
}
