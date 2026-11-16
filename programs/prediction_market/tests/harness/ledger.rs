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
    pub market_status: MarketStatus,
    pub winner: Option<MarketOutcome>,
    pub yes_cover: u64,
    pub no_cover: u64,
    pub yes_supply_u64: u64,
    pub no_supply_u64: u64,
    pub vault_u64: u64,
    pub liability_u64: u64,
}

impl Ledger {
    pub fn assert_ok(&self) {
        let cap = self.band.min(8.0);
        assert!(
            self.err_yes <= cap,
            "{} yes conservation err {} > cap {} (band {})",
            self.stage, self.err_yes, cap, self.band
        );
        assert!(
            self.err_no <= cap,
            "{} no conservation err {} > cap {} (band {})",
            self.stage, self.err_no, cap, self.band
        );
        assert!(
            self.share_err <= cap.max(1.0),
            "{} share err {} > cap {}",
            self.stage, self.share_err, cap
        );
        assert!(
            self.solvency_err <= cap + 1.0,
            "{} solvency err {} > cap {}",
            self.stage, self.solvency_err, cap
        );
        self.assert_backing();
    }

    /// Integer solvency. Open is 1:1 complete-set backing. Resolved is
    /// vault == remaining winner supply. Voids may keep floor dust.
    pub fn assert_backing(&self) {
        assert_eq!(
            self.yes_cover, self.yes_supply_u64,
            "{} yes mint supply {} != all token accounts {}",
            self.stage, self.yes_supply_u64, self.yes_cover
        );
        assert_eq!(
            self.no_cover, self.no_supply_u64,
            "{} no mint supply {} != all token accounts {}",
            self.stage, self.no_supply_u64, self.no_cover
        );
        match self.market_status {
            MarketStatus::Open => {
                assert_eq!(
                    self.yes_supply_u64, self.no_supply_u64,
                    "{} open yes supply {} != no supply {}",
                    self.stage, self.yes_supply_u64, self.no_supply_u64
                );
                assert_eq!(
                    self.vault_u64, self.yes_supply_u64,
                    "{} open vault {} != complete-set supply {}",
                    self.stage, self.vault_u64, self.yes_supply_u64
                );
            }
            MarketStatus::Resolved => {
                assert!(
                    self.winner.is_some(),
                    "{} resolved market has no winner",
                    self.stage
                );
                assert_eq!(
                    self.vault_u64, self.liability_u64,
                    "{} resolved vault {} != winner supply {}",
                    self.stage, self.vault_u64, self.liability_u64
                );
            }
            MarketStatus::WindowBurn | MarketStatus::StaleBurn => {
                assert!(
                    self.vault_u64 >= self.liability_u64,
                    "{} void insolvent: vault {} < floor-liability {}",
                    self.stage, self.vault_u64, self.liability_u64
                );
            }
        }
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

fn liability(status: MarketStatus, winner: Option<MarketOutcome>, yes: u64, no: u64) -> u64 {
    match status {
        MarketStatus::Open => yes.max(no),
        MarketStatus::Resolved => match winner {
            Some(MarketOutcome::Yes) => yes,
            Some(MarketOutcome::No) => no,
            None => 0,
        },
        MarketStatus::WindowBurn | MarketStatus::StaleBurn => yes / 2 + no / 2,
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
        let vault_u64 = self.token_amount(keys.vault);
        let vault = vault_u64 as f64;
        let yes_supply_u64 = self.mint_supply(keys.yes_mint);
        let no_supply_u64 = self.mint_supply(keys.no_mint);
        let yes_supply = yes_supply_u64 as f64;
        let no_supply = no_supply_u64 as f64;
        let yes_cover = self.token_cover(keys.yes_mint);
        let no_cover = self.token_cover(keys.no_mint);
        let liability_u64 = liability(m.status, m.winner, yes_supply_u64, no_supply_u64);
        let solvency_err = (vault_u64 as i128 - liability_u64 as i128).unsigned_abs() as f64;
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
            market_status: m.status,
            winner: m.winner,
            yes_cover,
            no_cover,
            yes_supply_u64,
            no_supply_u64,
            vault_u64,
            liability_u64,
        };
        println!(
            "LEDGER {stage}: book=({:.6},{:.6}) pending=({:.6},{:.6}) phys=({:.0},{:.0}) err=({:.6},{:.6}) shares_err={:.6} vault={} supply=({},{}) liab={} solvency_err={:.6} band={:.6} status={}",
            l.book_yes, l.book_no, l.pending_yes, l.pending_no, l.phys_yes, l.phys_no, l.err_yes, l.err_no, l.share_err, l.vault_u64, l.yes_supply_u64, l.no_supply_u64, l.liability_u64, l.solvency_err, l.band, l.status
        );
        l
    }
}
