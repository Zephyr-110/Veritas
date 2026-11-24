# Chainlink OCR2 Devnet Landing Census (2026-11-22)

This document records the provenance, inspection methodology, and independent verification path for the empirical **Chainlink OCR2** report-landing census cited in [README.md](../README.md) and the Veritas UI.

## Scope

- **Date:** November 22, 2026 (`2026-11-22`)
- **Network:** Solana Devnet
- **Chainlink OCR2 Program:** [`cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ`](https://explorer.solana.com/address/cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ?cluster=devnet)
- **Chainlink Store Program:** [`HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny`](https://explorer.solana.com/address/HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny?cluster=devnet)
- **Covered Feeds:** All **6** allowlisted feeds defined in [`programs/prediction_market/src/constants.rs`](../programs/prediction_market/src/constants.rs) and [`app/src/lib/feeds.ts`](../app/src/lib/feeds.ts):

| Pair | OCR2 State (`ocr2_state`) | Store Transmissions (`feed`) |
| :--- | :--- | :--- |
| `BTC/USD` | `HCKJKQ8xFfqm5BxTA6LaUCWYXNShYXF4eAwC7NhBYXkj` | `6PxBx93S8x3tno1TsFZwT5VqP8drrRCbCXygEXYNkFJe` |
| `ETH/USD` | `7zDTDDXiMqwbEEE17ZuFE4A6K5uBQo15tG1gkgdKZQB2` | `669U43LNHx7LsVj95uYksnhXUfWKDsdzVqev3V4Jpw3P` |
| `SOL/USD` | `EpFp9mhi9cvZL9Lp59S1mt2twv2dtZGgFUvZEQMZ9Ra8` | `99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR` |
| `LINK/USD` | `Ghm1a2c2NGPg6pKGG3PP1GLAuJkHm1RKMPqqJwPM7JpJ` | `HXoZZBWv25N4fm2vfSKnHXTeDJ31qaAcWZe3ZKeM6dQv` |
| `USDC/USD` | `ENVhPWE3nuvwc5qx2MjSwS41SXr33gFgGaWX4ATA9pyV` | `2EmfL3MqL3YHABudGNmajjCpR13NNEn9Y4LWxbDm6SwR` |
| `USDT/USD` | `DcZuU19fXJSEurnuFh4moeYK5hohvgaBD5KmjvHvYEG1` | `8QQSUPtdRTboa4bKyMftVNRfGFsB4Vp9d7r39hGKi53e` |

## Census Results

Across the 6 allowlisted Solana Devnet Chainlink OCR2 feeds on November 22, 2026:

- **Consecutive landed reports:** **2,384** landed reports ordered by `(epoch, round)` with **0** skipped rounds (zero sequence gaps).
- **Full-coverage straddling adjacent pairs:** **1,786** pairs within those consecutive transitions cover expiry boundaries cleanly as adjacent report pairs.
- **Concurrent ~50-minute failed-transaction window:** **18** failed `transmit` transactions were observed; **all 18** were duplicate-report rejections (retrying a round already committed by another transmitter), and **0** reports were "signed-but-unlanded".

## Inspection Methodology

1. **Sequence continuity check (`epoch/round` ordering):**
   For each of the 6 feeds, landed Chainlink OCR2 `transmit` payloads were decoded, sorted strictly in `(epoch, round)` order, and checked pairwise for round continuity — either consecutive round increments within the same epoch (`(epoch, round) -> (epoch, round + 1)`) or clean epoch rollover at `r_max` (`(epoch, r_max) -> (epoch + 1, 1)`).
2. **Boundary pair coverage check:**
   Consecutive landed transitions were verified to form straddling adjacent pairs without intervening gaps so that the last report strictly before expiry (`pre`) and the first report at or after expiry (`post`) satisfy on-chain primary-track adjacency without relying on an intermediate snapshot.
3. **Failed transmission audit (~50-minute window):**
   Failed `transmit` transactions on the feed accounts during the concurrent ~50-minute window were decoded and matched by `(epoch, round)` against landed transactions, confirming whether every rejection was an already-landed duplicate report rather than a signed report dropped from the ledger.

## Independent On-Chain Verification Path

Anyone can verify round numbering and adjacency directly on-chain:

1. Open any settled (**Resolved**) market page (`/markets/<address>`) in Veritas and scroll to the **Settlement evidence** (**裁决证据**) card, rendered client-side by [`RulingEvidence`](../app/src/components/ruling-evidence.tsx).
2. Inspect the decoded **Epoch/round** identifiers for both **Last report before expiry** (`pre`) and **First report at or after expiry** (`post`). Each identifier links directly to its on-chain Chainlink `transmit` transaction, and the footer links directly to the `resolve_market` transaction on Solana Explorer / Solscan.
3. As a concrete Devnet reference, transaction [`5d5FcdpyBHcibizcMP3CEgcWEWRQVruvh8QhGQGVq9FPevfbGno4fDjM2KVhpbuVsavrZRud8PCqJaeiBzeg6uzp`](https://explorer.solana.com/tx/5d5FcdpyBHcibizcMP3CEgcWEWRQVruvh8QhGQGVq9FPevfbGno4fDjM2KVhpbuVsavrZRud8PCqJaeiBzeg6uzp?cluster=devnet) demonstrates a live primary-track adjacent-round settlement on Solana Devnet.
4. For hypothetical congestion scenarios where a report skip could occur, the permissionless snapshot backstop (`take_snapshot` / `MarketSnapshot`) is covered by the Anchor/LiteSVM contract test suite under [`programs/prediction_market/tests/`](../programs/prediction_market/tests/).
