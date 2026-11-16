use prediction_market::state::{MarketOutcome, MarketStatus};

use super::env::Env;
use super::util::{band, bits_f64, MarketKeys};

#[derive(Debug, Clone)]
pub struct Ledger {
    pub stage: String,
    pub book_yes: f64,
    pub book_no: f64,
    pub pending_yes: f64,
    pub pending_no: f64,
    pub phys_yes: f64,
    pub phys_no: f64,
    pub err_yes: f64,
    pub err_no: f64,
    pub share_err: f64,
    pub vault: f64,
    pub yes_supply: f64,
    pub no_supply: f64,
    pub solvency_err: f64,
    pub band: f64,
    pub status: String,
}

impl Ledger {
    pub fn assert_ok(&self) {
        assert!(
            self.err_yes <= self.band,
            "{} yes conservation err {} > band {}",
            self.stage, self.err_yes, self.band
        );
        assert!(
            self.err_no <= self.band,
            "{} no conservation err {} > band {}",
            self.stage, self.err_no, self.band
        );
        assert!(
            self.share_err <= self.band.max(1.0),
            "{} share err {} > band {}",
            self.stage, self.share_err, self.band
        );
        assert!(
            self.solvency_err <= self.band + 1.0,
            "{} solvency err {} > band {}",
            self.stage, self.solvency_err, self.band
        );
    }

    pub fn assert_tight(&self, cap: f64) {
        self.assert_ok();
        assert!(
            self.err_yes <= cap,
            "{} yes conservation err {} > tight cap {}",
            self.stage, self.err_yes, cap
        );
        assert!(
            self.err_no <= cap,
            "{} no conservation err {} > tight cap {}",
            self.stage, self.err_no, cap
        );
        assert!(
            self.solvency_err <= cap + 1.0,
            "{} solvency err {} > tight cap {}",
            self.stage, self.solvency_err, cap
        );
    }
}

impl Env {
    pub fn ledger(&self, keys: &MarketKeys, stage: &str) -> Ledger {
        let m = self.read_market(keys);
        let book_yes = bits_f64(m.reserve_yes);
        let book_no = bits_f64(m.reserve_no);
        let total_shares = bits_f64(m.total_lp_shares);
        let mut pending_yes = 0.0;
        let mut pending_no = 0.0;
        let mut share_sum = 0.0;
        for owner in &self.lps {
            if let Some(p) = self.read_lp(keys, *owner) {
                let s = bits_f64(p.shares);
                share_sum += s;
                pending_yes += (bits_f64(m.cum_yes_per_share) - bits_f64(p.checkpoint_yes)).max(0.0) * s;
                pending_no += (bits_f64(m.cum_no_per_share) - bits_f64(p.checkpoint_no)).max(0.0) * s;
            }
        }
        let phys_yes = self.token_amount(keys.yes_pool) as f64;
        let phys_no = self.token_amount(keys.no_pool) as f64;
        let band = band(self.ops, phys_yes + phys_no);
        let err_yes = (book_yes + pending_yes - phys_yes).abs();
        let err_no = (book_no + pending_no - phys_no).abs();
        let share_err = (total_shares - share_sum).abs();
        let vault = self.token_amount(keys.vault) as f64;
        let yes_supply = self.mint_supply(keys.yes_mint) as f64;
        let no_supply = self.mint_supply(keys.no_mint) as f64;
        let redeemable = match m.status {
            MarketStatus::Open => yes_supply.max(no_supply),
            MarketStatus::Resolved => match m.winner {
                Some(MarketOutcome::Yes) => yes_supply,
                Some(MarketOutcome::No) => no_supply,
                None => 0.0,
            },
            MarketStatus::WindowBurn | MarketStatus::StaleBurn => (yes_supply + no_supply) / 2.0,
        };
        let solvency_err = (vault - redeemable).abs();
        let l = Ledger {
            stage: stage.to_string(),
            book_yes,
            book_no,
            pending_yes,
            pending_no,
            phys_yes,
            phys_no,
            err_yes,
            err_no,
            share_err,
            vault,
            yes_supply,
            no_supply,
            solvency_err,
            band,
            status: format!("{:?}", m.status),
        };
        println!(
            "LEDGER {stage}: book=({:.6},{:.6}) pending=({:.6},{:.6}) phys=({:.0},{:.0}) err=({:.6},{:.6}) shares_err={:.6} vault={:.0} supply=({:.0},{:.0}) solvency_err={:.6} band={:.6} status={}",
            l.book_yes, l.book_no, l.pending_yes, l.pending_no, l.phys_yes, l.phys_no, l.err_yes, l.err_no, l.share_err, l.vault, l.yes_supply, l.no_supply, l.solvency_err, l.band, l.status
        );
        l
    }
}
