use anchor_lang::prelude::Pubkey;
use anchor_lang::InstructionData;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use prediction_market::instructions::{CreateMarketParams, SwapParams, UserBetOnParams};
use prediction_market::state::MarketOutcome;
use solana_instruction::Instruction;

use super::env::Env;
use super::ids::*;
use super::util::*;

impl Env {
    pub fn create_market(&mut self, seed: u64, duration: i64, settle_above: bool) -> MarketKeys {
        let (keys, res) = self.create_market_raw(seed, duration, settle_above);
        let meta = res.unwrap_or_else(|e| {
            panic!(
                "create_market failed: {:?}\n{}",
                e.err,
                e.meta.logs.join("\n")
            )
        });
        println!(
            "create_market cu={} seed={seed} duration={duration} settle_above={settle_above}",
            meta.compute_units_consumed
        );
        self.ops += 1;
        if !self.lps.contains(&self.house_pk()) {
            self.lps.push(self.house_pk());
        }
        keys
    }

    pub fn create_market_raw(
        &mut self,
        seed: u64,
        duration: i64,
        settle_above: bool,
    ) -> (
        MarketKeys,
        Result<TransactionMetadata, FailedTransactionMetadata>,
    ) {
        self.create_market_raw_expiry(seed, (self.clock + duration) as u64, settle_above)
    }

    pub fn create_market_raw_expiry(
        &mut self,
        seed: u64,
        expiry: u64,
        settle_above: bool,
    ) -> (
        MarketKeys,
        Result<TransactionMetadata, FailedTransactionMetadata>,
    ) {
        self.create_market_on(
            seed,
            expiry,
            settle_above,
            prediction_market::ALLOWED_FEEDS[0].state,
        )
    }

    pub fn create_market_on_state(
        &mut self,
        seed: u64,
        duration: i64,
        settle_above: bool,
        state: Pubkey,
    ) -> MarketKeys {
        let (keys, res) =
            self.create_market_on(seed, (self.clock + duration) as u64, settle_above, state);
        let meta = res.unwrap_or_else(|e| {
            panic!(
                "create_market failed: {:?}\n{}",
                e.err,
                e.meta.logs.join("\n")
            )
        });
        println!(
            "create_market cu={} seed={seed} duration={duration} settle_above={settle_above} state={state}",
            meta.compute_units_consumed
        );
        self.ops += 1;
        if !self.lps.contains(&self.house_pk()) {
            self.lps.push(self.house_pk());
        }
        keys
    }

    pub fn create_market_on(
        &mut self,
        seed: u64,
        expiry: u64,
        settle_above: bool,
        state: Pubkey,
    ) -> (
        MarketKeys,
        Result<TransactionMetadata, FailedTransactionMetadata>,
    ) {
        self.create_market_with_mint(seed, expiry, settle_above, state, self.mint, TOKEN_PROGRAM)
    }

