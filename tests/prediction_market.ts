import * as anchor from "@coral-xyz/anchor";
import { Program} from "@coral-xyz/anchor"
import { Buffer } from "buffer"
import { assert } from "chai"
import {
    createMint,
    getOrCreateAssociatedTokenAccount,
    mintTo,
    getAssociatedTokenAddressSync,
    getAccount
} from "@solana/spl-token";
import {PublicKey} from "@solana/web3.js";


describe("prediction_market", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.PredictionMarket as Program<any>;

    console.log("当前使用的 RPC 终端是:", provider.connection.rpcEndpoint);

    let mockCollateralMint: anchor.web3.PublicKey;

    it("初始化测试环境检查", async () => {
        // 创建铸币厂
        mockCollateralMint = await createMint(
            provider.connection,
            (provider.wallet as any).payer,
            provider.wallet.publicKey,
            null,
            6
        );

        // 创建用户币子ATA
        const userCollateralAta = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            (provider.wallet as any).payer,
            mockCollateralMint,
            provider.wallet.publicKey
        )

        const mintAmount = 1000 * 10 ** 6;

        await mintTo(
            provider.connection,
            (provider.wallet as any).payer,
            mockCollateralMint,
            userCollateralAta.address,
            provider.wallet.publicKey,
            mintAmount
        )

        console.log("我的土狗代币 ATA:", "8dNDWTjsJTHijGqhmcSNmMPG5CiFBXGg6e67R3wdxSmi");
        console.log("Program ID:", program.programId.toBase58());
        console.log("当前测试钱包公钥：", provider.wallet.publicKey.toBase58());

        const marketID = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

        // 推导 market PDA
        const [marketPda, marketBump] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("market"), Buffer.from(marketID)],
            program.programId
        )

        // 推导 Yes Mint PDA
        const [yesMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("yes_mint"), marketPda.toBuffer()],
            program.programId
        )

        // 推导 No Mint PDA
        const [noMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("no_mint"), marketPda.toBuffer()],
            program.programId
        )

        // 推导 Vault PDA
        const [collateralPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("collateral_vault"), marketPda.toBuffer()],
            program.programId
        )

        console.log("--- 核心 PDA 计算结果 ---");
        console.log("Market PDA:", marketPda.toBase58());
        console.log("Yes Mint PDA:", yesMintPda.toBase58());
        console.log("No Mint PDA:", noMintPda.toBase58());
        console.log("Collateral Vault PDA:", collateralPda.toBase58());

        const buffer = Buffer.alloc(64);
        buffer.write("Will BUC hit $100k before 2027?");
        const prediction = Array.from(buffer);

        const now = new anchor.BN(Math.floor(Date.now() / 1000)-10);
        const resolutionTime = now.addn(3600);

        await (program.methods as any)
            .createMarket(marketID, prediction, now, resolutionTime)
            .accounts({
                "market": marketPda,
                "yesMint": yesMintPda,
                "noMint": noMintPda,
                "tokenProgram": anchor.utils.token.TOKEN_PROGRAM_ID,
                "collateralMint": mockCollateralMint,
                "collateralVault": collateralPda,
                "signer": provider.wallet.publicKey,
                "systemProgram": anchor.web3.SystemProgram.programId
            })
            .rpc();

        // 拉去链上数据
        const marketAccount = await (program.account as any).market.fetch(marketPda)

        console.log("---链上 Market 账户数据 ---");
        console.log("标题：", marketAccount.prediction);
        console.log("创建者：", marketAccount.authority.toBase58());

        assert.deepEqual(marketAccount.prediction, prediction, "市场标题与链上不匹配");
        assert.equal(
            marketAccount.expiry.toNumber(),
            resolutionTime.toNumber(),
            "结算时间与链上不匹配"
        );

        assert.deepEqual(
            Array.from(marketAccount.id),
            marketID,
            "Market ID 与链上不匹配"
        );

        console.log(" 创建盘口断言全部通过！");
    })

    it("开盘测试检查", async () => {
        const marketId = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const [marketPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("market"), Buffer.from(marketId)],
            program.programId
        )

        const signer = provider.wallet.publicKey;


        await (program.methods as any)
            .openMarket()
            .accounts({
                "market": marketPda,
                "signer": signer,
                "clock": anchor.web3.SYSVAR_CLOCK_PUBKEY
            })
            .rpc();

        const marketAccount = await (program.account as any).market.fetch(marketPda);

        assert.deepEqual(
            marketAccount.status,
            { open: {}},
            "盘口状态未改变"
        );

        console.log("当前盘口状态：", JSON.stringify(marketAccount.status));

        console.log(" 开盘断言全部通过！")
    })

    it("下注测试检查", async () => {
        const outcomeAmount = new anchor.BN(100000);
        const marketID = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];


        const signer = provider.wallet.publicKey;

        const [market] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("market"), Buffer.from(marketID)],
            program.programId
        )

        const userCollateral = getAssociatedTokenAddressSync(
            mockCollateralMint,
            provider.wallet.publicKey
        )

        const [collateralVault] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("collateral_vault"), market.toBuffer()],
            program.programId
        )

        // 暂且就押注 Yes 币吧，推到 Yes Mint PDA
        const [yesMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("yes_mint"), market.toBuffer()],
            program.programId
        )

        const yesTokenAtaAccount = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            (provider.wallet as any).payer,
            yesMintPda,
            provider.wallet.publicKey
        );

        const clock = anchor.web3.SYSVAR_CLOCK_PUBKEY;

        const tokenProgram = anchor.utils.token.TOKEN_PROGRAM_ID;

        const systemProgram = anchor.web3.SystemProgram.programId;

        await (program.methods as any)
            .userBetOn(outcomeAmount)
            .accounts({
                "signer": signer,
                "market": market,
                "userCollateral": userCollateral,
                "collateralMint": mockCollateralMint,
                "collateralVault": collateralVault,
                "outcomeMint": yesMintPda,
                "outcomeTokenAta": yesTokenAtaAccount.address,
                "clock": clock,
                "tokenProgram": tokenProgram,
                "systemProgram": systemProgram
            })
            .rpc();

        const yesTokenAccount = await getAccount(
            provider.connection,
            yesTokenAtaAccount.address
        );

        const vaultAccount = await getAccount(
            provider.connection,
            collateralVault
        );

        assert.equal(
            yesTokenAccount.amount.toString(),
            vaultAccount.amount.toString(),
            "金库抵押物和用户拿到的Token数量不一致！"
        );
    })
})