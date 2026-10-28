use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the market oracle can resolve this market.")] // 只有本盘预言机才能裁决
    Unauthorized,
    #[msg("Market is not open.")] // 市场不是 Open；作废时时间或签名不对也走这个错
    MarketNotOpen,
    #[msg("Market is not resolved or voided.")] // 市场还不是 Resolved/Burn，不能兑付抵押物
    MarketNotResolved,
    #[msg("Market must be open, resolved, or voided.")] // 合并或撤资要求状态为 Open/Resolved/Burn
    MarketNotTradable,
    #[msg("Market has expired.")] // 已经到期，不能再下注、换币或加流动性
    MarketExpired,
    #[msg("Market is outside the resolve window.")] // 还没到期，或已经超过裁决窗口
    MarketNotExpired,
    #[msg("Amount or expiry is invalid.")] // 数量不合法，或到期时间不合法（不能已过期，也不能是 u64::MAX）
    InvalidAmount,
    #[msg("Insufficient token account balance.")] // 对应 ATA 余额不够
    InsufficientBalance,
    #[msg("Pool reserves are empty.")] // Yes/No 池子是空的
    EmptyPool,
    #[msg("Output amount is below min_out.")] // 到手数量低于你设的最低滑点
    SlippageExceeded,
    #[msg("LP amount must be greater than zero.")] // LP 数量不能为 0
    ZeroLp,
    #[msg("Mint does not belong to this market.")] // 这个 mint 不是本盘的 Yes 或 No
    InvalidMint,
    #[msg("Mint is not the winning outcome.")] // 裁决后只能用赢家代币兑付
    NotWinnerMint,
    #[msg("The market oracle cannot trade.")] // 预言机不能下注或换币
    AuthorityCannotTrade,
}
