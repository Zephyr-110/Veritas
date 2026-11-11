const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function disc(prefix, name) {
  return Array.from(crypto.createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8));
}
function seed(text) {
  return { kind: "const", value: Array.from(Buffer.from(text)) };
}
function accPath(p, account) {
  return account ? { kind: "account", path: p, account } : { kind: "account", path: p };
}
function argPath(p) {
  return { kind: "arg", path: p };
}
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const ATA_PROG = {
  kind: "const",
  value: [140,151,37,143,78,36,137,241,187,61,16,41,20,142,13,131,11,90,19,153,218,255,16,132,4,142,123,216,219,233,248,89],
};
function pda(seeds, program) {
  const out = { seeds };
  if (program) out.program = program;
  return { pda: out };
}
function ataPda(ownerPath, mintPath, tokenProgramPath = "token_program") {
  return pda([accPath(ownerPath), accPath(tokenProgramPath), accPath(mintPath)], ATA_PROG);
}
function marketPdaFromId() {
  return pda([seed("market"), accPath("market.id", "Market")]);
}
function marketPdaFromArg() {
  return pda([seed("market"), argPath("param.market_id")]);
}

const idl = {
  address: "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER",
  metadata: {
    name: "prediction_market",
    version: "0.1.0",
    spec: "0.1.0",
    description: "Created with Anchor",
  },
  instructions: [
    {
      name: "add_liquidity",
      discriminator: disc("global", "add_liquidity"),
      accounts: [
        { name: "signer", writable: true, signer: true },
        { name: "market", writable: true, ...marketPdaFromId() },
        { name: "lp_position", writable: true, ...pda([seed("lp_position"), accPath("market"), accPath("signer")]) },
        { name: "collateral_mint" },
        { name: "yes_mint", writable: true, ...pda([seed("yes_mint"), accPath("market")]) },
        { name: "no_mint", writable: true, ...pda([seed("no_mint"), accPath("market")]) },
        { name: "businessman_yes_ata", writable: true, ...ataPda("signer", "yes_mint") },
        { name: "businessman_no_ata", writable: true, ...ataPda("signer", "no_mint") },
        { name: "collateral_vault", writable: true, ...pda([seed("collateral_vault"), accPath("market")]) },
        { name: "businessman_collateral_ata", writable: true, ...ataPda("signer", "collateral_mint") },
        { name: "yes_pool", writable: true, ...pda([seed("yes_pool"), accPath("market")]) },
        { name: "no_pool", writable: true, ...pda([seed("no_pool"), accPath("market")]) },
        { name: "associated_token_program" },
        { name: "clock", address: CLOCK },
        { name: "token_program" },
        { name: "system_program" },
      ],
      args: [{ name: "collateral_amount", type: "u64" }],
    },
    {
      name: "create_market",
      discriminator: disc("global", "create_market"),
      accounts: [
        { name: "creator", writable: true, signer: true },
        { name: "market", writable: true, ...marketPdaFromArg() },
        { name: "lp_position", writable: true, ...pda([seed("lp_position"), accPath("market"), accPath("creator")]) },
        { name: "collateral_mint" },
        { name: "yes_mint", writable: true, ...pda([seed("yes_mint"), accPath("market")]) },
        { name: "no_mint", writable: true, ...pda([seed("no_mint"), accPath("market")]) },
        { name: "collateral_vault", writable: true, ...pda([seed("collateral_vault"), accPath("market")]) },
        { name: "creator_collateral_ata", writable: true, ...ataPda("creator", "collateral_mint") },
        { name: "yes_pool", writable: true, ...pda([seed("yes_pool"), accPath("market")]) },
        { name: "no_pool", writable: true, ...pda([seed("no_pool"), accPath("market")]) },
        { name: "clock", address: CLOCK },
        { name: "associated_token_program" },
        { name: "token_program" },
        { name: "system_program" },
      ],
      args: [{ name: "param", type: { defined: { name: "CreateMarketParams" } } }],
    },
    {
      name: "get_collateral",
      discriminator: disc("global", "get_collateral"),
      accounts: [
        { name: "signer", writable: true, signer: true },
        { name: "market", ...marketPdaFromId() },
        { name: "token_mint", writable: true },
        { name: "token_ata", writable: true, ...ataPda("signer", "token_mint") },
        { name: "collateral_mint" },
        { name: "collateral_vault", writable: true, ...pda([seed("collateral_vault"), accPath("market")]) },
        { name: "user_collateral_ata", writable: true, ...ataPda("signer", "collateral_mint") },
        { name: "token_program" },
      ],
      args: [{ name: "amount", type: "u64" }],
    },
    {
      name: "get_liquidity",
      discriminator: disc("global", "get_liquidity"),
      accounts: [
        { name: "signer", writable: true, signer: true },
        { name: "market", writable: true, ...marketPdaFromId() },
        { name: "lp_position", writable: true, ...pda([seed("lp_position"), accPath("market"), accPath("signer")]) },
        { name: "yes_mint", ...pda([seed("yes_mint"), accPath("market")]) },
        { name: "no_mint", ...pda([seed("no_mint"), accPath("market")]) },
        { name: "businessman_yes_ata", writable: true, ...ataPda("signer", "yes_mint") },
        { name: "businessman_no_ata", writable: true, ...ataPda("signer", "no_mint") },
        { name: "yes_pool", writable: true, ...pda([seed("yes_pool"), accPath("market")]) },
        { name: "no_pool", writable: true, ...pda([seed("no_pool"), accPath("market")]) },
        { name: "clock", address: CLOCK },
        { name: "associated_token_program" },
        { name: "token_program" },
        { name: "system_program" },
      ],
      args: [{ name: "lp_share", type: "u64" }],
    },
    {
      name: "merge_token",
      discriminator: disc("global", "merge_token"),
      accounts: [
        { name: "signer", writable: true, signer: true },
        { name: "market", ...marketPdaFromId() },
        { name: "collateral_ata", writable: true },
        { name: "collateral_mint" },
        { name: "collateral_vault", writable: true, ...pda([seed("collateral_vault"), accPath("market")]) },
        { name: "yes_mint", writable: true, ...pda([seed("yes_mint"), accPath("market")]) },
        { name: "no_mint", writable: true, ...pda([seed("no_mint"), accPath("market")]) },
        { name: "yes_token_ata", writable: true, ...ataPda("signer", "yes_mint") },
        { name: "no_token_ata", writable: true, ...ataPda("signer", "no_mint") },
        { name: "token_program" },
      ],
      args: [{ name: "merge_amount", type: "u64" }],
    },
    {
      name: "resolve_market",
      discriminator: disc("global", "resolve_market"),
      accounts: [
        { name: "signer", writable: true, signer: true },
        { name: "market", writable: true, ...marketPdaFromId() },
        { name: "price_update" },
        { name: "clock", address: CLOCK },
      ],
      args: [],
    },
    {
      name: "swap",
      discriminator: disc("global", "swap"),
      accounts: [
        { name: "signer", writable: true, signer: true },
        { name: "market", writable: true, ...marketPdaFromId() },
        { name: "yes_mint", ...pda([seed("yes_mint"), accPath("market")]) },
        { name: "no_mint", ...pda([seed("no_mint"), accPath("market")]) },
        { name: "yes_token_ata", writable: true, ...ataPda("signer", "yes_mint") },
        { name: "no_token_ata", writable: true, ...ataPda("signer", "no_mint") },
        { name: "yes_pool", writable: true, ...pda([seed("yes_pool"), accPath("market")]) },
        { name: "no_pool", writable: true, ...pda([seed("no_pool"), accPath("market")]) },
        { name: "clock", address: CLOCK },
        { name: "token_program" },
      ],
      args: [{ name: "param", type: { defined: { name: "SwapParams" } } }],
    },
    {
      name: "user_bet_on",
      discriminator: disc("global", "user_bet_on"),
      accounts: [
        { name: "signer", writable: true, signer: true },
        { name: "market", writable: true, ...marketPdaFromId() },
        { name: "collateral_ata", writable: true },
        { name: "collateral_mint" },
        { name: "collateral_vault", writable: true, ...pda([seed("collateral_vault"), accPath("market")]) },
        { name: "yes_mint", writable: true, ...pda([seed("yes_mint"), accPath("market")]) },
        { name: "no_mint", writable: true, ...pda([seed("no_mint"), accPath("market")]) },
        { name: "yes_token_ata", writable: true, ...ataPda("signer", "yes_mint") },
        { name: "no_token_ata", writable: true, ...ataPda("signer", "no_mint") },
        { name: "yes_pool", writable: true, ...pda([seed("yes_pool"), accPath("market")]) },
        { name: "no_pool", writable: true, ...pda([seed("no_pool"), accPath("market")]) },
        { name: "clock", address: CLOCK },
        { name: "associated_token_program" },
        { name: "token_program" },
        { name: "system_program" },
      ],
      args: [{ name: "param", type: { defined: { name: "UserBetOnParams" } } }],
    },
    {
      name: "void_market",
      discriminator: disc("global", "void_market"),
      accounts: [
        { name: "signer", writable: true, signer: true },
        { name: "market", writable: true, ...marketPdaFromId() },
        { name: "clock", address: CLOCK },
      ],
      args: [],
    },
  ],
  accounts: [
    { name: "LpPosition", discriminator: disc("account", "LpPosition") },
    { name: "Market", discriminator: disc("account", "Market") },
  ],
  errors: [
    { code: 6000, name: "MarketNotOpen", msg: "Market is not open." },
    { code: 6001, name: "MarketNotResolved", msg: "Market is not resolved or voided." },
    { code: 6002, name: "MarketNotTradable", msg: "Market must be open, resolved, or voided." },
    { code: 6003, name: "MarketExpired", msg: "Market has expired." },
    { code: 6004, name: "MarketNotExpired", msg: "Market is outside the settlement window." },
    { code: 6005, name: "InvalidAmount", msg: "Amount or expiry is invalid." },
    { code: 6006, name: "InsufficientBalance", msg: "Insufficient token balance." },
    { code: 6007, name: "EmptyPool", msg: "Pool reserves are empty." },
    { code: 6008, name: "SlippageExceeded", msg: "Output is below the slippage limit." },
    { code: 6009, name: "ZeroLp", msg: "LP amount must be greater than zero." },
    { code: 6010, name: "InvalidMint", msg: "Mint does not belong to this market." },
    { code: 6011, name: "NotWinnerMint", msg: "Only the winning token can be redeemed." },
    { code: 6012, name: "InvalidPrice", msg: "Price is out of range." },
    { code: 6013, name: "InvalidLiquidity", msg: "Liquidity is invalid." },
    { code: 6014, name: "MathOverflow", msg: "Fixed-point math overflow." },
    { code: 6015, name: "InvalidDuration", msg: "Duration is invalid." },
    { code: 6016, name: "InvalidBudget", msg: "Budget is invalid." },
    { code: 6017, name: "NotFirstAfterExpiry", msg: "Price is not the first Pyth update after expiry." },
    { code: 6018, name: "ExponentMismatch", msg: "Pyth exponent does not match this market." },
  ],
  types: [
    {
      name: "CreateMarketParams",
      type: {
        kind: "struct",
        fields: [
          { name: "expiry", type: "u64" },
          { name: "market_id", type: { array: ["u8", 16] } },
          { name: "prediction", type: { array: ["u8", 64] } },
          { name: "collateral_amount", type: "u64" },
          { name: "feed_id", type: { array: ["u8", 32] } },
          { name: "threshold", type: "i64" },
          { name: "exponent", type: "i32" },
          { name: "settle_above", type: "bool" },
        ],
      },
    },
    {
      name: "LpPosition",
      type: {
        kind: "struct",
        fields: [
          { name: "owner", type: "pubkey" },
          { name: "shares", type: "i128" },
          { name: "checkpoint_yes", type: "i128" },
          { name: "checkpoint_no", type: "i128" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "Market",
      type: {
        kind: "struct",
        fields: [
          { name: "expiry", type: "u64" },
          { name: "creator", type: "pubkey" },
          { name: "id", type: { array: ["u8", 16] } },
          { name: "bump", type: "u8" },
          { name: "yes_mint", type: "pubkey" },
          { name: "no_mint", type: "pubkey" },
          { name: "status", type: { defined: { name: "MarketStatus" } } },
          { name: "collateral_mint", type: "pubkey" },
          { name: "winner", type: { defined: { name: "MarketOutcome" } } },
          { name: "market_collateral_bump", type: "u8" },
          { name: "prediction", type: { array: ["u8", 64] } },
          { name: "l_zero", type: "i128" },
          { name: "last_accrual_ts", type: "i64" },
          { name: "cum_yes_per_share", type: "i128" },
          { name: "cum_no_per_share", type: "i128" },
          { name: "fee_bps", type: "u16" },
          { name: "reserve_yes", type: "i128" },
          { name: "reserve_no", type: "i128" },
          { name: "total_lp_shares", type: "i128" },
          { name: "end_ts", type: "i64" },
          { name: "feed_id", type: { array: ["u8", 32] } },
          { name: "threshold", type: "i64" },
          { name: "exponent", type: "i32" },
          { name: "settle_above", type: "bool" },
          { name: "settled_price", type: "i64" },
          { name: "settled_publish_time", type: "i64" },
        ],
      },
    },
    {
      name: "MarketOutcome",
      type: { kind: "enum", variants: [{ name: "Yes" }, { name: "No" }] },
    },
    {
      name: "MarketStatus",
      type: { kind: "enum", variants: [{ name: "Upcoming" }, { name: "Open" }, { name: "Resolved" }, { name: "Burn" }] },
    },
    {
      name: "SwapParams",
      type: {
        kind: "struct",
        fields: [
          { name: "min_out", type: "u64" },
          { name: "amount_in", type: "u64" },
          { name: "token_type", type: { defined: { name: "MarketOutcome" } } },
        ],
      },
    },
    {
      name: "UserBetOnParams",
      type: {
        kind: "struct",
        fields: [
          { name: "min_out", type: "u64" },
          { name: "collateral_amount", type: "u64" },
          { name: "token_type", type: { defined: { name: "MarketOutcome" } } },
        ],
      },
    },
  ],
  constants: [
    { name: "MAX_SETTLE_DELAY", type: "i64", value: "10" },
    { name: "RESOLVE_WINDOW", type: "u64", value: "172800" },
    { name: "SERVICE_FEE", type: "u64", value: "30" },
  ],
};

function camel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}
function camelKeys(value, keyHint) {
  if (Array.isArray(value)) return value.map((v) => camelKeys(v));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const ck = camel(k);
    if (k === "name" && typeof v === "string" && keyHint !== "defined" && keyHint !== "account" && keyHint !== "errorName") {
      // instruction/account/field names camelCase; type names stay Pascal
      if (/^[A-Z]/.test(v)) out[ck] = v;
      else out[ck] = camel(v);
    } else if (k === "path" && typeof v === "string") {
      out[ck] = v.split(".").map(camel).join(".");
    } else if (k === "account" && typeof v === "string") {
      out[ck] = v; // type name
    } else {
      out[ck] = camelKeys(v, k);
    }
  }
  return out;
}

function emitTs(camelIdl) {
  const body = JSON.stringify(camelIdl, null, 2);
  return `/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at \`target/idl/prediction_market.json\`.
 */
export type PredictionMarket = ${body};
`;
}

const camelIdl = camelKeys(idl);
const root = path.join(__dirname, "../..");
const jsonText = JSON.stringify(idl, null, 2) + "\n";
const tsText = emitTs(camelIdl);

const targets = [
  path.join(root, "target/idl/prediction_market.json"),
  path.join(root, "app/src/idl/prediction_market.json"),
];
const tsTargets = [
  path.join(root, "target/types/prediction_market.ts"),
  path.join(root, "app/src/idl/prediction_market.ts"),
];
for (const p of targets) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, jsonText);
}
for (const p of tsTargets) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, tsText);
}
console.log("wrote IDL", {
  ix: idl.instructions.map((i) => i.name),
  accounts: idl.accounts.map((a) => a.name),
  errors: idl.errors.length,
  createArgs: idl.types.find((t) => t.name === "CreateMarketParams").type.fields.map((f) => f.name),
});
