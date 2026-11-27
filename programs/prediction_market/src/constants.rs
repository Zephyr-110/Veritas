use anchor_lang::prelude::*;

#[constant]
pub const SERVICE_FEE : u64 = 50;

#[constant]
pub const FEE_INCREMENTAL: u64 = 250;

#[constant]
pub const FEE_ANCHOR_DURATION_SEC: i64 = 900;

#[constant]
pub const RESOLVE_WINDOW: u64 = 172800;

#[constant]
pub const MAX_SETTLE_DELAY: i64 = 10;

#[constant]
pub const CLAIM_WINDOW: u64 = 2_592_000;

// ============================================================================
// Chainlink OCR2 (Solana devnet)
// ============================================================================

/// Chainlink OCR2 程序：所有 feed 的 state 账户的 owner
#[constant]
pub const CHAINLINK_OCR2_PROGRAM_ID: Pubkey = pubkey!("cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ");

/// Chainlink store 程序：所有 feed（Transmissions）账户的 owner。合约不读，仅供前端 / 测试参考
pub const CHAINLINK_STORE_PROGRAM_ID: Pubkey = pubkey!("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");

/// 一个可开盘的 Chainlink 价格 feed
pub struct FeedInfo {
    /// 交易对，仅作标识
    pub name: &'static str,
    /// store 程序下的 Transmissions 账户（= state 第 16..48 字节记录的 feed）
    pub feed: Pubkey,
    /// OCR2 state 账户：结算时从这里读签名者名单 / f / 当前摘要，市场绑定的就是它
    pub state: Pubkey,
    /// state 偏移 320 处的 latest_config_digest 快照（2026-11-20 devnet）。
    /// 仅作记录与监控：Chainlink 轮换配置后会变，合约里不要拿它做 require
    pub config_digest: [u8; 32],
    /// 价格精度：median / 10^decimals = 美元价格（读自 feed 账户偏移 138）
    pub decimals: u8,
}

/// 白名单：只允许绑定这些官方 feed 的 state 账户。
/// 六个 feed 全部 f = 1（每份报告 2 个签名）、4 个 oracle、摘要都在 state 偏移 320，
/// 共用 math::ocr2::verify_report 一条验签路径。
pub const ALLOWED_FEEDS: &[FeedInfo] = &[
    FeedInfo {
        name: "BTC/USD",
        feed: pubkey!("6PxBx93S8x3tno1TsFZwT5VqP8drrRCbCXygEXYNkFJe"),
        state: pubkey!("HCKJKQ8xFfqm5BxTA6LaUCWYXNShYXF4eAwC7NhBYXkj"),
        config_digest: hex32("000313f1d4c985690d10b076382710ec0f1b56e242853c5227ccd0773a34f332"),
        decimals: 8,
    },
    FeedInfo {
        name: "ETH/USD",
        feed: pubkey!("669U43LNHx7LsVj95uYksnhXUfWKDsdzVqev3V4Jpw3P"),
        state: pubkey!("7zDTDDXiMqwbEEE17ZuFE4A6K5uBQo15tG1gkgdKZQB2"),
        config_digest: hex32("00032676f7187f38b18b2cc6cac5a385030690d48e854ea99b0da051ed1e7ae6"),
        decimals: 8,
    },
    FeedInfo {
        name: "SOL/USD",
        feed: pubkey!("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR"),
        state: pubkey!("EpFp9mhi9cvZL9Lp59S1mt2twv2dtZGgFUvZEQMZ9Ra8"),
        config_digest: hex32("00035db3d150cc0cd14d9cb1f1da219877e9843c79cb01b01bc14f51f9479684"),
        decimals: 8,
    },
    FeedInfo {
        name: "LINK/USD",
        feed: pubkey!("HXoZZBWv25N4fm2vfSKnHXTeDJ31qaAcWZe3ZKeM6dQv"),
        state: pubkey!("Ghm1a2c2NGPg6pKGG3PP1GLAuJkHm1RKMPqqJwPM7JpJ"),
        config_digest: hex32("000377d3f88b066d0644ac5eeb2f611adbef2823cb9ac700d7a695830e8029ed"),
        decimals: 8,
    },
    FeedInfo {
        name: "USDC/USD",
        feed: pubkey!("2EmfL3MqL3YHABudGNmajjCpR13NNEn9Y4LWxbDm6SwR"),
        state: pubkey!("ENVhPWE3nuvwc5qx2MjSwS41SXr33gFgGaWX4ATA9pyV"),
        config_digest: hex32("00036f4cfc7fc737fe7ee1ab57bcdec0db348a9c0bc82ec74daf719089d17c91"),
        decimals: 8,
    },
    FeedInfo {
        name: "USDT/USD",
        feed: pubkey!("8QQSUPtdRTboa4bKyMftVNRfGFsB4Vp9d7r39hGKi53e"),
        state: pubkey!("DcZuU19fXJSEurnuFh4moeYK5hohvgaBD5KmjvHvYEG1"),
        config_digest: hex32("000383e0502692b80f3c96eec5d8e2cc0901fed0e37c9e6eb95c52890536a0e3"),
        decimals: 8,
    },
];

/// 按 state 账户地址查白名单，不在表里返回 None
pub fn find_feed(state: &Pubkey) -> Option<&'static FeedInfo> {
    ALLOWED_FEEDS.iter().find(|f| f.state == *state)
}

/// 编译期把 64 位十六进制字符串解析成 32 字节；写错会直接编译失败
const fn hex32(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    assert!(b.len() == 64, "digest must be 64 hex chars");
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (hex_nibble(b[2 * i]) << 4) | hex_nibble(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn hex_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("invalid hex char in digest"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_table_is_consistent() {
        for (i, a) in ALLOWED_FEEDS.iter().enumerate() {
            assert_eq!(find_feed(&a.state).unwrap().name, a.name);
            assert_eq!(a.config_digest[..2], [0x00, 0x03], "{}: OCR2 digest prefix", a.name);
            for b in &ALLOWED_FEEDS[i + 1..] {
                assert_ne!(a.state, b.state, "duplicate state {} / {}", a.name, b.name);
                assert_ne!(a.feed, b.feed, "duplicate feed {} / {}", a.name, b.name);
                assert_ne!(a.state, b.feed);
            }
        }
        assert!(find_feed(&CHAINLINK_OCR2_PROGRAM_ID).is_none());
    }
}
