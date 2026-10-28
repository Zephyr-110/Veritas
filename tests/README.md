# 测试怎么分层

跑法：`anchor test`。mocha 只收集 `tests/**/*.spec.ts`。

```
tests/
  helpers/           可复用工具，不写 it()
    env.ts           连上本地链，拿到 program
    pdas.ts          推盘口相关地址
    tokens.ts        造抵押物、开 ATA、读余额
    quote.ts         按合约公式算出预期兑出量
    users.ts         庄家 / 做市商 / 玩家
    make_market.ts   建一个已经注资的可交易盘口
    send_ix.ts       只负责发交易，不做断言
    wait.ts          等链上时间
    assert_tx.ts     断言某笔交易按预期失败
  *.spec.ts          一条指令一份用例
  void_market.spec.ts 作废：窗内 oracle / 窗后任何人
  full_round.spec.ts 建盘到兑奖走一遍
```

新加指令测试时：先在 `send_ix.ts` 加发送函数，再加一份 `指令名.spec.ts`。
建盘默认 oracle = 开盘人（同一把钥匙副署）。分角色、缺签名、窗后作废、半价兑写在对应 spec 里。
