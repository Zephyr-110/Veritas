//! Chainlink OCR2 report authenticity. Does not implement market predicates.
//! Spec: chainlink-solana ocr_2 transmit_impl (digest, recover, roster).

use solana_keccak_hasher::hash as keccak_hash;
use solana_secp256k1_recover::{
    secp256k1_recover, Secp256k1RecoverError, SECP256K1_SIGNATURE_LENGTH,
};
use solana_sha256_hasher::hashv;

const DISCRIMINATOR_LEN: usize = 8;
const VERSION_LEN: usize = 1;
const VAULT_NONCE_LEN: usize = 1;
const PAD0_LEN: usize = 2;
const PAD1_LEN: usize = 4;
const PUBKEY_LEN: usize = 32;

const STATE_PREFIX_LEN: usize =
    DISCRIMINATOR_LEN + VERSION_LEN + VAULT_NONCE_LEN + PAD0_LEN + PAD1_LEN + PUBKEY_LEN;

const CONFIG_F_OFF: usize = PUBKEY_LEN * 6 + 16 * 2;
const CONFIG_DIGEST_OFF: usize = CONFIG_F_OFF + 1 + 1 + 2 + 4 + 4 + PUBKEY_LEN + 4;
const CONFIG_SIZE: usize = CONFIG_DIGEST_OFF + 32 + 8 + 8;
const OFFCHAIN_CONFIG_SIZE: usize = 8 + 4096 + 8;

const ORACLE_SIGNER_OFF: usize = PUBKEY_LEN;
const ORACLE_SIZE: usize = PUBKEY_LEN + 20 + PUBKEY_LEN + PUBKEY_LEN + 4 + 8;
const MAX_ORACLES: usize = 19;

const F_OFFSET: usize = STATE_PREFIX_LEN + CONFIG_F_OFF;
const DIGEST_OFFSET: usize = STATE_PREFIX_LEN + CONFIG_DIGEST_OFF;
const ORACLES_OFFSET: usize = STATE_PREFIX_LEN + CONFIG_SIZE + OFFCHAIN_CONFIG_SIZE;
const ORACLE_LEN_OFFSET: usize = ORACLES_OFFSET + MAX_ORACLES * ORACLE_SIZE;
const STATE_LEN: usize = ORACLE_LEN_OFFSET + 8;

const CONTEXT_LEN: usize = 96;
const REPORT_LEN: usize = 4 + 1 + 32 + 16 + 8;
const SIGNATURE_LEN: usize = SECP256K1_SIGNATURE_LENGTH + 1;
const RAW_REPORT_LEN: usize = CONTEXT_LEN + REPORT_LEN;

const _: () = assert!(REPORT_LEN == 61);
const _: () = assert!(CONFIG_SIZE == 320);
const _: () = assert!(ORACLE_SIZE == 128);
const _: () = assert!(F_OFFSET == 272);
const _: () = assert!(DIGEST_OFFSET == 320);
const _: () = assert!(ORACLES_OFFSET + ORACLE_SIGNER_OFF == 4512);
const _: () = assert!(STATE_LEN == 6920);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ocr2Error {
    InvalidInput,
    DigestMismatch,
    WrongNumberOfSignatures,
    InvalidSignature,
    UnauthorizedSigner,
    DuplicateSigner,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifiedReport {
    pub config_digest: [u8; 32],
    pub epoch: u32,
    pub round: u8,
    pub observations_timestamp: u32,
    pub median: i128,
}

impl VerifiedReport {
    pub fn packed_round(&self) -> u64 {
        ((self.epoch as u64) << 8) | u64::from(self.round)
    }
}

pub fn verify_report(raw: &[u8], state_data: &[u8]) -> Result<VerifiedReport, Ocr2Error> {
    let (_store_nonce, data) = raw.split_first().ok_or(Ocr2Error::InvalidInput)?;
    if data.len() <= RAW_REPORT_LEN {
        return Err(Ocr2Error::InvalidInput);
    }

    let (report_context, rest) = data.split_at(CONTEXT_LEN);
    let (raw_report, raw_signatures) = rest.split_at(REPORT_LEN);
    if report_context.len() != CONTEXT_LEN || raw_report.len() != REPORT_LEN {
        return Err(Ocr2Error::InvalidInput);
    }

    let config_digest: [u8; 32] = report_context[..32]
        .try_into()
        .map_err(|_| Ocr2Error::InvalidInput)?;
    let epoch = u32::from_be_bytes(
        report_context[59..63]
            .try_into()
            .map_err(|_| Ocr2Error::InvalidInput)?,
    );
    let round = report_context[63];

    let state = parse_state(state_data)?;
    if state.latest_config_digest != config_digest {
        return Err(Ocr2Error::DigestMismatch);
    }

    if raw_signatures.len() % SIGNATURE_LEN != 0 {
        return Err(Ocr2Error::InvalidInput);
    }
    let signature_count = raw_signatures.len() / SIGNATURE_LEN;
    if signature_count != usize::from(state.f) + 1 {
        return Err(Ocr2Error::WrongNumberOfSignatures);
    }

    let digest = hashv(&[&[raw_report.len() as u8], raw_report, report_context]);
    let mut uniques: u32 = 0;
    for chunk in raw_signatures.chunks(SIGNATURE_LEN) {
        let (recovery_id, signature) = chunk.split_last().ok_or(Ocr2Error::InvalidInput)?;
        let signer = secp256k1_recover(digest.as_ref(), *recovery_id, signature).map_err(
            |err| match err {
                Secp256k1RecoverError::InvalidHash | Secp256k1RecoverError::InvalidRecoveryId => {
                    Ocr2Error::InvalidInput
                }
                Secp256k1RecoverError::InvalidSignature => Ocr2Error::InvalidSignature,
            },
        )?;
        let address_hash = keccak_hash(&signer.0);
        let address: [u8; 20] = address_hash.as_ref()[12..32]
            .try_into()
            .map_err(|_| Ocr2Error::InvalidInput)?;
        let index = find_signer(state.oracles, state.oracle_len, &address)?;
        uniques |= 1 << index;
    }
    if uniques.count_ones() as usize != signature_count {
        return Err(Ocr2Error::DuplicateSigner);
    }

    let observations_timestamp = u32::from_be_bytes(
        raw_report[0..4]
            .try_into()
            .map_err(|_| Ocr2Error::InvalidInput)?,
    );
    let observer_count = raw_report[4];
    if state.f >= observer_count {
        return Err(Ocr2Error::InvalidInput);
    }
    let median = i128::from_be_bytes(
        raw_report[37..53]
            .try_into()
            .map_err(|_| Ocr2Error::InvalidInput)?,
    );

    Ok(VerifiedReport {
        config_digest,
        epoch,
        round,
        observations_timestamp,
        median,
    })
}

struct StateView<'a> {
    f: u8,
    latest_config_digest: [u8; 32],
    oracles: &'a [u8],
    oracle_len: usize,
}

