use anchor_lang::{AccountDeserialize, AccountSerialize};
use anchor_lang::prelude::Pubkey;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use prediction_market::{LpPosition, Market};
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_account::Account as SolAccount;
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
    tx_nonce: u64,
}

impl Env {
    pub fn new(start_ts: i64) -> Self {
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
            tx_nonce: 0,
        };
        env.set_clock(start_ts);
        env.create_mint();
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
        let bytes = self.payer.kp.to_bytes(); Actor { kp: Keypair::try_from(&bytes[..]).expect("copy house key") }
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

    fn create_mint(&mut self) {
        let mint_kp = Keypair::new();
        let mint = pk_from_signer(&mint_kp);
        let payer = self.payer.pk();
        let lamports = self.svm.minimum_balance_for_rent_exemption(Mint::LEN);
        let ix_create = solana_system_interface::instruction::create_account(
            &payer,
            &mint,
            lamports,
            Mint::LEN as u64,
            &TOKEN_PROGRAM,
        );
        let ix_init = spl_token_interface::instruction::initialize_mint2(
            &TOKEN_PROGRAM,
            &mint,
            &payer,
            None,
            DECIMALS,
        )
        .unwrap();
        self.send(&[ix_create, ix_init], &[&mint_kp]);
        self.mint = mint;
        self.ensure_ata(self.house_pk(), mint);
        self.mint_to(self.house_pk(), 1_000_000_000_000);
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
        let dest = ata(owner, mint);
        if self.svm.get_account(&addr(dest)).is_some() {
            return;
        }
        let ix = create_associated_token_account_idempotent(
            &self.payer.pk(),
            &owner,
            &mint,
            &TOKEN_PROGRAM,
        );
        let _ = self.send(&[ix], &[]);
    }

    pub fn mint_to(&mut self, owner: Pubkey, amount: u64) {
        self.ensure_ata(owner, self.mint);
        let dest = ata(owner, self.mint);
        let ix = spl_token_interface::instruction::mint_to(
            &TOKEN_PROGRAM,
            &self.mint,
            &dest,
            &self.payer.pk(),
            &[],
            amount,
        )
        .unwrap();
        self.send(&[ix], &[]);
    }

    pub fn extra_mint(&mut self) -> Pubkey {
        let mint_kp = Keypair::new();
        let mint = pk_from_signer(&mint_kp);
        let payer = self.payer.pk();
        let lamports = self.svm.minimum_balance_for_rent_exemption(Mint::LEN);
        let ix_create = solana_system_interface::instruction::create_account(
            &payer,
            &mint,
            lamports,
            Mint::LEN as u64,
            &TOKEN_PROGRAM,
        );
        let ix_init = spl_token_interface::instruction::initialize_mint2(
            &TOKEN_PROGRAM,
            &mint,
            &payer,
            None,
            DECIMALS,
        )
        .unwrap();
        self.send(&[ix_create, ix_init], &[&mint_kp]);
        mint
    }

    pub fn fund_user(&mut self, amount: u64) -> Actor {
        let user = Actor::new();
        self.svm.airdrop(&user.kp.pubkey(), 1_000_000_000_000).unwrap();
        self.mint_to(user.pk(), amount);
        user
    }

    pub fn token_amount(&self, account: Pubkey) -> u64 {
        match self.svm.get_account(&addr(account)) {
            Some(acc) if acc.data.len() >= TokenAccount::LEN => {
                TokenAccount::unpack(&acc.data).map(|a| a.amount).unwrap_or(0)
            }
            _ => 0,
        }
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
        self.svm.get_account(&addr(pk)).map(|a| a.lamports > 0).unwrap_or(false)
    }

    pub fn inject_pyth(
        &mut self,
        price: i64,
        publish_time: i64,
        prev_publish_time: i64,
        exponent: i32,
        feed_id: [u8; 32],
    ) -> Pubkey {
        self.inject_pyth_ex(
            price,
            publish_time,
            prev_publish_time,
            exponent,
            feed_id,
            VerificationLevel::Full,
            PYTH_RECEIVER,
        )
    }

    pub fn inject_pyth_partial(
        &mut self,
        price: i64,
        publish_time: i64,
        prev_publish_time: i64,
        exponent: i32,
        feed_id: [u8; 32],
    ) -> Pubkey {
        self.inject_pyth_ex(
            price,
            publish_time,
            prev_publish_time,
            exponent,
            feed_id,
            VerificationLevel::Partial { num_signatures: 5 },
            PYTH_RECEIVER,
        )
    }

    pub fn inject_pyth_wrong_owner(
        &mut self,
        price: i64,
        publish_time: i64,
        prev_publish_time: i64,
        exponent: i32,
        feed_id: [u8; 32],
    ) -> Pubkey {
        self.inject_pyth_ex(
            price,
            publish_time,
            prev_publish_time,
            exponent,
            feed_id,
            VerificationLevel::Full,
            SYSTEM_PROGRAM,
        )
    }

    pub fn inject_pyth_ex(
        &mut self,
        price: i64,
        publish_time: i64,
        prev_publish_time: i64,
        exponent: i32,
        feed_id: [u8; 32],
        verification_level: VerificationLevel,
        owner: Pubkey,
    ) -> Pubkey {
        let kp = Keypair::new();
        let pk = pk_from_signer(&kp);
        let update = PriceUpdateV2 {
            write_authority: Pubkey::default(),
            verification_level,
            price_message: PriceFeedMessage {
                feed_id,
                price,
                conf: 1,
                exponent,
                publish_time,
                prev_publish_time,
                ema_price: price,
                ema_conf: 1,
            },
            posted_slot: 1,
        };
        let mut data = Vec::new();
        update.try_serialize(&mut data).unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                addr(pk),
                SolAccount {
                    lamports,
                    data,
                    owner: addr(owner),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        pk
    }
}
