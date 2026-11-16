"""Protocol-level simulator. Fees and checkpoint rules come from the spec prompt.

Fee: each leg 30 / 10000.
In-leg fee accrues to the token sold into the pool.
Out-leg fee accrues to the token paid out of the pool.
Withdraw: pending and working, pro-rata by exit shares.
Second add: checkpoint is share-weighted average of old checkpoint and current cum.
"""
from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pm_amm_math as m  # noqa: E402

FEE_BPS = 30.0
FEE_DEN = 10000.0


def _fee(amount: float) -> float:
    return amount * FEE_BPS / FEE_DEN


@dataclass
class Position:
    shares: float = 0.0
    checkpoint_yes: float = 0.0
    checkpoint_no: float = 0.0


@dataclass
class Wallet:
    collateral: float = 0.0
    yes: float = 0.0
    no: float = 0.0
    lp: Position = field(default_factory=Position)


@dataclass
class Protocol:
    seed: float
    duration: float
    start_ts: float
    fee_bps: float = FEE_BPS
    now: float = 0.0
    end_ts: float = 0.0
    l_zero: float = 0.0
    reserve_yes: float = 0.0
    reserve_no: float = 0.0
    cum_yes: float = 0.0
    cum_no: float = 0.0
    total_shares: float = 0.0
    last_ts: float = 0.0
    phys_yes: float = 0.0
    phys_no: float = 0.0
    vault: float = 0.0
    yes_supply: float = 0.0
    no_supply: float = 0.0
    wallets: dict = field(default_factory=dict)
    last: dict = field(default_factory=dict)

    def wallet(self, name: str) -> Wallet:
        if name not in self.wallets:
            self.wallets[name] = Wallet()
        return self.wallets[name]

    def l_eff(self) -> float:
        rem = self.end_ts - self.now
        return m.l_effective(self.l_zero, rem)

    def price(self) -> float:
        return m.price_from_reserves(self.reserve_yes, self.reserve_no, self.l_eff())

    def accrue(self) -> dict:
        r = m.accrue(
            self.reserve_yes,
            self.reserve_no,
            self.l_zero,
            self.total_shares,
            self.cum_yes,
            self.cum_no,
            self.end_ts,
            self.last_ts,
            self.now,
        )
        self.reserve_yes = r["reserve_yes"]
        self.reserve_no = r["reserve_no"]
        self.cum_yes = r["cum_yes"]
        self.cum_no = r["cum_no"]
        self.last_ts = r["last_ts"]
        self.last = r
        return r

    def pending(self, name: str) -> tuple[float, float]:
        p = self.wallet(name).lp
        return (
            m.lp_pending(p.shares, p.checkpoint_yes, self.cum_yes),
            m.lp_pending(p.shares, p.checkpoint_no, self.cum_no),
        )

    def snapshot(self) -> dict:
        pending = {n: {"yes": self.pending(n)[0], "no": self.pending(n)[1]} for n in self.wallets}
        shares = {n: self.wallet(n).lp.shares for n in self.wallets}
        cps = {
            n: {
                "yes": self.wallet(n).lp.checkpoint_yes,
                "no": self.wallet(n).lp.checkpoint_no,
            }
            for n in self.wallets
        }
        users = {
            n: {"yes": w.yes, "no": w.no, "collateral": w.collateral}
            for n, w in self.wallets.items()
        }
        return {
            "reserve_yes": self.reserve_yes,
            "reserve_no": self.reserve_no,
            "cum_yes": self.cum_yes,
            "cum_no": self.cum_no,
            "l_zero": self.l_zero,
            "total_shares": self.total_shares,
            "phys_yes": self.phys_yes,
            "phys_no": self.phys_no,
            "vault": self.vault,
            "yes_supply": self.yes_supply,
            "no_supply": self.no_supply,
            "price": self.price() if self.reserve_yes + self.reserve_no > 0 and self.end_ts > self.now else None,
            "pending": pending,
            "shares": shares,
            "checkpoint": cps,
            "users": users,
            "released_yes": self.last.get("yes_released", 0.0),
            "released_no": self.last.get("no_released", 0.0),
        }

    def create(self) -> dict:
        self.now = self.start_ts
        self.end_ts = self.start_ts + self.duration
        self.last_ts = self.start_ts
        self.l_zero = m.suggest_l_zero_for_budget(self.seed, self.duration)
        le = m.l_effective(self.l_zero, self.duration)
        self.reserve_yes, self.reserve_no = m.reserves_from_price(0.5, le)
        self.cum_yes = 0.0
        self.cum_no = 0.0
        self.total_shares = self.seed
        self.phys_yes = self.seed
        self.phys_no = self.seed
        self.vault = self.seed
        self.yes_supply = self.seed
        self.no_supply = self.seed
        house = self.wallet("house")
        house.lp = Position(shares=self.seed, checkpoint_yes=0.0, checkpoint_no=0.0)
        house.collateral -= self.seed
        self.last = {"yes_released": 0.0, "no_released": 0.0}
        out = self.snapshot()
        out["output"] = 0.0
        return out

    def _credit_fees(self, in_token: str, out_token: str, in_fee: float, out_fee: float) -> None:
        per_in = in_fee / self.total_shares
        per_out = out_fee / self.total_shares
        if in_token == "yes":
            self.cum_yes += per_in
        else:
            self.cum_no += per_in
        if out_token == "yes":
            self.cum_yes += per_out
        else:
            self.cum_no += per_out

    def bet(self, wallet: str, amount: float, side: str) -> dict:
        self.accrue()
        w = self.wallet(wallet)
        w.collateral -= amount
        self.vault += amount
        w.yes += amount
        w.no += amount
        self.yes_supply += amount
        self.no_supply += amount
        in_fee = _fee(amount)
        net_in = amount - in_fee
        le = self.l_eff()
        if side == "yes":
            # sell NO into pool, take YES out
            w.no -= amount
            self.phys_no += amount
            sw = m.swap_no_to_yes(self.reserve_yes, self.reserve_no, le, net_in)
            out_fee = _fee(sw["output"])
            paid = math.floor(sw["output"] - out_fee)
            w.yes += paid
            self.phys_yes -= paid
            self.reserve_yes = sw["x_new"]
            self.reserve_no = sw["y_new"]
            self._credit_fees("no", "yes", in_fee, out_fee)
        else:
            w.yes -= amount
            self.phys_yes += amount
            sw = m.swap_yes_to_no(self.reserve_yes, self.reserve_no, le, net_in)
            out_fee = _fee(sw["output"])
            paid = math.floor(sw["output"] - out_fee)
            w.no += paid
            self.phys_no -= paid
            self.reserve_yes = sw["x_new"]
            self.reserve_no = sw["y_new"]
            self._credit_fees("yes", "no", in_fee, out_fee)
        snap = self.snapshot()
        snap["output"] = paid
        snap["in_fee"] = in_fee
        snap["out_fee"] = out_fee
        snap["gross_out"] = sw["output"]
        return snap

    def swap(self, wallet: str, amount: float, side: str) -> dict:
        """side is the token the user wants to receive."""
        self.accrue()
        w = self.wallet(wallet)
        in_fee = _fee(amount)
        net_in = amount - in_fee
        le = self.l_eff()
        if side == "yes":
            w.no -= amount
            self.phys_no += amount
            sw = m.swap_no_to_yes(self.reserve_yes, self.reserve_no, le, net_in)
            out_fee = _fee(sw["output"])
            paid = math.floor(sw["output"] - out_fee)
            w.yes += paid
            self.phys_yes -= paid
            self.reserve_yes = sw["x_new"]
            self.reserve_no = sw["y_new"]
            self._credit_fees("no", "yes", in_fee, out_fee)
        else:
            w.yes -= amount
            self.phys_yes += amount
            sw = m.swap_yes_to_no(self.reserve_yes, self.reserve_no, le, net_in)
            out_fee = _fee(sw["output"])
            paid = math.floor(sw["output"] - out_fee)
            w.no += paid
            self.phys_no -= paid
            self.reserve_yes = sw["x_new"]
            self.reserve_no = sw["y_new"]
            self._credit_fees("yes", "no", in_fee, out_fee)
        snap = self.snapshot()
        snap["output"] = paid
        snap["in_fee"] = in_fee
        snap["out_fee"] = out_fee
        snap["gross_out"] = sw["output"]
        return snap

    def add_liquidity(self, wallet: str, amount: float) -> dict:
        self.accrue()
        w = self.wallet(wallet)
        w.collateral -= amount
        self.vault += amount
        w.yes += amount
        w.no += amount
        self.yes_supply += amount
        self.no_supply += amount
        ry, rn = self.reserve_yes, self.reserve_no
        max_r = max(ry, rn)
        yes_in = amount if ry > rn else math.floor(amount * ry / rn)
        no_in = amount if ry < rn else math.floor(amount * rn / ry)
        w.yes -= yes_in
        w.no -= no_in
        self.phys_yes += yes_in
        self.phys_no += no_in
        add_shares = self.total_shares * amount / max_r
        old_shares = w.lp.shares
        new_shares = old_shares + add_shares
        if old_shares <= 0:
            w.lp.checkpoint_yes = self.cum_yes
            w.lp.checkpoint_no = self.cum_no
        else:
            w.lp.checkpoint_yes = (old_shares * w.lp.checkpoint_yes + add_shares * self.cum_yes) / new_shares
            w.lp.checkpoint_no = (old_shares * w.lp.checkpoint_no + add_shares * self.cum_no) / new_shares
        w.lp.shares = new_shares
        scale = amount / max_r
        self.l_zero += self.l_zero * scale
        self.reserve_yes += self.reserve_yes * scale
        self.reserve_no += self.reserve_no * scale
        self.total_shares += add_shares
        snap = self.snapshot()
        snap["output"] = add_shares
        snap["add_shares"] = add_shares
        snap["old_shares"] = old_shares
        return snap

    def withdraw(self, wallet: str, shares_req: float) -> dict:
        self.accrue()
        w = self.wallet(wallet)
        old = w.lp.shares
        if shares_req <= 0:
            raise ValueError("ZeroLp")
        shares_in = old if shares_req >= old else shares_req
        py, pn = self.pending(wallet)
        pay_yes = math.floor(py * shares_in / old + self.reserve_yes * shares_in / self.total_shares)
        pay_no = math.floor(pn * shares_in / old + self.reserve_no * shares_in / self.total_shares)
        remain_frac = (self.total_shares - shares_in) / self.total_shares
        self.l_zero *= remain_frac
        self.reserve_yes *= remain_frac
        self.reserve_no *= remain_frac
        self.total_shares -= shares_in
        w.lp.shares = old - shares_in
        if math.isclose(shares_in, old, rel_tol=0.0, abs_tol=1e-18) or w.lp.shares <= 0:
            w.lp.shares = 0.0
            w.lp.checkpoint_yes = self.cum_yes
            w.lp.checkpoint_no = self.cum_no
        w.yes += pay_yes
        w.no += pay_no
        self.phys_yes -= pay_yes
        self.phys_no -= pay_no
        snap = self.snapshot()
        snap["output"] = pay_yes
        snap["pay_yes"] = pay_yes
        snap["pay_no"] = pay_no
        snap["shares_in"] = shares_in
        return snap

    def merge(self, wallet: str, amount: float) -> dict:
        w = self.wallet(wallet)
        w.yes -= amount
        w.no -= amount
        self.yes_supply -= amount
        self.no_supply -= amount
        self.vault -= amount
        w.collateral += amount
        self.last = {"yes_released": 0.0, "no_released": 0.0}
        snap = self.snapshot()
        snap["output"] = amount
        return snap

    def warp(self, ts: float) -> dict:
        self.now = ts
        self.last = {"yes_released": 0.0, "no_released": 0.0}
        snap = self.snapshot()
        snap["output"] = 0.0
        return snap


