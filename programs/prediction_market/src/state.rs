use anchor_lang::prelude::*;

#[derive(AnchorDeserialize, AnchorSerialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketStatus {
    Upcoming,
    Open,
    Resolved,
    Burn,
}

#[derive(AnchorDeserialize, AnchorSerialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketOutcome {
    Yes,
    No,
}