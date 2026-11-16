"""Independent pm-AMM reference (Paradigm, Moallemi & Robinson 2024).

This file was not present in the Veritas checkout. The on-chain math crate
comments point at oracle/pm_amm_math.py (scipy) and the port note names
Mattdgn/pm-amm. Expected values in the spec tests come from THIS module and
from the prompt, never from on-chain outputs.

Formulas:
  phi(z)  = 1/sqrt(2 pi) * exp(-z^2 / 2)
  Phi(z)  = 1/2 * (1 + erf(z / sqrt(2)))
  L_eff   = L_0 * sqrt(T - t)
  x*(P)   = L_eff * (Phi_inv(P)*P + phi(Phi_inv(P)) - Phi_inv(P))
  y*(P)   = L_eff * (Phi_inv(P)*P + phi(Phi_inv(P)))
  P       = Phi((y - x) / L_eff)
  V(P)    = L_eff * phi(Phi_inv(P))
  L_0     = budget / (phi(0) * sqrt(T))
  YES->NO: x' = x + delta, y' from invariant, out = y - y'
  NO->YES: y' = y + delta, x' from invariant, out = x - x'
  Accrual: hold P, scale reserves with L_eff; at expiry release all working.
"""
from __future__ import annotations

import math

INV_SQRT_2PI = 1.0 / math.sqrt(2.0 * math.pi)
SQRT_2 = math.sqrt(2.0)
PRICE_LO = 1e-4
PRICE_HI = 1.0 - 1e-4


def _ndtri_acklam(p: float) -> float:
    """Peter J. Acklam's inverse normal CDF, independent of the on-chain LUT."""
    if p <= 0.0:
        return float("-inf")
    if p >= 1.0:
        return float("inf")
    a = [
        -3.969683028665376e01,
        2.209460984245205e02,
        -2.759285104469687e02,
        1.383577509590705e02,
        -3.066479806614716e01,
        2.506628277459239e00,
    ]
    b = [
        -5.447609879822406e01,
        1.615858368580409e02,
        -1.556989798598866e02,
        6.680131188771972e01,
        -1.328068155288572e01,
    ]
    c = [
        -7.784894002430293e-03,
        -3.223964580411365e-01,
        -2.400758277161838e00,
        -2.549732539343734e00,
        4.374664141464858e00,
        2.938163982698783e00,
    ]
    d = [
        7.784695709041462e-03,
        3.224671290700398e-01,
        2.445134137142996e00,
        3.754408661907416e00,
    ]
    plow = 0.02425
    phigh = 1.0 - plow
    if p < plow:
        q = math.sqrt(-2.0 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
        )
    if p > phigh:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
        )
    q = p - 0.5
    r = q * q
    return (
        (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5])
        * q
        / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
    )


def phi(z: float) -> float:
    return INV_SQRT_2PI * math.exp(-0.5 * z * z)


def capital_phi(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / SQRT_2))


def capital_phi_inv(p: float) -> float:
    p = min(max(float(p), PRICE_LO), PRICE_HI)
    try:
        from scipy.special import ndtri  # type: ignore

        return float(ndtri(p))
    except Exception:
        return _ndtri_acklam(p)


def l_effective(l_zero: float, time_remaining_secs: float) -> float:
    if time_remaining_secs <= 0:
        raise ValueError("InvalidDuration")
    return l_zero * math.sqrt(time_remaining_secs)


def reserves_from_price(price: float, l_eff: float) -> tuple[float, float]:
    u = capital_phi_inv(price)
    phi_u = phi(u)
    x = l_eff * (u * price + phi_u - u)
    y = l_eff * (u * price + phi_u)
    return x, y


def price_from_reserves(x: float, y: float, l_eff: float) -> float:
    if l_eff <= 0:
        raise ValueError("InvalidLiquidity")
    return capital_phi((y - x) / l_eff)


def pool_value(price: float, l_eff: float) -> float:
    return l_eff * phi(capital_phi_inv(price))


def suggest_l_zero_for_budget(budget: float, duration_secs: float) -> float:
    if budget <= 0:
        raise ValueError("InvalidBudget")
    if duration_secs <= 0:
        raise ValueError("InvalidDuration")
    return budget / (INV_SQRT_2PI * math.sqrt(duration_secs))


def _g_y(u: float) -> float:
    return u * capital_phi(u) + phi(u)


def _g_x(u: float) -> float:
    return u * capital_phi(u) + phi(u) - u


