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

## Sample window and results

The replay uses finalized Solana **block time** in the half-open interval **[2026-11-22 00:00:00 UTC, 2026-11-23 00:00:00 UTC)**. The first and last columns below identify actual landed transmissions on November 22. Each row compares successive reports on that feed in ledger order.

| Feed | First slot | First UTC | Last slot | Last UTC | Landed reports | Strict adjacent pairs | Nonadjacent transitions |
| --- | ---: | --- | ---: | --- | ---: | ---: | ---: |
| BTC/USD | 524884768 | 00:00:00 | 525243994 | 23:59:58 | 28,786 | 28,781 | 4 |
| ETH/USD | 524884768 | 00:00:00 | 525243992 | 23:59:58 | 28,786 | 28,781 | 4 |
| SOL/USD | 524884771 | 00:00:01 | 525243991 | 23:59:57 | 28,786 | 28,782 | 3 |
| LINK/USD | 524884768 | 00:00:00 | 525243991 | 23:59:57 | 28,784 | 28,778 | 5 |
| USDC/USD | 524884768 | 00:00:00 | 525243992 | 23:59:58 | 28,785 | 28,779 | 5 |
| USDT/USD | 524884772 | 00:00:01 | 525243992 | 23:59:58 | 28,787 | 28,783 | 3 |
| **Total** | | | | | **172,714** | **172,684** | **24** |

Each feed contributes one fewer transition than reports. Across the six feeds, 172,714 − 6 = 172,708 transitions.

Of the 24 nonadjacent transitions, 17 entered round 1 of the next epoch before the prior epoch reached round 6. The other seven moved from round 6 to round 1 two epochs later. For example, BTC moved from `(7193933, 3)` at slot 524905634 to `(7193934, 1)` at slot 524905669. The archive contains both signatures. These identifiers establish an on-chain discontinuity under the strict settlement rule. They cannot show whether another round was signed off-chain.

**Historical sample.** The earliest repository record, commit `714bb58` at **09:24:26 UTC on November 22**, already cited **2,384 Store transitions**, zero skipped rounds and **1,786 full-coverage adjacent pairs**. Commit `77ef49b` described the 2,384 as landed reports. The original scan script, per-feed boundaries, transaction list and expiry selection behind the 1,786 were unavailable for this replay. The published sample predates the end of the UTC day. Counting the complete day yields **170,330 more reports**. Its six subtotals cannot establish how the original 2,384 were distributed.

The historical document also recorded 18 failed duplicate transmissions over roughly 50 minutes. Its exact interval is unknown. The full-day replay counts successful transmissions and makes no inference about reports signed off-chain.

## Reproduce the full-day count

From the repository root, install the root Node dependencies with `npm ci`. Set `SOLANA_RPC` to a Helius **Devnet** archive endpoint supporting `getTransactionsForAddress`. The script checks the genesis hash, pages until exhaustion and prints each feed's first and last signatures, slots, UTC times and counts. The optional final argument saves a new evidence file.

```sh
node scripts/census-ocr2.js 2026-11-22T00:00:00Z 2026-11-23T00:00:00Z replay.csv.gz
```

The [collector](../scripts/census-ocr2.js) examines successful outer and inner instructions, matching the OCR2 program, state account and Store program. It decodes the signed transmit payload against each feed's pinned configuration digest. The six finalized state accounts at slot 525816420 all had `f=1` and `rMax=6`. A strict adjacent pair increments the round within the same epoch or rolls from round 6 to round 1 of the next epoch. A nonadjacent transition counts once regardless of the distance between its round identifiers.

All **172,684** strict adjacent pairs also had increasing signed observation timestamps. Each can therefore straddle at least one integer-second expiry satisfying `pre.observationTime < expiry <= post.observationTime`. This measures possible expiry boundaries. The historical 1,786 lacks a recorded expiry list or selection rule for a like-for-like comparison.

## Saved evidence and offline recount

The [gzipped CSV](oracle-census-2026-11-22.csv.gz) contains one row per landed report, including its Devnet transaction signature. The instruction column identifies a zero-based outer instruction, or `outer.inner` for a CPI. Both time columns contain Unix seconds. To check a row independently, retrieve its signature with finalized `getTransaction`, verify the slot, block time and OCR2 accounts, and decode the indicated instruction.

The [offline verifier](../scripts/verify-census.py) reads the archive with the Python standard library, checks per-feed ledger order and independently calculates adjacency, endpoints and totals. Compare its SHA-256 of the uncompressed CSV with the digest below or with a fresh online replay.

```sh
python scripts/verify-census.py docs/oracle-census-2026-11-22.csv.gz
```

Uncompressed CSV SHA-256: `be095da5c4f89edfa8428e11e8815c8472eef5d62cd2288533176ac4c49fcfe1`.

For an independent check of all six subtotals, add `--check-boundaries` to the Python command. It fetches the twelve boundary transactions from the public Solana Devnet RPC and reads the OCR2 `NewTransmission.round_id` event counter. For each feed, the last counter minus the first plus one matched the number of rows. For example, the BTC counters were 41,874,684 and 41,903,469, yielding 28,786 reports. The two archive scans and the offline recount agreed.

## Independent On-Chain Verification Path

Anyone can verify round numbering and adjacency directly on-chain:

1. Open any settled (**Resolved**) market page (`/markets/<address>`) in Veritas and scroll to the **Settlement evidence** (**裁决证据**) card, rendered client-side by [`RulingEvidence`](../app/src/components/ruling-evidence.tsx).
2. Inspect the decoded **Epoch/round** identifiers for both **Last report before expiry** (`pre`) and **First report at or after expiry** (`post`). Each identifier links directly to its on-chain Chainlink `transmit` transaction, and the footer links directly to the `resolve_market` transaction on Solana Explorer / Solscan.
3. As a concrete Devnet reference, transaction [`5d5FcdpyBHcibizcMP3CEgcWEWRQVruvh8QhGQGVq9FPevfbGno4fDjM2KVhpbuVsavrZRud8PCqJaeiBzeg6uzp`](https://explorer.solana.com/tx/5d5FcdpyBHcibizcMP3CEgcWEWRQVruvh8QhGQGVq9FPevfbGno4fDjM2KVhpbuVsavrZRud8PCqJaeiBzeg6uzp?cluster=devnet) demonstrates a live primary-track adjacent-round settlement on Solana Devnet.
4. For hypothetical congestion scenarios where a report skip could occur, the permissionless snapshot backstop (`take_snapshot` / `MarketSnapshot`) is covered by the Anchor/LiteSVM contract test suite under [`programs/prediction_market/tests/`](../programs/prediction_market/tests/).
