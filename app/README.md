# Veritas

Binary event markets on Solana. The UI talks to the program through an RPC node; there is no HTTP backend.

Live Devnet program: `CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER`

## Run

```bash
cd app
npm install
npm run dev
```

Open http://localhost:3000

1. Phantom: Settings → Developer Mode → network **Devnet**.
2. Header should show `devnet`. If it still says `localnet`, open Settings → Reset → Save, then restart `npm run dev`.
3. The list is empty until you create a market.
4. The wallet that creates a market becomes both LP and oracle. **That wallet cannot trade.** Use a second Devnet account to buy Yes / No.
5. The creator needs collateral tokens. Airdrop from the CLI wallet:

```bash
cd /mnt/c/Users/30149/prediction_market
bash scripts/airdrop-meme.sh
```

Default recipient `2XTPuFTtsDZbCSks6c6fnxa8pzFcBUdwMZK8ds7kmqU7`: 100,000 tokens + 0.5 SOL.
Mint: `CtiAxpKmXtK2bupa59GN6GPYXQiPPYUfSqnY1pgMD7QG`. Import it in Phantom if it does not show up.

Suggested walkthrough: wallet A creates a market (expiry 2–5 minutes) → wallet B buys Yes → after expiry wallet A resolves → wallet B redeems.

## Localnet

Terminal 1, repo root:

```bash
solana-test-validator
```

Terminal 2:

```bash
solana config set --url http://127.0.0.1:8899
anchor deploy
```

Phantom: Developer Mode → add RPC `http://127.0.0.1:8899`. Fund two accounts:

```bash
node app/scripts/seed-local.js <walletA> <walletB>
```

The script prints a mint. Put that mint in Settings. Validator resets wipe the mint; run the script again.

## Notes

- Cannot reach the node: validator is down, or Phantom / Settings RPC is not `8899` on localnet.
- Create fails with missing mint: Settings collateral mint is wrong.
- Create fails with insufficient balance: wallet A was not funded.
- Can create but cannot trade: you are still on the oracle wallet.
- Transaction lands but the page does not update: wait for `confirmed`, or refresh.

Rebuild the IDL only after program instruction changes: `cd app && npm run copy-idl`.