fn parse_state(data: &[u8]) -> Result<StateView<'_>, Ocr2Error> {
    if data.len() < STATE_LEN {
        return Err(Ocr2Error::InvalidInput);
    }
    let latest_config_digest: [u8; 32] = data[DIGEST_OFFSET..DIGEST_OFFSET + 32]
        .try_into()
        .map_err(|_| Ocr2Error::InvalidInput)?;
    let oracle_len = u64::from_le_bytes(
        data[ORACLE_LEN_OFFSET..ORACLE_LEN_OFFSET + 8]
            .try_into()
            .map_err(|_| Ocr2Error::InvalidInput)?,
    ) as usize;
    if oracle_len > MAX_ORACLES {
        return Err(Ocr2Error::InvalidInput);
    }
    Ok(StateView {
        f: data[F_OFFSET],
        latest_config_digest,
        oracles: &data[ORACLES_OFFSET..ORACLE_LEN_OFFSET],
        oracle_len,
    })
}

fn find_signer(oracles: &[u8], n: usize, address: &[u8; 20]) -> Result<usize, Ocr2Error> {
    let mut lo = 0;
    let mut hi = n;
    while lo < hi {
        let mid = (lo + hi) / 2;
        let signer = oracle_signer(oracles, mid)?;
        match signer.cmp(address) {
            core::cmp::Ordering::Less => lo = mid + 1,
            core::cmp::Ordering::Greater => hi = mid,
            core::cmp::Ordering::Equal => return Ok(mid),
        }
    }
    Err(Ocr2Error::UnauthorizedSigner)
}