def _solve_u(target: float, g, lo: float = -8.0, hi: float = 8.0) -> float:
    glo = g(lo)
    ghi = g(hi)
    increasing = ghi >= glo
    if increasing:
        if target <= glo:
            return lo
        if target >= ghi:
            return hi
        for _ in range(96):
            mid = 0.5 * (lo + hi)
            if g(mid) < target:
                lo = mid
            else:
                hi = mid
    else:
        if target >= glo:
            return lo
        if target <= ghi:
            return hi
        for _ in range(96):
            mid = 0.5 * (lo + hi)
            if g(mid) > target:
                lo = mid
            else:
                hi = mid
    return 0.5 * (lo + hi)


def find_x_from_y(y: float, l_eff: float) -> float:
    u = _solve_u(y / l_eff, _g_y)
    return y - u * l_eff


def find_y_from_x(x: float, l_eff: float) -> float:
    u = _solve_u(x / l_eff, _g_x)
    return x + u * l_eff


def swap_no_to_yes(x: float, y: float, l_eff: float, delta: float) -> dict:
    yn = y + delta
    xn = find_x_from_y(yn, l_eff)
    out = x - xn
    return {"output": out, "x_new": xn, "y_new": yn, "price_new": price_from_reserves(xn, yn, l_eff)}


def swap_yes_to_no(x: float, y: float, l_eff: float, delta: float) -> dict:
    xn = x + delta
    yn = find_y_from_x(xn, l_eff)
    out = y - yn
    return {"output": out, "x_new": xn, "y_new": yn, "price_new": price_from_reserves(xn, yn, l_eff)}


def accrue(
    reserve_yes: float,
    reserve_no: float,
    l_zero: float,
    total_shares: float,
    cum_yes: float,
    cum_no: float,
    end_ts: float,
    last_ts: float,
    now: float,
) -> dict:
    if total_shares <= 0 or l_zero <= 0:
        return {
            "noop": True,
            "yes_released": 0.0,
            "no_released": 0.0,
            "reserve_yes": reserve_yes,
            "reserve_no": reserve_no,
            "cum_yes": cum_yes,
            "cum_no": cum_no,
            "last_ts": last_ts,
        }
    clamped = min(now, end_ts)
    dt = clamped - last_ts
    if dt <= 0:
        return {
            "noop": True,
            "yes_released": 0.0,
            "no_released": 0.0,
            "reserve_yes": reserve_yes,
            "reserve_no": reserve_no,
            "cum_yes": cum_yes,
            "cum_no": cum_no,
            "last_ts": last_ts,
        }
    t_rem_new = end_ts - clamped
    if t_rem_new <= 0:
        return {
            "noop": False,
            "yes_released": reserve_yes,
            "no_released": reserve_no,
            "reserve_yes": 0.0,
            "reserve_no": 0.0,
            "cum_yes": cum_yes + reserve_yes / total_shares,
            "cum_no": cum_no + reserve_no / total_shares,
            "last_ts": clamped,
        }
    t_rem_old = end_ts - last_ts
    l_old = l_effective(l_zero, t_rem_old)
    l_new = l_effective(l_zero, t_rem_new)
    raw_p = price_from_reserves(reserve_yes, reserve_no, l_old)
    price = min(max(raw_p, PRICE_LO), PRICE_HI)
    x_new, y_new = reserves_from_price(price, l_new)
    yes_released = max(reserve_yes - x_new, 0.0)
    no_released = max(reserve_no - y_new, 0.0)
    return {
        "noop": False,
        "yes_released": yes_released,
        "no_released": no_released,
        "reserve_yes": x_new,
        "reserve_no": y_new,
        "cum_yes": cum_yes + yes_released / total_shares,
        "cum_no": cum_no + no_released / total_shares,
        "last_ts": clamped,
    }


def lp_pending(shares: float, checkpoint: float, cum: float) -> float:
    if shares <= 0:
        return 0.0
    return max((cum - checkpoint) * shares, 0.0)


def self_check() -> None:
    x, y = reserves_from_price(0.5, 1000.0)
    expect = 1000.0 * INV_SQRT_2PI
    assert abs(x - expect) < 1e-9, x
    assert abs(y - expect) < 1e-9, y
    assert abs(capital_phi(0.0) - 0.5) < 1e-12
    assert abs(capital_phi_inv(0.5)) < 1e-10
    l0 = suggest_l_zero_for_budget(1_000_000.0, 86_400.0)
    le = l_effective(l0, 86_400.0)
    rx, ry = reserves_from_price(0.5, le)
    assert abs(rx - 1_000_000.0) < 1e-4, rx
    assert abs(ry - 1_000_000.0) < 1e-4, ry
    sw = swap_yes_to_no(rx, ry, le, 10_000.0)
    assert sw["output"] > 0.0, sw
    assert sw["y_new"] > 0.0, sw
    assert abs(sw["x_new"] - (rx + 10_000.0)) < 1e-6, sw
    back = swap_no_to_yes(sw["x_new"], sw["y_new"], le, sw["output"])
    assert abs(back["x_new"] - rx) < 2.0, back


self_check()
