use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the counter authority can update this counter")]
    Unauthorized,
    #[msg("Counter has reached the maximum value")]
    CounterOverflow,
    #[msg("Market has already been opened.")]
    MarketAlreadyOpened, // 已经开盘
    #[msg("Market open time has not arrived yet.")]
    MarketNotOpenYet, // 没到时间呢
    #[msg("Market has already expired.")]
    MarketExpired, // 过期了
    #[msg("Market status throw exception.")]
    MarketStatusException,
    #[msg("Cannot transfer 0 tokens.")]
    InvalidAmount,
    #[msg("Token supply cannot be 0.")]
    TokenSupplyZero,
    #[msg("Tokens must not be misaligned.")]
    TokenDislocation,
    #[msg("Token mismatch.")]
    WinnerException,
    #[msg("The expiration time must not be earlier than the market opening time.")]
    ExpirationException,
}
