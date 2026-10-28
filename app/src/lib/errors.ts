const ERRORS: Record<number, string> = {
  6000: "Only this market's oracle can resolve it.",
  6001: "Market is not open, or void conditions are not met.",
  6002: "Market is not resolved or voided, so it cannot be redeemed.",
  6003: "Cannot merge or withdraw in this state.",
  6004: "Market has expired; trading is closed.",
  6005: "Outside the resolve window.",
  6006: "Invalid amount or expiry.",
  6007: "Not enough tokens in the matching account.",
  6008: "Yes / No pool is empty.",
  6009: "Output is below slippage protection.",
  6010: "LP amount must be greater than 0.",
  6011: "This mint is not this market's Yes or No token.",
  6012: "After resolution, only the winning token can be redeemed.",
  6013: "The oracle cannot buy or swap.",
};

function pickLogs(err: unknown): string {
  if (!err || typeof err !== "object") return String(err ?? "");
  const anyErr = err as {
    message?: string;
    logs?: string[];
    getLogs?: () => string[] | Promise<string[]>;
  };
  const logs = Array.isArray(anyErr.logs) ? anyErr.logs.join("\n") : "";
  return `${anyErr.message ?? ""}\n${logs}\n${String(err)}`;
}

export function parseTxError(err: unknown): string {
  const text = pickLogs(err);

  const named = text.match(/Error Code: ([A-Za-z]+)\. Error Number: (\d+)/);
  if (named) {
    const code = Number(named[2]);
    return ERRORS[code] ?? named[1];
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

  if (/Attempt to debit an account but found no record of a prior credit/i.test(text)) {
    return "Not enough SOL to pay fees.";
  }
  if (/insufficient funds|insufficient lamports/i.test(text)) {
    return "Insufficient balance.";
  }
  if (/Blockhash not found/i.test(text)) {
    return "Blockhash expired. Try again.";
  }
  if (/User rejected|rejected the request/i.test(text)) {
    return "Signature rejected in the wallet.";
  }
  if (/failed to fetch|Failed to fetch|ECONNREFUSED|network/i.test(text)) {
    return "Cannot reach the RPC. Check Settings.";
  }

  const msg = err instanceof Error ? err.message : String(err);
  return msg || "Transaction failed";
}
