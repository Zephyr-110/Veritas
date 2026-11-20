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

/// Anchor discriminator of ocr_2 `State` = sha256("account:State")[..8].
/// Matches all six whitelisted devnet state accounts (checked 2026-11-20).
const STATE_DISCRIMINATOR: [u8; DISCRIMINATOR_LEN] = [0xd8, 0x92, 0x6b, 0x5e, 0x68, 0x4b, 0xb6, 0xb1];

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

// state.offchain_config = { version: u64, xs: [u8; 4096], len: u64 }, sitting right after Config.
const OFFCHAIN_BUF_OFFSET: usize = STATE_PREFIX_LEN + CONFIG_SIZE + 8;
const OFFCHAIN_BUF_CAP: usize = 4096;
const OFFCHAIN_LEN_OFFSET: usize = OFFCHAIN_BUF_OFFSET + OFFCHAIN_BUF_CAP;
/// OffchainConfigProto.r_max (uint32) field number.
const PROTO_R_MAX_FIELD: u64 = 6;

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
const _: () = assert!(OFFCHAIN_BUF_OFFSET == 376);
const _: () = assert!(OFFCHAIN_LEN_OFFSET + 8 == ORACLES_OFFSET);

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

fn check_state_header(data: &[u8]) -> Result<(), Ocr2Error> {
    if data.len() < STATE_LEN || data[..DISCRIMINATOR_LEN] != STATE_DISCRIMINATOR {
        return Err(Ocr2Error::InvalidInput);
    }
    Ok(())
}

fn parse_state(data: &[u8]) -> Result<StateView<'_>, Ocr2Error> {
    check_state_header(data)?;
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

/// Reads `r_max` (max rounds per epoch) from the OCR2 state account.
///
/// It lives in `state.offchain_config`, a protobuf `OffchainConfigProto` (`r_max` = field 6, uint32).
/// The config digest hashes the whole offchain_config, so once a report's digest equals
/// `state.latest_config_digest`, this value is bound to the same config the report was signed under.
///
/// Strict: bad length, malformed protobuf, missing/duplicate field 6, or a value outside 1..=255 is an error.
pub fn read_r_max(state_data: &[u8]) -> Result<u8, Ocr2Error> {
    check_state_header(state_data)?;
    let len = u64::from_le_bytes(
        state_data[OFFCHAIN_LEN_OFFSET..OFFCHAIN_LEN_OFFSET + 8]
            .try_into()
            .map_err(|_| Ocr2Error::InvalidInput)?,
    );
    if len > OFFCHAIN_BUF_CAP as u64 {
        return Err(Ocr2Error::InvalidInput);
    }
    let cfg = &state_data[OFFCHAIN_BUF_OFFSET..OFFCHAIN_BUF_OFFSET + len as usize];

    let mut pos = 0usize;
    let mut r_max: Option<u64> = None;
    while pos < cfg.len() {
        let tag = read_varint(cfg, &mut pos)?;
        match tag & 7 {
            0 => {
                let v = read_varint(cfg, &mut pos)?;
                if tag >> 3 == PROTO_R_MAX_FIELD {
                    if r_max.replace(v).is_some() {
                        return Err(Ocr2Error::InvalidInput);
                    }
                }
            }
            1 => skip(cfg, &mut pos, 8)?,
            2 => {
                let l = read_varint(cfg, &mut pos)?;
                let l = usize::try_from(l).map_err(|_| Ocr2Error::InvalidInput)?;
                skip(cfg, &mut pos, l)?;
            }
            5 => skip(cfg, &mut pos, 4)?,
            _ => return Err(Ocr2Error::InvalidInput),
        }
    }

    let v = r_max.ok_or(Ocr2Error::InvalidInput)?;
    match u8::try_from(v) {
        Ok(r) if r >= 1 => Ok(r),
        _ => Err(Ocr2Error::InvalidInput),
    }
}

fn skip(buf: &[u8], pos: &mut usize, n: usize) -> Result<(), Ocr2Error> {
    let end = pos.checked_add(n).ok_or(Ocr2Error::InvalidInput)?;
    if end > buf.len() {
        return Err(Ocr2Error::InvalidInput);
    }
    *pos = end;
    Ok(())
}

