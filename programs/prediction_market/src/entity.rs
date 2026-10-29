use anchor_lang::*;
use anchor_lang::prelude::Pubkey;
use crate::state::*;

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub oracle: Pubkey, // who is allowed to publish the result
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
}

impl Market {
    pub fn yes_or_no(&self) -> Option<Pubkey> {
        match self.winner {
            MarketOutcome::Yes => Some(self.yes_mint),
            MarketOutcome::No => Some(self.no_mint),
        }
    }
}