def run(req: dict) -> dict:
    p = Protocol(seed=float(req["seed"]), duration=float(req["duration"]), start_ts=float(req["start_ts"]))
    steps = []
    for op in req["ops"]:
        kind = op["op"]
        if kind == "create":
            step = p.create()
        elif kind == "warp":
            step = p.warp(float(op["ts"]))
        elif kind == "accrue":
            p.accrue()
            step = p.snapshot()
            step["output"] = 0.0
        elif kind == "bet":
            step = p.bet(op["wallet"], float(op["amount"]), op["side"])
        elif kind == "swap":
            step = p.swap(op["wallet"], float(op["amount"]), op["side"])
        elif kind == "add_liquidity":
            step = p.add_liquidity(op["wallet"], float(op["amount"]))
        elif kind == "withdraw":
            step = p.withdraw(op["wallet"], float(op["shares"]))
        elif kind == "merge":
            step = p.merge(op["wallet"], float(op["amount"]))
        else:
            raise ValueError(kind)
        step["op"] = kind
        steps.append(step)
    return {"steps": steps, "final": p.snapshot()}


def plan_deep_skew(req: dict) -> dict:
    seed = float(req.get("seed", 10_000_000))
    duration = float(req.get("duration", 7 * 86400))
    start_ts = float(req.get("start_ts", 1_700_000_000))
    bet = float(req.get("bet", 250_000))
    p = Protocol(seed=seed, duration=duration, start_ts=start_ts)
    ops = [{"op": "create"}]
    p.create()
    n = 0
    while p.price() < 0.99 and n < 400:
        p.bet("trader", bet, "yes")
        ops.append({"op": "bet", "wallet": "trader", "amount": bet, "side": "yes"})
        n += 1
    if p.price() < 0.99:
        raise RuntimeError(f"deep_skew failed to reach 0.99, price={p.price()} n={n}")
    # interleave swap and accrue
    swap_amt = min(20_000.0, p.wallet("trader").yes * 0.05, max(p.reserve_yes * 0.05, 1.0))
    if swap_amt > 1:
        p.swap("trader", swap_amt, "no")
        ops.append({"op": "swap", "wallet": "trader", "amount": swap_amt, "side": "no"})
    mid = start_ts + duration * 0.2
    p.warp(mid)
    ops.append({"op": "warp", "ts": mid})
    p.withdraw("house", 1.0)
    ops.append({"op": "withdraw", "wallet": "house", "shares": 1})
    if p.wallet("trader").no > 1:
        amt = min(10_000.0, p.wallet("trader").no * 0.5)
        p.swap("trader", amt, "yes")
        ops.append({"op": "swap", "wallet": "trader", "amount": amt, "side": "yes"})
    out = run({"seed": seed, "duration": duration, "start_ts": start_ts, "ops": ops})
    out["ops"] = ops
    return out


