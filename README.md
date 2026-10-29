# Veritas Markets

> **A decentralized, non-custodial binary prediction market protocol built natively on Solana using the Anchor framework.**

[![Solana Devnet](https://img.shields.io/badge/Solana-Devnet-14F195?style=flat-square&logo=solana&logoColor=white)](https://explorer.solana.com/address/CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER?cluster=devnet)
[![Anchor Framework](https://img.shields.io/badge/Anchor-0.30+-5C6BC0?style=flat-square)](https://www.anchor-lang.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)

Veritas Markets delivers on-chain binary prediction capabilities without reliance on centralized off-chain order books or indexer databases. Market states, continuous liquidity pools, and conditional tokens are managed directly through Anchor programs and Program Derived Addresses (PDAs).

---

## 🏛️ Deployments

| Component | Network | On-Chain Address / Location |
| :--- | :--- | :--- |
| **Core Program** | Solana Devnet | [`CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER`](https://explorer.solana.com/address/CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER?cluster=devnet) |
| **Collateral Mint** | Solana Devnet | [`CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG`](https://explorer.solana.com/address/CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG?cluster=devnet) |
| **Frontend Client** | Local / Hosted | `app/` (Next.js 14, Tailwind CSS, `@solana/wallet-adapter`) |

---

## 📐 Mathematical Model & Mechanism Design

### 1. Constant-Product AMM Pricing
The pool maintains liquidity for complementary outcome tokens ($R_{\text{yes}}$ and $R_{\text{no}}$) based on the invariant:

$$R_{\text{yes}} \cdot R_{\text{no}} = k$$

When a participant executes `user_bet_on`:
1. The specified amount of collateral is locked into the PDA vault, minting an equal quantity of YES and NO tokens.
2. The counter-outcome tokens are automatically routed through the AMM pool via a swap operation, leaving the trader with a directional position.
3. Implied probabilities (spot prices) update dynamically:
   $$P(\text{Yes}) = \frac{R_{\text{no}}}{R_{\text{yes}} + R_{\text{no}}}, \quad P(\text{No}) = \frac{R_{\text{yes}}}{R_{\text{yes}} + R_{\text{no}}}$$

* **Protocol Fee**: 30 bps (0.30%) applied to the swap input reserve, compounding directly within the pool.

### 2. Collateral Parity Merge
At any point prior to market expiry, participants holding matching pairs can call `merge_token`:
$$1 \text{ YES} + 1 \text{ NO} \longrightarrow 1 \text{ Collateral}$$
This allows liquidity providers or arbitrageurs to exit risk without waiting for final oracle settlement.

---

## 🔒 Security Architecture & State Machine

           ┌─────────── create_market ───────────┐
           │                                     │
           ▼                                     ▼
    [ Open / Trading ]                    [ Dual-Signature ]
           │                          Creator & Oracle Co-sign
           │  (market_expiry)
           ▼
[ Resolution Window ] ── (100,000s)
│               │
resolve_market    void_market (Oracle or Timeout)
│               │
▼               ▼
[ Resolved ]     [ Voided / Burn ]
1:1 Payout        2:1 Refund


* **Co-Signing Requirement**: `create_market` requires cryptographic signatures from both the `creator` and the designated `oracle`.
* **Oracle Separation Invariant**: To eliminate insider frontrunning and outcome manipulation, the oracle public key is **strictly prevented by on-chain constraints** from executing bets, swaps, or liquidity actions within that specific market.
* **Timeout Void Protection**: If the oracle becomes unresponsive after the 100,000-second (~27.8 hours) settlement window, `void_market` becomes **permissionless**. Any account can trigger it, ensuring zero locked funds.

---

## ⚙️ Instruction Matrix

| Instruction | Signers | Primary Action |
| :--- | :--- | :--- |
| `create_market` | `Creator`, `Oracle` | Initializes the market state account, establishes token vaults, and deposits initial liquidity. |
| `user_bet_on` | `User` | Deposits collateral, mints pairs, and swaps out the opposite token to establish a directional bet. |
| `swap` | `User` | Swaps YES tokens for NO tokens (or vice versa) against the AMM pool. |
| `add_liquidity` | `User` | Injects balanced outcome reserves to mint proportional LP tokens. |
| `get_liquidity` | `User` | Burns LP tokens to redeem underlying YES and NO reserves. |
| `merge_token` | `User` | Burns matched pairs ($1 \text{ YES} + 1 \text{ NO}$) to reclaim escrowed collateral. |
| `resolve_market` | `Oracle` | Finalizes the winning outcome within the resolution window. |
| `void_market` | `Oracle` or `Anyone` | Voids the market (Oracle restricted within window; public access post-timeout). |
| `get_collateral` | `User` | Redeems outcome tokens for collateral (1:1 for winners, 2:1 for voided refunds). |

---

## 🧪 Testing & Verification

The protocol includes comprehensive lifecycle integration testing covering program deployment, PDA resolution, error constraints, and full settlement rounds.

```bash
# Build the program binaries and update the IDL
anchor build

# Execute localnet test suite (including full_round lifecycle)
anchor test
Key Test Coverage:
Account Constraint Validation: Verifying unauthorized accounts cannot resolve markets.

Oracle Isolation: Confirming the oracle address is rejected when attempting user_bet_on.

Resolution & Void Edge Cases: Testing 1:1 payout math, 2:1 void redemption, and window timeout boundaries.

🚀 Running the Client
The client connects directly to Solana RPC endpoints without intermediary servers.

Bash
# Navigate to the client directory
cd app

# Install dependencies
pnpm install

# Configure environment variables
cp .env.example .env.local

# Start development server
pnpm dev
Point your Phantom or Solflare wallet to Solana Devnet. Ensure your active wallet holds Devnet SOL and the designated collateral mint for initialization and betting interactions.