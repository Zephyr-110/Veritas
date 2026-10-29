use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the market oracle can resolve this market.")] // only this market's oracle can resolve
    Unauthorized,
    #[msg("Market is not open.")] // market is not Open; voiding with the wrong time or signer also hits this
    MarketNotOpen,
    #[msg("Market is not resolved or voided.")] // market is not yet Resolved/Burn, cannot redeem collateral
    MarketNotResolved,
    #[msg("Market must be open, resolved, or voided.")] // merge or withdraw requires Open/Resolved/Burn
    MarketNotTradable,
    #[msg("Market has expired.")] // already expired; no more betting, swaps, or adding liquidity
    MarketExpired,
    #[msg("Market is outside the resolve window.")] // not yet expired, or already past the resolve window
    MarketNotExpired,
    #[msg("Amount or expiry is invalid.")] // amount invalid, or expiry invalid (cannot already be past, cannot be u64::MAX)
    InvalidAmount,
    #[msg("Insufficient token account balance.")] // corresponding ATA balance is insufficient
    InsufficientBalance,
    #[msg("Pool reserves are empty.")] // Yes/No pools are empty
    EmptyPool,
    #[msg("Output amount is below min_out.")] // output is below the min_out you set
    SlippageExceeded,
    #[msg("LP amount must be greater than zero.")] // LP amount cannot be 0
    ZeroLp,
    #[msg("Mint does not belong to this market.")] // this mint is not this market's Yes or No
    InvalidMint,
    #[msg("Mint is not the winning outcome.")] // after resolve, only the winning token can be redeemed
    NotWinnerMint,
    #[msg("The market oracle cannot trade.")] // oracle cannot bet or swap
    AuthorityCannotTrade,
}
