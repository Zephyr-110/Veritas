use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Market is not open.")]
    MarketNotOpen,
    #[msg("Market is not resolved or voided.")]
    MarketNotResolved,
    #[msg("Market must be open, resolved, or voided.")]
    MarketNotTradable,
    #[msg("Market has expired.")]
    MarketExpired,
    #[msg("Market has not expired yet.")]
    MarketNotExpired,
    #[msg("Amount or expiry is invalid.")]
    InvalidAmount,
    #[msg("Insufficient token balance.")]
    InsufficientBalance,
    #[msg("Pool reserves are empty.")]
    EmptyPool,
    #[msg("Output is below the slippage limit.")]
    SlippageExceeded,
    #[msg("LP amount must be greater than zero.")]
    ZeroLp,
    #[msg("Mint does not belong to this market.")]
    InvalidMint,
    #[msg("Only the winning token can be redeemed.")]
    NotWinnerMint,
    #[msg("Price is out of range.")]
    InvalidPrice,
    #[msg("Liquidity is invalid.")]
    InvalidLiquidity,
    #[msg("Fixed-point math overflow.")]
    MathOverflow,
    #[msg("Duration is invalid.")]
    InvalidDuration,
    #[msg("Budget is invalid.")]
    InvalidBudget,
    #[msg("Price is not the first Pyth update after expiry.")]
    NotFirstAfterExpiry,
    #[msg("Pyth exponent does not match this market.")]
    ExponentMismatch,
    #[msg("Market is not in the required time window.")]
    MarketNotInWindow,
    #[msg("Redeemable tokens still exist.")]
    TokensOutstanding,
    #[msg("No residual collateral in the vault.")]
    NoResidual,
    #[msg("Signer is not the market creator.")]
    NoCreator,
    #[msg("Claim window has not ended yet.")]
    NoArriveFinishTS,
    #[msg("Market is still open.")]
    MarketIsOpen,
}