def write_vectors(path: Path) -> None:
    vec = {
        "note": "Generated from oracle/pm_amm_math.py (paper formulas). Not copied from Rust.",
        "phi0": m.INV_SQRT_2PI,
        "phi": {"0": m.phi(0.0), "1": m.phi(1.0), "-1": m.phi(-1.0)},
        "capital_phi": {"0": m.capital_phi(0.0), "1": m.capital_phi(1.0)},
        "capital_phi_inv": {"0.5": m.capital_phi_inv(0.5), "0.3": m.capital_phi_inv(0.3)},
        "reserves": {
            "l_eff_1000_p05": list(m.reserves_from_price(0.5, 1000.0)),
            "l_eff_1000_p03": list(m.reserves_from_price(0.3, 1000.0)),
        },
        "suggest_l_zero": {
            "budget_1e6_day": m.suggest_l_zero_for_budget(1_000_000.0, 86400.0)
        },
    }
    path.write_text(json.dumps(vec, indent=2), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--vectors":
        write_vectors(Path(__file__).with_name("test_vectors.json"))
        print("wrote test_vectors.json")
        raise SystemExit(0)
    req = json.load(sys.stdin)
    if req.get("plan") == "deep_skew":
        json.dump(plan_deep_skew(req), sys.stdout)
    else:
        json.dump(run(req), sys.stdout)
    sys.stdout.write("\n")