fn oracle_signer(oracles: &[u8], i: usize) -> Result<&[u8; 20], Ocr2Error> {
    let off = i * ORACLE_SIZE + ORACLE_SIGNER_OFF;
    oracles
        .get(off..off + 20)
        .ok_or(Ocr2Error::InvalidInput)?
        .try_into()
        .map_err(|_| Ocr2Error::InvalidInput)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPECIMEN_1: &str = "fc000313f1d4c985690d10b076382710ec0f1b56e242853c5227ccd0773a34f332000000000000000000000000000000000000000000000000000000006d931a02c56ddda6cd71f80dc3a65008fbd10bbc45b885128f85b35ddbf510c3449720546afebca50400010203000000000000000000000000000000000000000000000000000000000000000000000000000005cd41a91f4700000001e302cbf60f02bb7518fb932c631ae687eea974ee51cc1194177d7dddaf8e850b0c64c8d1011f3f8c81d8075fbf4b987fb8d4ae8a84ca161873c15d47aed574b5dc511fa2006aa6dff8ad947ffeeb1b209ffb316a526f9fb4ecf7d3e6fc8ae7812854d39f7d125748d62b75440e19658b3da0202f0ad491ca0497ddd2aed2d5fe3ea013e3c501";
    const SPECIMEN_2: &str = "fc000313f1d4c985690d10b076382710ec0f1b56e242853c5227ccd0773a34f332000000000000000000000000000000000000000000000000000000006d931a034b031a3303c27b921b9850ecff5e20a7a9279f7b3480e4dbb3cb19194076d9496afebca80400010302000000000000000000000000000000000000000000000000000000000000000000000000000005cd40d8d67100000001e302cbf6b6c2fb5df295db456fa7c182d5d99f402aef7af958de0b80bec21b083e2603ba777e71a4d2f40b7996d67d1e489a0b6910bd65fe9288e21ab1447b8b2b5c4cd70151737ad793c3038f8e9a410e3610d539f12032b8dd68d915c44234cdc603c78b0f82950ece72ccbe008ce571618a8bd3ab0cda18be5c17ae68f9b7eb12ac6bd500";

    const BTC_SIGNERS: [&str; 4] = [
        "43862aa2c2aec4d4aa7a8bd7393f6dda80325bf3",
        "56d45590d79e5930909d507ac828052690280310",
        "69336b1e52a64c28f93bc0d6a9b6b442378c4edf",
        "76a460f8c02e140efeb3ab54d80536a143eb80f1",
    ];

    fn decode_hex(s: &str) -> Vec<u8> {
        assert!(s.len() % 2 == 0, "odd hex length");
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }

    fn signer_list(hexes: &[&str]) -> Vec<[u8; 20]> {
        hexes
            .iter()
            .map(|s| decode_hex(s).try_into().unwrap())
            .collect()
    }

    fn build_state(f: u8, digest: [u8; 32], mut signers: Vec<[u8; 20]>) -> Vec<u8> {
        signers.sort_unstable();
        let mut data = vec![0u8; STATE_LEN];
        data[F_OFFSET] = f;
        data[DIGEST_OFFSET..DIGEST_OFFSET + 32].copy_from_slice(&digest);
        for (i, signer) in signers.iter().enumerate() {
            let off = ORACLES_OFFSET + i * ORACLE_SIZE + ORACLE_SIGNER_OFF;
            data[off..off + 20].copy_from_slice(signer);
        }
        data[ORACLE_LEN_OFFSET..ORACLE_LEN_OFFSET + 8]
            .copy_from_slice(&(signers.len() as u64).to_le_bytes());
        data
    }

    fn btc_state() -> (Vec<u8>, Vec<u8>, [u8; 32]) {
        let raw = decode_hex(SPECIMEN_1);
        let digest: [u8; 32] = raw[1..33].try_into().unwrap();
        (
            raw,
            build_state(1, digest, signer_list(&BTC_SIGNERS)),
            digest,
        )
    }

    #[test]
    fn specimen_one_verifies() {
        let (raw, state, digest) = btc_state();
        let got = verify_report(&raw, &state).unwrap();
        assert_eq!(got.config_digest, digest);
        assert_eq!(got.epoch, 7_181_082);
        assert_eq!(got.round, 2);
        assert_eq!(got.observations_timestamp, 1_795_079_333);
        assert_eq!(got.median, 6_379_128_037_191);
        assert_eq!(got.packed_round(), (7_181_082u64 << 8) | 2);
    }

    #[test]
    fn specimen_two_verifies_and_is_next_round() {
        let (_, state, digest) = btc_state();
        let raw = decode_hex(SPECIMEN_2);
        let pre = verify_report(&decode_hex(SPECIMEN_1), &state).unwrap();
        let post = verify_report(&raw, &state).unwrap();
        assert_eq!(post.config_digest, digest);
        assert_eq!(post.epoch, 7_181_082);
        assert_eq!(post.round, 3);
        assert_eq!(post.observations_timestamp, 1_795_079_336);
        assert_eq!(post.median, 6_379_114_387_057);
        assert_eq!(post.packed_round(), pre.packed_round() + 1);
    }

    #[test]
    fn tamper_any_byte_fails() {
        let (mut raw, state, _) = btc_state();
        raw[40] ^= 1;
        assert!(verify_report(&raw, &state).is_err());
    }

    #[test]
    fn signer_not_on_roster_fails() {
        let (raw, _, digest) = btc_state();
        let state = build_state(
            1,
            digest,
            signer_list(&[
                "1111111111111111111111111111111111111111",
                "2222222222222222222222222222222222222222",
                "3333333333333333333333333333333333333333",
                "4444444444444444444444444444444444444444",
            ]),
        );
        assert_eq!(
            verify_report(&raw, &state),
            Err(Ocr2Error::UnauthorizedSigner)
        );
    }

    #[test]
    fn duplicate_signer_fails() {
        let (mut raw, state, _) = btc_state();
        let sig0 = raw[158..223].to_vec();
        raw[223..288].copy_from_slice(&sig0);
        assert_eq!(verify_report(&raw, &state), Err(Ocr2Error::DuplicateSigner));
    }

    #[test]
    fn digest_mismatch_fails() {
        let (raw, mut state, _) = btc_state();
        state[DIGEST_OFFSET] ^= 1;
        assert_eq!(verify_report(&raw, &state), Err(Ocr2Error::DigestMismatch));
    }

    #[test]
    fn wrong_signature_count_fails() {
        let (raw, _, digest) = btc_state();
        let state = build_state(2, digest, signer_list(&BTC_SIGNERS));
        assert_eq!(
            verify_report(&raw, &state),
            Err(Ocr2Error::WrongNumberOfSignatures)
        );
    }
}
