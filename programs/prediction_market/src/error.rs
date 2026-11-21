use anchor_lang::prelude::*;
use crate::math::Ocr2Error;

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
    #[msg("Reports are not two adjacent oracle rounds straddling expiry.")]
    NotFirstAfterExpiry,
    #[msg("Market is not in the required time window.")]
    MarketNotInWindow,
    #[msg("Signer is not the market creator.")]
    NoCreator,
    #[msg("Claim window has not ended yet.")]
    NoArriveFinishTS,
    #[msg("Market is still open.")]
    MarketIsOpen,
    #[msg("Oracle report or state data is malformed.")]
    InvalidOracleInput,
    #[msg("Oracle report was not signed under the feed's current config.")]
    OracleDigestMismatch,
    #[msg("Oracle report has the wrong number of signatures.")]
    WrongNumberOfSignatures,
    #[msg("Oracle report signature is invalid.")]
    InvalidOracleSignature,
    #[msg("Oracle report is signed by a node outside the feed's oracle set.")]
    UnauthorizedOracleSigner,
    #[msg("Oracle report is signed twice by the same node.")]
    DuplicateOracleSigner,
    #[msg("Oracle state account is not an allowed feed or does not match this market.")]
    WrongOracleState,
    #[msg("Feed account does not match this market's price feed.")]
    BadFeedAccount,
    #[msg("Price feed is not in the allowed feed list.")]
    FeedNotAllowed,
    #[msg("Snapshot already holds sixteen entries.")]
    SnapshotFull,
    #[msg("Snapshot can only be taken within ten seconds of expiry.")]
    SnapshotOutOfWindow,
    #[msg("Snapshot landing counter must move forward.")]
    SnapshotStale,
    #[msg("Reports are not adjacent rounds and are not certified by the market snapshot.")]
    UnableCompleteCheckout,
    #[msg("Feed decimals must be 8.")]
    UnsupportedDecimals,
}

impl From<Ocr2Error> for ErrorCode {
    fn from(e: Ocr2Error) -> Self {
        match e {
            Ocr2Error::InvalidInput => ErrorCode::InvalidOracleInput,
            Ocr2Error::DigestMismatch => ErrorCode::OracleDigestMismatch,
            Ocr2Error::WrongNumberOfSignatures => ErrorCode::WrongNumberOfSignatures,
            Ocr2Error::InvalidSignature => ErrorCode::InvalidOracleSignature,
            Ocr2Error::UnauthorizedSigner => ErrorCode::UnauthorizedOracleSigner,
            Ocr2Error::DuplicateSigner => ErrorCode::DuplicateOracleSigner,
        }
    }
}
