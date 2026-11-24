import { SendTransactionError } from "@solana/web3.js";
import { hasKey, t } from "@/i18n/store";

export class ConfirmedTransactionError extends Error {
  constructor() {
    super("errors.txFailed");
  }
}

export function isSubmissionRejection(err: unknown) {
  return err instanceof ConfirmedTransactionError || err instanceof SendTransactionError;
}

const ERRORS: Record<number, string> = {
  6000: "errors.notOpen",
  6001: "errors.cannotRedeem",
  6002: "errors.cannotMerge",
  6003: "errors.expired",
  6004: "errors.notExpired",
  6005: "errors.invalidAmount",
  6006: "errors.notEnoughTokens",
  6007: "errors.emptyPool",
  6008: "errors.slippage",
  6009: "errors.lpZero",
  6010: "errors.wrongMint",
  6011: "errors.onlyWinner",
  6012: "errors.invalidPrice",
  6013: "errors.invalidLiquidity",
  6014: "errors.math",
  6015: "errors.invalidDuration",
  6016: "errors.invalidBudget",
  6017: "errors.notFirstPrint",
  6018: "errors.outsideWindow",
  6019: "errors.noCreator",
  6020: "errors.noArriveFinishTs",
  6021: "errors.marketIsOpen",
  6022: "errors.invalidOracleInput",
  6023: "errors.oracleDigestMismatch",
  6024: "errors.wrongNumberOfSignatures",
  6025: "errors.invalidOracleSignature",
  6026: "errors.unauthorizedOracleSigner",
  6027: "errors.duplicateOracleSigner",
  6028: "errors.wrongOracleState",
  6029: "errors.badFeedAccount",
  6030: "errors.feedNotAllowed",
  6031: "errors.snapshotFull",
  6032: "errors.snapshotOutOfWindow",
  6033: "errors.snapshotStale",
  6034: "errors.unableCompleteCheckout",
  6035: "errors.unsupportedDecimals",
};

const FRAMEWORK_ERRORS: Record<number, string> = {
  2012: "errors.wrongMint",
  3012: "errors.ataMissing",
};

function readErrText(err: unknown, depth = 0): string {
  if (!err || typeof err !== "object" || depth > 2) return String(err ?? "");
  const anyErr = err as {
    message?: string;
    logs?: string[];
    transactionLogs?: string[];
    transactionMessage?: string;
    name?: string;
    error?: unknown;
    cause?: unknown;
  };
  const logs = Array.isArray(anyErr.logs)
    ? anyErr.logs.join("\n")
    : Array.isArray(anyErr.transactionLogs)
      ? anyErr.transactionLogs.join("\n")
      : "";
  const nested = anyErr.error && anyErr.error !== err
    ? readErrText(anyErr.error, depth + 1)
    : anyErr.cause && anyErr.cause !== err
      ? readErrText(anyErr.cause, depth + 1)
      : "";
  return `${anyErr.name ?? ""}\n${anyErr.message ?? ""}\n${anyErr.transactionMessage ?? ""}\n${logs}\n${nested}\n${String(err)}`;
}

export function parseTxError(err: unknown): string {
  const text = readErrText(err);

  const named = text.match(/Error Code: ([A-Za-z0-9_]+)\. Error Number: (\d+)/);
  if (named) {
    const code = Number(named[2]);
    if (ERRORS[code]) return ERRORS[code];
    if (FRAMEWORK_ERRORS[code]) return FRAMEWORK_ERRORS[code];
  }

  const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex) {
    const code = parseInt(hex[1], 16);
    if (ERRORS[code]) return ERRORS[code];
  }

  const dec = text.match(/custom program error: (\d+)/);
  if (dec) {
    const code = Number(dec[1]);
    if (ERRORS[code]) return ERRORS[code];
  }

  if (/errors\.[a-zA-Z0-9]+/.test(text)) {
    const key = text.match(/errors\.[a-zA-Z0-9]+/)?.[0];
    if (key && hasKey(key)) return key;
  }

  if (/Transfer: insufficient lamports|insufficient lamports|AccountNotFound|Attempt to debit an account but found no record of a prior credit/i.test(text)) {
    return "errors.noSol";
  }
  if (/Error:\s*insufficient funds/i.test(text)) return "errors.notEnoughTokens";
  if (/insufficient funds/i.test(text)) return "errors.insufficient";
  if (/Account does not exist|could not find account/i.test(text)) return "errors.accountMissing";
  if (/Invalid public key|Non-base58|Invalid address/i.test(text)) return "errors.badAddress";
  if (/Blockhash not found/i.test(text)) return "errors.blockhash";
  if (/User rejected|rejected the request/i.test(text)) return "errors.rejected";
  if (/401|403|api[- ]?key|forbidden|unauthorized/i.test(text)) return "errors.rpcAuth";
  if (/429|rate limit|too many requests/i.test(text)) return "errors.rpcRate";
  if (/failed to fetch|Failed to fetch|ECONNREFUSED|network|ERR_NAME_NOT_RESOLVED/i.test(text)) return "errors.rpc";
  if (/Connect a wallet first|WalletNotConnected|WalletNotReady|WalletNotSelected/i.test(text)) return "errors.connectWallet";
  if (/No instructions to send/i.test(text)) return "errors.noIxs";
  if (/Collateral mint not found/i.test(text)) return "errors.mintNotFound";
  if (/WalletSignTransactionError|WalletSendTransactionError|Unexpected error/i.test(text)) return "errors.walletSign";

  return "errors.txFailed";
}

export function localizeError(raw: string | null | undefined): string {
  if (!raw) return t("errors.txFailed");
  if (hasKey(raw)) return t(raw);
  return t("errors.txFailed");
}
