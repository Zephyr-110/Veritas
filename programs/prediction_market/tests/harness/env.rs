use anchor_lang::prelude::Pubkey;
use anchor_lang::AccountDeserialize;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use prediction_market::{LpPosition, Market, MarketSnapshot};
use solana_account::{Account as SolAccount, ReadableAccount};
use solana_clock::Clock;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;
use spl_token_interface::state::{Account as TokenAccount, Mint};

use super::ids::*;
use super::util::*;

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Actor,
    pub mint: Pubkey,
    pub clock: i64,
    pub ops: u32,
    pub lps: Vec<Pubkey>,
    pub last_cu: u64,
    pub pending_reports: Option<(Vec<u8>, Vec<u8>)>,
    feeds_ready: bool,
    tx_nonce: u64,
}

impl Env {
    pub fn new(start_ts: i64) -> Self {
        Self::new_with_decimals(start_ts, DECIMALS)
    }

    pub fn new_with_decimals(start_ts: i64, decimals: u8) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(addr(PROGRAM_ID), program_so())
            .expect("load program so");
        let payer = Actor::new();
        svm.airdrop(&payer.kp.pubkey(), 10_000_000_000_000).unwrap();
        let mut env = Self {
            svm,
            payer,
            mint: Pubkey::default(),
            clock: start_ts,
            ops: 0,
            lps: Vec::new(),
            last_cu: 0,
            pending_reports: None,
            feeds_ready: false,
            tx_nonce: 0,
        };
        env.set_clock(start_ts);
        env.create_mint(decimals);
        env
    }

    #[allow(dead_code)]
    pub fn house(&self) -> &Keypair {
        &self.payer.kp
    }

    pub fn house_pk(&self) -> Pubkey {
        self.payer.pk()
    }

    pub fn house_actor(&self) -> Actor {
        let bytes = self.payer.kp.to_bytes();
        Actor {
            kp: Keypair::try_from(&bytes[..]).expect("copy house key"),
        }
    }

    pub fn set_clock(&mut self, ts: i64) {
        self.clock = ts;
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = ts;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    pub fn warp(&mut self, ts: i64) {
        self.set_clock(ts);
    }

    fn create_mint(&mut self, decimals: u8) {
        let mint = self.create_mint_with(TOKEN_PROGRAM, decimals);
        self.mint = mint;
        self.ensure_ata(self.house_pk(), mint);
        self.mint_to(self.house_pk(), 1_000_000_000_000);
    }

    pub fn create_mint_with(&mut self, token_program: Pubkey, decimals: u8) -> Pubkey {
        let mint_kp = Keypair::new();
        let mint = pk_from_signer(&mint_kp);
        let payer = self.payer.pk();
        let lamports = self.svm.minimum_balance_for_rent_exemption(Mint::LEN);
        let ix_create = solana_system_interface::instruction::create_account(
            &payer,
            &mint,
            lamports,
            Mint::LEN as u64,
            &token_program,
        );
        let ix_init = if token_program == TOKEN_2022_PROGRAM {
            anchor_spl::token_2022::spl_token_2022::instruction::initialize_mint2(
                &token_program,
                &mint,
                &payer,
                None,
                decimals,
            )
            .unwrap()
        } else {
            spl_token_interface::instruction::initialize_mint2(
                &token_program,
                &mint,
                &payer,
                None,
                decimals,
            )
            .unwrap()
        };
        self.send(&[ix_create, ix_init], &[&mint_kp]);
        mint
    }

    pub fn send(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> TransactionMetadata {
        match self.send_raw(ixs, extra) {
            Ok(meta) => meta,
            Err(e) => panic!("tx failed: {:?}\n{}", e.err, e.meta.logs.join("\n")),
        }
    }

    pub fn send_raw(
        &mut self,
        ixs: &[Instruction],
        extra: &[&Keypair],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.tx_nonce = self.tx_nonce.saturating_add(1);
        let mut all = vec![
            ComputeBudgetInstruction::set_compute_unit_limit(
                1_400_000 - ((self.tx_nonce % 10_000) as u32),
            ),
            ComputeBudgetInstruction::request_heap_frame(256 * 1024),
        ];
        all.extend_from_slice(ixs);
        let payer_pk = self.payer.kp.pubkey();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new(&all, Some(&payer_pk));
        let mut kps: Vec<&Keypair> = vec![&self.payer.kp];
        for s in extra {
            if s.pubkey() != self.payer.kp.pubkey() {
                kps.push(*s);
            }
        }
        let tx = Transaction::new(&kps, msg, blockhash);
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        match &res {
            Ok(meta) => self.last_cu = meta.compute_units_consumed,
            Err(err) => self.last_cu = err.meta.compute_units_consumed,
        }
        res
    }

    pub fn send_market(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> TransactionMetadata {
        let meta = self.send(ixs, extra);
        self.ops += 1;
        meta
    }

    #[allow(dead_code)]
    pub fn expect_err(&mut self, ixs: &[Instruction], extra: &[&Keypair], needle: &str) {
        let err = self.send_raw(ixs, extra).expect_err("expected failure");
        let logs = err.meta.logs.join("\n");
        assert!(
            logs.contains(needle),
            "expected `{needle}` in logs:\n{logs}\nerr={:?}",
            err.err
        );
    }

    pub fn ensure_ata(&mut self, owner: Pubkey, mint: Pubkey) {
        self.ensure_ata_with(owner, mint, TOKEN_PROGRAM);
    }

    pub fn ensure_ata_with(&mut self, owner: Pubkey, mint: Pubkey, token_program: Pubkey) {
        let dest = ata_with(owner, mint, token_program);
        if self.svm.get_account(&addr(dest)).is_some() {
            return;
        }
        let ix = create_associated_token_account_idempotent(
            &self.payer.pk(),
            &owner,
            &mint,
            &token_program,
        );
        let _ = self.send(&[ix], &[]);
    }

    pub fn mint_to(&mut self, owner: Pubkey, amount: u64) {
        self.mint_to_with(owner, self.mint, TOKEN_PROGRAM, amount);
    }

    pub fn mint_to_with(
        &mut self,
        owner: Pubkey,
        mint: Pubkey,
        token_program: Pubkey,
        amount: u64,
    ) {
        self.ensure_ata_with(owner, mint, token_program);
        let dest = ata_with(owner, mint, token_program);
        let ix = if token_program == TOKEN_2022_PROGRAM {
            anchor_spl::token_2022::spl_token_2022::instruction::mint_to(
                &token_program,
                &mint,
                &dest,
                &self.payer.pk(),
                &[],
                amount,
            )
            .unwrap()
        } else {
            spl_token_interface::instruction::mint_to(
                &token_program,
                &mint,
                &dest,
                &self.payer.pk(),
                &[],
                amount,
            )
            .unwrap()
        };
        self.send(&[ix], &[]);
    }

    pub fn extra_mint(&mut self) -> Pubkey {
        self.create_mint_with(TOKEN_PROGRAM, DECIMALS)
    }

    pub fn fund_user(&mut self, amount: u64) -> Actor {
        let user = Actor::new();
        self.svm
            .airdrop(&user.kp.pubkey(), 1_000_000_000_000)
            .unwrap();
        self.mint_to(user.pk(), amount);
        user
    }

    pub fn token_amount(&self, account: Pubkey) -> u64 {
        match self.svm.get_account(&addr(account)) {
            Some(acc) if acc.data.len() >= TokenAccount::LEN => TokenAccount::unpack(&acc.data)
                .map(|a| a.amount)
                .unwrap_or(0),
            _ => 0,
        }
    }

    pub fn token_cover(&self, mint: Pubkey) -> u64 {
        let token_program = addr(TOKEN_PROGRAM);
        let mint_bytes = mint.to_bytes();
        let mut sum = 0u64;
        for acc in self.svm.accounts_db().inner.values() {
            if acc.owner() != &token_program {
                continue;
            }
            let data = acc.data();
            if data.len() < TokenAccount::LEN {
                continue;
            }
            let Ok(ta) = TokenAccount::unpack(data) else {
                continue;
            };
            if ta.mint.to_bytes() == mint_bytes {
                sum = sum.saturating_add(ta.amount);
            }
        }
        sum
    }

    pub fn mint_supply(&self, mint: Pubkey) -> u64 {
        let acc = self.svm.get_account(&addr(mint)).expect("mint");
        Mint::unpack(&acc.data).unwrap().supply
    }

    pub fn read_market(&self, keys: &MarketKeys) -> Market {
        let acc = self.svm.get_account(&addr(keys.market)).expect("market");
        let mut data: &[u8] = &acc.data;
        Market::try_deserialize(&mut data).expect("decode market")
    }

    pub fn read_lp(&self, keys: &MarketKeys, owner: Pubkey) -> Option<LpPosition> {
        let pk = keys.lp_position(owner);
        let acc = self.svm.get_account(&addr(pk))?;
        let mut data: &[u8] = &acc.data;
        LpPosition::try_deserialize(&mut data).ok()
    }

    pub fn account_alive(&self, pk: Pubkey) -> bool {
        self.svm
            .get_account(&addr(pk))
            .map(|a| a.lamports > 0)
            .unwrap_or(false)
    }

    pub fn ensure_feeds(&mut self) {
        if self.feeds_ready {
            return;
        }
        super::chainlink::install(self);
        self.feeds_ready = true;
    }

    pub fn install_all_feeds(&mut self) {
        super::chainlink::install_all_allowed_feeds(self);
        self.feeds_ready = true;
    }

    /// Queue a synthetic adjacent OCR2 pre/post report pair for `resolve`.
    pub fn queue_ocr2_reports(&mut self, price: i64, post_ts: i64, pre_ts: i64) {
        self.ensure_feeds();
        super::chainlink::queue(self, price, post_ts, pre_ts);
    }

    /// Queue a synthetic adjacent OCR2 pre/post report pair with an arbitrary i128 median.
    pub fn queue_ocr2_reports_i128(&mut self, median: i128, post_ts: i64, pre_ts: i64) {
        self.ensure_feeds();
        super::chainlink::queue_i128(self, median, post_ts, pre_ts);
    }

    pub fn tamper_queued_post(&mut self) {
        let (_, post) = self
            .pending_reports
            .as_mut()
            .expect("queue a report before tampering it");
        let i = post.len() - 1;
        post[i] ^= 0x01;
    }

    pub fn set_account_owner(&mut self, pk: Pubkey, owner: Pubkey) {
        let mut acc = self.svm.get_account(&addr(pk)).expect("account");
        acc.owner = addr(owner);
        self.svm.set_account(addr(pk), acc).expect("set owner");
    }

    pub fn forge_unlisted_state(&mut self) -> Pubkey {
        self.ensure_feeds();
        let kp = Keypair::new();
        let pk = pk_from_signer(&kp);
        let lamports = self.svm.minimum_balance_for_rent_exemption(1);
        self.svm
            .set_account(
                addr(pk),
                SolAccount {
                    lamports,
                    data: vec![0],
                    owner: addr(prediction_market::CHAINLINK_OCR2_PROGRAM_ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("forge state");
        pk
    }

    pub fn snapshot_len(&self, keys: &MarketKeys) -> usize {
        let acc = self
            .svm
            .get_account(&addr(keys.snapshot))
            .expect("snapshot");
        let mut data: &[u8] = &acc.data;
        MarketSnapshot::try_deserialize(&mut data)
            .expect("decode snapshot")
            .entries
            .len()
    }
}
