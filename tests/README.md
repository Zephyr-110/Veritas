# Test layout

Run with `anchor test`. Mocha only picks up `tests/**/*.spec.ts`.

```
tests/
  helpers/            reusable tools, no it()
    env.ts            connect to local chain, get program
    pdas.ts           derive market PDAs
    tokens.ts         mint collateral, ATAs, balances
    quote.ts          expected output from the on-chain formula
    users.ts          house / LP / trader
    make_market.ts    funded, tradable market
    send_ix.ts        send transactions, no asserts
    wait.ts           wait for on-chain time
    assert_tx.ts      assert a tx fails as expected
  *.spec.ts           one spec per instruction
  void_market.spec.ts void: oracle in-window / anyone after
  full_round.spec.ts  create through redeem
```

When adding an instruction test: add a sender in `send_ix.ts`, then add `instruction_name.spec.ts`.
Default oracle is the creator (same key co-signs). Role splits, missing signatures, post-window void, and half-price redeem live in the matching spec.