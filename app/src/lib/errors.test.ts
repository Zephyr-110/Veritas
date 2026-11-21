import { describe, it, expect } from "vitest";
import { parseTxError, localizeError } from "@/lib/errors";

describe("errors", () => {
  describe("parseTxError", () => {
    it("extracts named Anchor error code", () => {
      const err = {
        name: "Error",
        message: "AnchorError caused by account",
        logs: ["Error Code: NotEnoughTokens. Error Number: 6006."],
      };
      expect(parseTxError(err)).toBe("errors.notEnoughTokens");
    });
    it("extracts custom program error hex", () => {
      expect(parseTxError({ message: "Transaction failed: custom program error: 0x1778" })).toBe(
        "errors.slippage"
      ); // 6008 = 0x1778
    });
    it("extracts custom program error decimal", () => {
      expect(parseTxError({ message: "custom program error: 6006" })).toBe("errors.notEnoughTokens");
    });
    it("maps common RPC/network messages", () => {
      expect(parseTxError({ message: "Account does not exist" })).toBe("errors.accountMissing");
      expect(parseTxError({ message: "wallet rejected the request" })).toBe("errors.rejected");
      expect(parseTxError({ message: "ECONNREFUSED" })).toBe("errors.rpc");
      expect(parseTxError({ message: "429 rate limit" })).toBe("errors.rpcRate");
    });
    it("falls back to generic when unknown", () => {
      expect(parseTxError({ message: "some totally random text" })).toBe("errors.txFailed");
    });
  });

  describe("localizeError", () => {
    it("has a translation for every anchor error key", () => {
      const keys = [
        "errors.notOpen",
        "errors.cannotRedeem",
        "errors.cannotMerge",
        "errors.expired",
        "errors.notExpired",
        "errors.invalidAmount",
        "errors.notEnoughTokens",
        "errors.emptyPool",
        "errors.slippage",
        "errors.lpZero",
        "errors.wrongMint",
        "errors.onlyWinner",
        "errors.invalidPrice",
        "errors.invalidLiquidity",
        "errors.math",
        "errors.invalidDuration",
        "errors.invalidBudget",
        "errors.notFirstPrint",
        "errors.outsideWindow",
        "errors.noCreator",
        "errors.noArriveFinishTs",
        "errors.marketIsOpen",
        "errors.invalidOracleInput",
        "errors.oracleDigestMismatch",
        "errors.wrongNumberOfSignatures",
        "errors.invalidOracleSignature",
        "errors.unauthorizedOracleSigner",
        "errors.duplicateOracleSigner",
        "errors.wrongOracleState",
        "errors.badFeedAccount",
        "errors.feedNotAllowed",
        "errors.snapshotFull",
        "errors.snapshotOutOfWindow",
        "errors.snapshotStale",
        "errors.unableCompleteCheckout",
        "errors.unsupportedDecimals",
      ];
      for (const k of keys) {
        const v = localizeError(k);
        expect(v).not.toBe(k); // translated to something readable
        expect(v).toBeTruthy();
      }
    });
    it("falls back to generic for null/undefined", () => {
      expect(localizeError(null)).toBeTruthy();
      expect(localizeError(undefined)).toBeTruthy();
    });
  });
});
