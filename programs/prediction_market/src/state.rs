use anchor_lang::prelude::*;

#[derive(AnchorDeserialize, AnchorSerialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketStatus {
    Upcoming,
    Open,
    Resolved,
    WindowBurn, // 日期迟到
    StaleBurn, // 裁决迟到
}

#[derive(AnchorDeserialize, AnchorSerialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketOutcome {
    Yes,
    No,
}