"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mocha_1 = require("mocha");
const anchor = __importStar(require("@coral-xyz/anchor"));
const buffer_1 = require("buffer");
(0, mocha_1.describe)("prediction_market", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.PredictionMarket;
    (0, mocha_1.it)("初始化测试环境检查", async () => {
        console.log("Program ID:", program.programId.toBase58());
        console.log("当前测试钱包公钥：", provider.wallet.publicKey.toBase58());
        const marketID = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        // 推导 market PDA
        const [marketPda, marketBump] = anchor.web3.PublicKey.findProgramAddressSync([buffer_1.Buffer.from("market"), buffer_1.Buffer.from(marketID)], program.programId);
        // 推导 Yes Mint PDA
        const [yesMintPda] = anchor.web3.PublicKey.findProgramAddressSync([buffer_1.Buffer.from("yes_mint"), marketPda.toBuffer()], program.programId);
        // 推导 No Mint PDA
        const [noMintPda] = anchor.web3.PublicKey.findProgramAddressSync([buffer_1.Buffer.from("no_mint"), marketPda.toBuffer()], program.programId);
        // 推导 Vault PDA
        const [collateralPda] = anchor.web3.PublicKey.findProgramAddressSync([buffer_1.Buffer.from("collateral_vault"), marketPda.toBuffer()], program.programId);
        console.log("--- 核心 PDA 计算结果 ---");
        console.log("Market PDA:", marketPda.toBase58());
        console.log("Yes Mint PDA:", yesMintPda.toBase58());
        console.log("No Mint PDA:", noMintPda.toBase58());
        console.log("Collateral Vault PDA:", collateralPda.toBase58());
        const title = "Will BUC hit $100k before 2027?";
        const now = new anchor.BN(Math.floor(Date.now() / 1000));
        const resolutionTime = now.addn(3600);
        await program.methods
            .createMarket(marketID, title, now, resolutionTime)
            .accounts({
            "market": marketPda,
            "yesMint": yesMintPda,
            "noMint": noMintPda,
            "tokenProgram": anchor.utils.token.TOKEN_PROGRAM_ID,
            "collateralMint": provider.wallet.publicKey,
            "collateralVault": collateralPda,
            "signer": provider.wallet.publicKey,
            "systemProgram": anchor.web3.SystemProgram.programId
        })
            .rpc();
    });
});