/// protobuf varint, at most 10 bytes.
fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64, Ocr2Error> {
    let mut value: u64 = 0;
    for i in 0..10 {
        let b = *buf.get(*pos).ok_or(Ocr2Error::InvalidInput)?;
        *pos += 1;
        let bits = u64::from(b & 0x7f);
        if i == 9 && bits > 1 {
            return Err(Ocr2Error::InvalidInput);
        }
        value |= bits << (7 * i);
        if b & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(Ocr2Error::InvalidInput)
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
        data[..DISCRIMINATOR_LEN].copy_from_slice(&STATE_DISCRIMINATOR);
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

    // Real offchain_config of the BTC/USD feed state (devnet, 2026-11-20), 560 bytes.
    const BTC_OFFCHAIN_CFG: &str = "0880a0d9e61d1080e497d0121880bcc1960b208088debe012880c8afa02530063a0401010101422069082ff17ae447e249ab2f0fa5d5cb699cc9d736de24cddb466f646b09223cac4220f12ede60063bb454c14aa65eab7ed1cb185fce0b0dbfd03b146f312bcfe8db9742204a9f30564899deca062e83502280e4271a14659d859de430064bbb20f331105142209761f00b38fe29e765f17a8859ab1314aec444fdb00233be26cf6488022d7ae74a34313244334b6f6f5750447a3573343543467a5a456d564d444475504a364a566161317957317448375141343353325842384644614a34313244334b6f6f57516f6131613857636b4b41347241554d73616b36737a6b59414665746474416e5147585a5650506f775437514a34313244334b6f6f574b52354c4c62566e546132386f74784a6831366466596e65586f69416a4b577578326e65704e4b50717058764a34313244334b6f6f575364397451314b70724533396b706247586d377337314a58766d745136734a6563774334396b33544e7864625200608094ebdc03688094ebdc03708094ebdc03788094ebdc0382018c010a20e5987f03d579ece157b82bb3f8faeabaab38bb75501bc3a2146958b13e13f83512203d60ab13951b4368bb3693483ffdccf223ff3a284a8b0e434ed2e18d40baa0c31a10e0c30487014f5cd9373c498c6906021c1a1038ec3f4bb20d1429cabfbadf40b100971a10ff54154b935b29fe36990fc5a465a5651a10804c0b9e7385c061101b4c6820c8b72f";

    fn state_with_offchain_cfg(cfg: &[u8]) -> Vec<u8> {
        let mut data = vec![0u8; STATE_LEN];
        data[..DISCRIMINATOR_LEN].copy_from_slice(&STATE_DISCRIMINATOR);
        data[OFFCHAIN_BUF_OFFSET..OFFCHAIN_BUF_OFFSET + cfg.len()].copy_from_slice(cfg);
        data[OFFCHAIN_LEN_OFFSET..OFFCHAIN_LEN_OFFSET + 8]
            .copy_from_slice(&(cfg.len() as u64).to_le_bytes());
        data
    }

    #[test]
    fn r_max_from_real_btc_config() {
        let cfg = decode_hex(BTC_OFFCHAIN_CFG);
        assert_eq!(cfg.len(), 560);
        assert_eq!(read_r_max(&state_with_offchain_cfg(&cfg)), Ok(6));
    }

    #[test]
    fn r_max_other_value() {
        // field 6 (tag 0x30) = 8, with an unrelated varint field 1 and a bytes field 7 around it
        let cfg = [0x08, 0x01, 0x30, 0x08, 0x3a, 0x02, 0x01, 0x01];
        assert_eq!(read_r_max(&state_with_offchain_cfg(&cfg)), Ok(8));
    }

    #[test]
    fn r_max_missing_fails() {
        let cfg = [0x08, 0x01];
        assert_eq!(read_r_max(&state_with_offchain_cfg(&cfg)), Err(Ocr2Error::InvalidInput));
        assert_eq!(read_r_max(&state_with_offchain_cfg(&[])), Err(Ocr2Error::InvalidInput));
    }

    #[test]
    fn r_max_duplicate_fails() {
        let cfg = [0x30, 0x06, 0x30, 0x06];
        assert_eq!(read_r_max(&state_with_offchain_cfg(&cfg)), Err(Ocr2Error::InvalidInput));
    }

    #[test]
    fn r_max_out_of_range_fails() {
        assert_eq!(read_r_max(&state_with_offchain_cfg(&[0x30, 0x00])), Err(Ocr2Error::InvalidInput));
        // 256
        assert_eq!(read_r_max(&state_with_offchain_cfg(&[0x30, 0x80, 0x02])), Err(Ocr2Error::InvalidInput));
        // 255 is fine
        assert_eq!(read_r_max(&state_with_offchain_cfg(&[0x30, 0xff, 0x01])), Ok(255));
    }

    #[test]
    fn r_max_malformed_fails() {
        // truncated varint
        assert!(read_r_max(&state_with_offchain_cfg(&[0x30, 0x80])).is_err());
        // length-delimited field running past the end
        assert!(read_r_max(&state_with_offchain_cfg(&[0x3a, 0x09, 0x01, 0x30, 0x06])).is_err());
        // unsupported wire type (3 = start group)
        assert!(read_r_max(&state_with_offchain_cfg(&[0x0b, 0x30, 0x06])).is_err());
        // over-long varint (11 bytes)
        let mut cfg = vec![0x30];
        cfg.extend_from_slice(&[0x80; 10]);
        cfg.push(0x01);
        assert!(read_r_max(&state_with_offchain_cfg(&cfg)).is_err());
    }

    #[test]
    fn r_max_bad_len_fails() {
        let mut data = state_with_offchain_cfg(&[0x30, 0x06]);
        data[OFFCHAIN_LEN_OFFSET..OFFCHAIN_LEN_OFFSET + 8].copy_from_slice(&4097u64.to_le_bytes());
        assert_eq!(read_r_max(&data), Err(Ocr2Error::InvalidInput));
        assert_eq!(read_r_max(&data[..STATE_LEN - 1]), Err(Ocr2Error::InvalidInput));
    }

    #[test]
    fn state_discriminator_is_anchor_hash() {
        let h = hashv(&[b"account:State"]);
        assert_eq!(h.as_ref()[..8], STATE_DISCRIMINATOR);
    }

    #[test]
    fn wrong_discriminator_fails() {
        let (raw, mut state, _) = btc_state();
        state[0] ^= 1;
        assert_eq!(verify_report(&raw, &state), Err(Ocr2Error::InvalidInput));

        let mut cfg_state = state_with_offchain_cfg(&[0x30, 0x06]);
        cfg_state[7] ^= 1;
        assert_eq!(read_r_max(&cfg_state), Err(Ocr2Error::InvalidInput));
    }
}
