const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");

function disc(prefix, name) {
  return Array.from(nodeCrypto.createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8));
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
const SYSTEM_PROG = "11111111111111111111111111111111";
const ATA_PROG = {
  kind: "const",
  value: [140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89],
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
        { name: "system_program", address: SYSTEM_PROG },
      ],
      args: [{ name: "collateral_amount", type: "u64" }],
    },
    {
      name: "burn_account",
      discriminator: disc("global", "burn_account"),
      accounts: [
        { name: "signer", writable: true, signer: true },
        { name: "market", writable: true, ...marketPdaFromId() },
        { name: "snapshot", writable: true, ...pda([seed("snapshot"), accPath("market")]) },
        { name: "yes_pool", writable: true, ...pda([seed("yes_pool"), accPath("market")]) },
        { name: "no_pool", writable: true, ...pda([seed("no_pool"), accPath("market")]) },
        { name: "yes_mint", writable: true, ...pda([seed("yes_mint"), accPath("market")]) },
        { name: "no_mint", writable: true, ...pda([seed("no_mint"), accPath("market")]) },
        { name: "collateral_ata", writable: true },
        { name: "collateral_vault", writable: true, ...pda([seed("collateral_vault"), accPath("market")]) },
        { name: "collateral_mint" },
        { name: "token_program" },
        { name: "clock", address: CLOCK },
      ],
      args: [],
    },
    {
      name: "create_market",
      discriminator: disc("global", "create_market"),
      accounts: [
        { name: "creator", writable: true, signer: true },
        { name: "market", writable: true, ...marketPdaFromArg() },
        { name: "ocr2_state" },
        { name: "snapshot", writable: true, ...pda([seed("snapshot"), accPath("market")]) },
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
        { name: "system_program", address: SYSTEM_PROG },
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
        { name: "maker_yes_ata", writable: true, ...ataPda("signer", "yes_mint") },
        { name: "maker_no_ata", writable: true, ...ataPda("signer", "no_mint") },
        { name: "yes_pool", writable: true, ...pda([seed("yes_pool"), accPath("market")]) },
        { name: "no_pool", writable: true, ...pda([seed("no_pool"), accPath("market")]) },
        { name: "clock", address: CLOCK },
        { name: "associated_token_program" },
        { name: "token_program" },
        { name: "system_program", address: SYSTEM_PROG },
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
        { name: "snapshot", optional: true, ...pda([seed("snapshot"), accPath("market")]) },
        { name: "ocr2_state" },
        { name: "clock", address: CLOCK },
      ],
      args: [{ name: "param", type: { defined: { name: "ResolveMarketParam" } } }],
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
      name: "take_snapshot",
      discriminator: disc("global", "take_snapshot"),
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "market" },
        { name: "snapshot", writable: true, ...pda([seed("snapshot"), accPath("market")]) },
        { name: "ocr2_state" },
        { name: "feed" },
        { name: "clock", address: CLOCK },
        { name: "system_program", address: SYSTEM_PROG },
      ],
      args: [],
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
        { name: "system_program", address: SYSTEM_PROG },
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
    { name: "MarketSnapshot", discriminator: disc("account", "MarketSnapshot") },
  ],
  errors: [
    { code: 6000, name: "MarketNotOpen", msg: "Market is not open." },
    { code: 6001, name: "MarketNotResolved", msg: "Market is not resolved or voided." },
    { code: 6002, name: "MarketNotTradable", msg: "Market must be open, resolved, or voided." },
    { code: 6003, name: "MarketExpired", msg: "Market has expired." },
    { code: 6004, name: "MarketNotExpired", msg: "Market has not expired yet." },
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
    { code: 6017, name: "NotFirstAfterExpiry", msg: "Reports are not two adjacent oracle rounds straddling expiry." },
    { code: 6018, name: "MarketNotInWindow", msg: "Market is not in the required time window." },
    { code: 6019, name: "NoCreator", msg: "Signer is not the market creator." },
    { code: 6020, name: "NoArriveFinishTS", msg: "Claim window has not ended yet." },
    { code: 6021, name: "MarketIsOpen", msg: "Market is still open." },
    { code: 6022, name: "InvalidOracleInput", msg: "Oracle report or state data is malformed." },
    { code: 6023, name: "OracleDigestMismatch", msg: "Oracle report was not signed under the feed's current config." },
    { code: 6024, name: "WrongNumberOfSignatures", msg: "Oracle report has the wrong number of signatures." },
    { code: 6025, name: "InvalidOracleSignature", msg: "Oracle report signature is invalid." },
    { code: 6026, name: "UnauthorizedOracleSigner", msg: "Oracle report is signed by a node outside the feed's oracle set." },
    { code: 6027, name: "DuplicateOracleSigner", msg: "Oracle report is signed twice by the same node." },
    { code: 6028, name: "WrongOracleState", msg: "Oracle state account is not an allowed feed or does not match this market." },
    { code: 6029, name: "BadFeedAccount", msg: "Feed account does not match this market's price feed." },
    { code: 6030, name: "FeedNotAllowed", msg: "Price feed is not in the allowed feed list." },
    { code: 6031, name: "SnapshotFull", msg: "Snapshot already holds sixteen entries." },
    { code: 6032, name: "SnapshotOutOfWindow", msg: "Snapshot can only be taken within ten seconds of expiry." },
    { code: 6033, name: "SnapshotStale", msg: "Snapshot landing counter must move forward." },
    { code: 6034, name: "UnableCompleteCheckout", msg: "Reports are not adjacent rounds and are not certified by the market snapshot." },
    { code: 6035, name: "UnsupportedDecimals", msg: "Feed decimals must be 8." },
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
          { name: "threshold", type: "i64" },
          { name: "settle_above", type: "bool" },
        ],
      },
    },
    {
      name: "EpochRound",
      type: {
        kind: "struct",
        fields: [
          { name: "epoch", type: "u32" },
          { name: "round", type: "u8" },
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
          { name: "winner", type: { option: { defined: { name: "MarketOutcome" } } } },
          { name: "market_collateral_bump", type: "u8" },
          { name: "prediction", type: { array: ["u8", 64] } },
          { name: "finish_ts", type: "u64" },
          { name: "l_zero", type: "i128" },
          { name: "last_accrual_ts", type: "i64" },
          { name: "cum_yes_per_share", type: "i128" },
          { name: "cum_no_per_share", type: "i128" },
          { name: "fee_bps", type: "u16" },
          { name: "reserve_yes", type: "i128" },
          { name: "reserve_no", type: "i128" },
          { name: "total_lp_shares", type: "i128" },
          { name: "end_ts", type: "i64" },
          { name: "ocr2_state", type: "pubkey" },
          { name: "threshold", type: "i64" },
          { name: "decimals", type: "u8" },
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
      name: "MarketSnapshot",
      type: {
        kind: "struct",
        fields: [
          { name: "entries", type: { vec: { defined: { name: "Snapshot" } } } },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "MarketStatus",
      type: {
        kind: "enum",
        variants: [{ name: "Open" }, { name: "Resolved" }, { name: "WindowBurn" }, { name: "StaleBurn" }],
      },
    },
    {
      name: "ResolveMarketParam",
      type: {
        kind: "struct",
        fields: [
          { name: "raw_pre", type: "bytes" },
          { name: "raw_post", type: "bytes" },
        ],
      },
    },
    {
      name: "Snapshot",
      type: {
        kind: "struct",
        fields: [
          { name: "at", type: { defined: { name: "EpochRound" } } },
          { name: "counter", type: "u32" },
          { name: "price", type: "i128" },
          { name: "ts", type: "i64" },
        ],
      },
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
    { name: "CLAIM_WINDOW", type: "u64", value: "2592000" },
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
      if (/^[A-Z]/.test(v)) out[ck] = v;
      else out[ck] = camel(v);
    } else if (k === "path" && typeof v === "string") {
      out[ck] = v.split(".").map(camel).join(".");
    } else if (k === "account" && typeof v === "string") {
      out[ck] = v;
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
 * IDL can be found at \`app/src/idl/prediction_market.json\`.
 */
export type PredictionMarket = ${body};
`;
}

const camelIdl = camelKeys(idl);
const appRoot = path.join(__dirname, "..");
const jsonText = JSON.stringify(idl, null, 2) + "\n";
const tsText = emitTs(camelIdl);

const jsonPath = path.join(appRoot, "src/idl/prediction_market.json");
const tsPath = path.join(appRoot, "src/idl/prediction_market.ts");
fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
fs.writeFileSync(jsonPath, jsonText);
fs.writeFileSync(tsPath, tsText);

console.log("wrote app IDL", {
  ix: idl.instructions.map((i) => i.name),
  accounts: idl.accounts.map((a) => ({ name: a.name, disc: a.discriminator })),
  errors: idl.errors.length,
  createArgs: idl.types.find((t) => t.name === "CreateMarketParams").type.fields.map((f) => f.name),
});
