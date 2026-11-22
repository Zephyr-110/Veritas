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
    it("distinguishes SOL rent shortage, SPL token shortage, ATA missing, and wallet sign errors", () => {
      expect(
        parseTxError({
          message: '{"InstructionError":[1,{"Custom":1}]}',
          logs: ["Transfer: insufficient lamports 650240, need 3480720"],
        })
      ).toBe("errors.noSol");
      expect(parseTxError({ message: "AccountNotFound" })).toBe("errors.noSol");
      expect(
        parseTxError({
          message: "custom program error: 0x1",
          logs: ["Program log: Error: insufficient funds"],
        })
      ).toBe("errors.notEnoughTokens");
      expect(
        parseTxError({
          logs: ["AnchorError caused by account: creator_collateral_ata. Error Code: AccountNotInitialized. Error Number: 3012."],
        })
      ).toBe("errors.ataMissing");
      expect(
        parseTxError({
          name: "WalletSignTransactionError",
          message: "Unexpected error",
        })
      ).toBe("errors.walletSign");
      expect(
        parseTxError({
          name: "WalletSignTransactionError",
          message: "User rejected the request.",
        })
      ).toBe("errors.rejected");
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