    pub fn create_market_with_mint(
        &mut self,
        seed: u64,
        expiry: u64,
        settle_above: bool,
        state: Pubkey,
        mint: Pubkey,
        token_program: Pubkey,
    ) -> (
        MarketKeys,
        Result<TransactionMetadata, FailedTransactionMetadata>,
    ) {
        self.ensure_feeds();
        let mut keys = MarketKeys::derive(next_market_id());
        keys.settle_above = settle_above;
        keys.start_ts = self.clock;
        keys.expiry = expiry;
        keys.seed = seed;
        keys.ocr2_state = state;
        self.ensure_ata_with(self.house_pk(), mint, token_program);
        let param = CreateMarketParams {
            expiry: keys.expiry,
            market_id: keys.id,
            prediction: [b'v'; 64],
            collateral_amount: seed,
            threshold: keys.threshold,
            settle_above: keys.settle_above,
        };
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(self.house_pk(), true, true),
                meta(keys.market, true, false),
                meta(state, false, false),
                meta(keys.snapshot, true, false),
                meta(keys.lp_position(self.house_pk()), true, false),
                meta(mint, false, false),
                meta(keys.yes_mint, true, false),
                meta(keys.no_mint, true, false),
                meta(keys.vault, true, false),
                meta(ata_with(self.house_pk(), mint, token_program), true, false),
                meta(keys.yes_pool, true, false),
                meta(keys.no_pool, true, false),
                meta(CLOCK_ID, false, false),
                meta(ATA_PROGRAM, false, false),
                meta(token_program, false, false),
                meta(SYSTEM_PROGRAM, false, false),
            ],
            data: prediction_market::instruction::CreateMarket { param }.data(),
        };
        let res = self.send_raw(&[ix], &[]);
        (keys, res)
    }

    pub fn add_liquidity(&mut self, keys: &MarketKeys, lp: &Actor, amount: u64) {
        self.add_liquidity_raw(keys, lp, amount)
            .unwrap_or_else(|e| {
                panic!(
                    "add_liquidity failed: {:?}\n{}",
                    e.err,
                    e.meta.logs.join("\n")
                )
            });
        self.ops += 1;
        if !self.lps.contains(&lp.pk()) {
            self.lps.push(lp.pk());
        }
    }

    pub fn add_liquidity_raw(
        &mut self,
        keys: &MarketKeys,
        lp: &Actor,
        amount: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.add_liquidity_raw_accounts(
            keys,
            lp,
            keys.lp_position(lp.pk()),
            self.mint,
            keys.yes_pool,
            keys.no_pool,
            amount,
        )
    }

    pub fn add_liquidity_raw_accounts(
        &mut self,
        keys: &MarketKeys,
        lp: &Actor,
        lp_position: Pubkey,
        collateral_mint: Pubkey,
        yes_pool: Pubkey,
        no_pool: Pubkey,
        amount: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.ensure_ata(lp.pk(), self.mint);
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(lp.pk(), true, true),
                meta(keys.market, true, false),
                meta(lp_position, true, false),
                meta(collateral_mint, false, false),
                meta(keys.yes_mint, true, false),
                meta(keys.no_mint, true, false),
                meta(ata(lp.pk(), keys.yes_mint), true, false),
                meta(ata(lp.pk(), keys.no_mint), true, false),
                meta(keys.vault, true, false),
                meta(ata(lp.pk(), self.mint), true, false),
                meta(yes_pool, true, false),
                meta(no_pool, true, false),
                meta(ATA_PROGRAM, false, false),
                meta(CLOCK_ID, false, false),
                meta(TOKEN_PROGRAM, false, false),
                meta(SYSTEM_PROGRAM, false, false),
            ],
            data: prediction_market::instruction::AddLiquidity {
                collateral_amount: amount,
            }
            .data(),
        };
        self.send_raw(&[ix], &[&lp.kp])
    }

    pub fn bet(&mut self, keys: &MarketKeys, user: &Actor, amount: u64, side: MarketOutcome) {
        self.bet_raw(keys, user, amount, side)
            .unwrap_or_else(|e| panic!("bet failed: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        self.ops += 1;
    }

    pub fn bet_raw(
        &mut self,
        keys: &MarketKeys,
        user: &Actor,
        amount: u64,
        side: MarketOutcome,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.bet_raw_min_out(keys, user, amount, side, 1)
    }

    pub fn bet_raw_min_out(
        &mut self,
        keys: &MarketKeys,
        user: &Actor,
        amount: u64,
        side: MarketOutcome,
        min_out: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.bet_raw_accounts(
            keys,
            user,
            ata(user.pk(), self.mint),
            keys.vault,
            amount,
            side,
            min_out,
        )
    }

    pub fn bet_raw_accounts(
        &mut self,
        keys: &MarketKeys,
        user: &Actor,
        collateral_ata: Pubkey,
        vault: Pubkey,
        amount: u64,
        side: MarketOutcome,
        min_out: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(user.pk(), true, true),
                meta(keys.market, true, false),
                meta(collateral_ata, true, false),
                meta(self.mint, false, false),
                meta(vault, true, false),
                meta(keys.yes_mint, true, false),
                meta(keys.no_mint, true, false),
                meta(ata(user.pk(), keys.yes_mint), true, false),
                meta(ata(user.pk(), keys.no_mint), true, false),
                meta(keys.yes_pool, true, false),
                meta(keys.no_pool, true, false),
                meta(CLOCK_ID, false, false),
                meta(ATA_PROGRAM, false, false),
                meta(TOKEN_PROGRAM, false, false),
                meta(SYSTEM_PROGRAM, false, false),
            ],
            data: prediction_market::instruction::UserBetOn {
                param: UserBetOnParams {
                    min_out,
                    collateral_amount: amount,
                    token_type: side,
                },
            }
            .data(),
        };
        self.send_raw(&[ix], &[&user.kp])
    }

    pub fn swap(&mut self, keys: &MarketKeys, user: &Actor, amount: u64, side: MarketOutcome) {
        self.ensure_ata(user.pk(), keys.yes_mint);
        self.ensure_ata(user.pk(), keys.no_mint);
        self.swap_raw(keys, user, amount, side)
            .unwrap_or_else(|e| panic!("swap failed: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        self.ops += 1;
    }

    pub fn swap_raw(
        &mut self,
        keys: &MarketKeys,
        user: &Actor,
        amount: u64,
        side: MarketOutcome,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.swap_raw_ex(
            keys,
            user,
            amount,
            side,
            1,
            ata(user.pk(), keys.yes_mint),
            ata(user.pk(), keys.no_mint),
        )
    }

    pub fn swap_raw_ex(
        &mut self,
        keys: &MarketKeys,
        user: &Actor,
        amount: u64,
        side: MarketOutcome,
        min_out: u64,
        yes_ata: Pubkey,
        no_ata: Pubkey,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(user.pk(), true, true),
                meta(keys.market, true, false),
                meta(keys.yes_mint, false, false),
                meta(keys.no_mint, false, false),
                meta(yes_ata, true, false),
                meta(no_ata, true, false),
                meta(keys.yes_pool, true, false),
                meta(keys.no_pool, true, false),
                meta(CLOCK_ID, false, false),
                meta(TOKEN_PROGRAM, false, false),
            ],
            data: prediction_market::instruction::Swap {
                param: SwapParams {
                    min_out,
                    amount_in: amount,
                    token_type: side,
                },
            }
            .data(),
        };
        self.send_raw(&[ix], &[&user.kp])
    }

    pub fn merge(&mut self, keys: &MarketKeys, user: &Actor, amount: u64) {
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(user.pk(), true, true),
                meta(keys.market, false, false),
                meta(ata(user.pk(), self.mint), true, false),
                meta(self.mint, false, false),
                meta(keys.vault, true, false),
                meta(keys.yes_mint, true, false),
                meta(keys.no_mint, true, false),
                meta(ata(user.pk(), keys.yes_mint), true, false),
                meta(ata(user.pk(), keys.no_mint), true, false),
                meta(TOKEN_PROGRAM, false, false),
            ],
            data: prediction_market::instruction::MergeToken {
                merge_amount: amount,
            }
            .data(),
        };
        self.send_market(&[ix], &[&user.kp]);
    }

    pub fn withdraw(&mut self, keys: &MarketKeys, lp: &Actor, shares: u64) {
        let res = self.withdraw_raw(keys, lp, shares);
        match res {
            Ok(_) => self.ops += 1,
            Err(e) => panic!("withdraw failed: {:?}\n{}", e.err, e.meta.logs.join("\n")),
        }
    }

    pub fn withdraw_raw(
        &mut self,
        keys: &MarketKeys,
        lp: &Actor,
        shares: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.withdraw_raw_position(keys, lp, keys.lp_position(lp.pk()), shares)
    }

    pub fn withdraw_raw_position(
        &mut self,
        keys: &MarketKeys,
        lp: &Actor,
        lp_position: Pubkey,
        shares: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.ensure_ata(lp.pk(), keys.yes_mint);
        self.ensure_ata(lp.pk(), keys.no_mint);
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(lp.pk(), true, true),
                meta(keys.market, true, false),
                meta(lp_position, true, false),
                meta(keys.yes_mint, false, false),
                meta(keys.no_mint, false, false),
                meta(ata(lp.pk(), keys.yes_mint), true, false),
                meta(ata(lp.pk(), keys.no_mint), true, false),
                meta(keys.yes_pool, true, false),
                meta(keys.no_pool, true, false),
                meta(CLOCK_ID, false, false),
                meta(ATA_PROGRAM, false, false),
                meta(TOKEN_PROGRAM, false, false),
                meta(SYSTEM_PROGRAM, false, false),
            ],
            data: prediction_market::instruction::GetLiquidity { lp_share: shares }.data(),
        };
        self.send_raw(&[ix], &[&lp.kp])
    }

    pub fn resolve(&mut self, keys: &MarketKeys) {
        self.resolve_raw(keys)
            .unwrap_or_else(|e| panic!("resolve failed: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        self.ops += 1;
    }

    pub fn resolve_raw(
        &mut self,
        keys: &MarketKeys,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let house = self.house_actor();
        self.resolve_raw_as(keys, &house)
    }

    pub fn resolve_raw_as(
        &mut self,
        keys: &MarketKeys,
        signer: &Actor,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.resolve_against_as(keys, signer, keys.ocr2_state)
    }

    pub fn resolve_raw_against(
        &mut self,
        keys: &MarketKeys,
        state: Pubkey,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let house = self.house_actor();
        self.resolve_against_as(keys, &house, state)
    }

    pub fn resolve_against_as(
        &mut self,
        keys: &MarketKeys,
        signer: &Actor,
        state: Pubkey,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let (raw_pre, raw_post) = self
            .pending_reports
            .clone()
            .expect("queue OCR2 reports before resolve");
        self.resolve_raw_full(keys, signer, Some(keys.snapshot), state, raw_pre, raw_post)
    }

    pub fn resolve_raw_full(
        &mut self,
        keys: &MarketKeys,
        signer: &Actor,
        snapshot: Option<Pubkey>,
        state: Pubkey,
        raw_pre: Vec<u8>,
        raw_post: Vec<u8>,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(signer.pk(), true, true),
                meta(keys.market, true, false),
                meta(snapshot.unwrap_or(PROGRAM_ID), false, false),
                meta(state, false, false),
                meta(CLOCK_ID, false, false),
            ],
            data: prediction_market::instruction::ResolveMarket {
                param: prediction_market::instructions::ResolveMarketParam { raw_pre, raw_post },
            }
            .data(),
        };
        self.send_raw(&[ix], &[&signer.kp])
    }

    pub fn void_market(&mut self, keys: &MarketKeys) {
        self.void_raw(keys)
            .unwrap_or_else(|e| panic!("void failed: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        self.ops += 1;
    }

    pub fn void_raw(
        &mut self,
        keys: &MarketKeys,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let house = self.house_actor();
        self.void_raw_as(keys, &house)
    }

    pub fn void_raw_as(
        &mut self,
        keys: &MarketKeys,
        signer: &Actor,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(signer.pk(), true, true),
                meta(keys.market, true, false),
                meta(CLOCK_ID, false, false),
            ],
            data: prediction_market::instruction::VoidMarket {}.data(),
        };
        self.send_raw(&[ix], &[&signer.kp])
    }

    pub fn redeem(&mut self, keys: &MarketKeys, user: &Actor, token_mint: Pubkey, amount: u64) {
        self.redeem_raw(keys, user, token_mint, amount)
            .unwrap_or_else(|e| panic!("redeem failed: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        self.ops += 1;
    }

    pub fn redeem_raw(
        &mut self,
        keys: &MarketKeys,
        user: &Actor,
        token_mint: Pubkey,
        amount: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.ensure_ata(user.pk(), self.mint);
        self.ensure_ata(user.pk(), token_mint);
        self.redeem_raw_accounts(
            keys,
            user,
            token_mint,
            ata(user.pk(), token_mint),
            keys.vault,
            amount,
        )
    }

    pub fn redeem_raw_accounts(
        &mut self,
        keys: &MarketKeys,
        user: &Actor,
        token_mint: Pubkey,
        token_ata: Pubkey,
        vault: Pubkey,
        amount: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.ensure_ata(user.pk(), self.mint);
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(user.pk(), true, true),
                meta(keys.market, false, false),
                meta(token_mint, true, false),
                meta(token_ata, true, false),
                meta(self.mint, false, false),
                meta(vault, true, false),
                meta(ata(user.pk(), self.mint), true, false),
                meta(TOKEN_PROGRAM, false, false),
            ],
            data: prediction_market::instruction::GetCollateral { amount }.data(),
        };
        self.send_raw(&[ix], &[&user.kp])
    }

    pub fn merge_raw(
        &mut self,
        keys: &MarketKeys,
        user: &Actor,
        amount: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.merge_raw_accounts(
            keys,
            user,
            ata(user.pk(), self.mint),
            keys.vault,
            ata(user.pk(), keys.yes_mint),
            ata(user.pk(), keys.no_mint),
            amount,
        )
    }

    pub fn merge_raw_accounts(
        &mut self,
        keys: &MarketKeys,
        user: &Actor,
        collateral_ata: Pubkey,
        vault: Pubkey,
        yes_ata: Pubkey,
        no_ata: Pubkey,
        amount: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(user.pk(), true, true),
                meta(keys.market, false, false),
                meta(collateral_ata, true, false),
                meta(self.mint, false, false),
                meta(vault, true, false),
                meta(keys.yes_mint, true, false),
                meta(keys.no_mint, true, false),
                meta(yes_ata, true, false),
                meta(no_ata, true, false),
                meta(TOKEN_PROGRAM, false, false),
            ],
            data: prediction_market::instruction::MergeToken {
                merge_amount: amount,
            }
            .data(),
        };
        self.send_raw(&[ix], &[&user.kp])
    }

    pub fn burn_account(&mut self, keys: &MarketKeys, signer: &Actor) {
        self.burn_account_raw(keys, signer).unwrap_or_else(|e| {
            panic!(
                "burn_account failed: {:?}\n{}",
                e.err,
                e.meta.logs.join("\n")
            )
        });
        self.ops += 1;
    }

    pub fn burn_account_raw(
        &mut self,
        keys: &MarketKeys,
        signer: &Actor,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.burn_account_raw_accounts(keys, signer, keys.snapshot, keys.vault)
    }

    pub fn burn_account_raw_accounts(
        &mut self,
        keys: &MarketKeys,
        signer: &Actor,
        snapshot: Pubkey,
        vault: Pubkey,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.ensure_ata(signer.pk(), self.mint);
        let ix = Instruction {
            program_id: addr(PROGRAM_ID),
            accounts: vec![
                meta(signer.pk(), true, true),
                meta(keys.market, true, false),
                meta(snapshot, true, false),
                meta(keys.yes_pool, true, false),
                meta(keys.no_pool, true, false),
                meta(keys.yes_mint, true, false),
                meta(keys.no_mint, true, false),
                meta(ata(signer.pk(), self.mint), true, false),
                meta(vault, true, false),
                meta(self.mint, false, false),
                meta(TOKEN_PROGRAM, false, false),
                meta(CLOCK_ID, false, false),
            ],
            data: prediction_market::instruction::BurnAccount {}.data(),
        };
        self.send_raw(&[ix], &[&signer.kp])
    }
}
