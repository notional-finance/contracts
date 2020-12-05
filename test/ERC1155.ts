import chai from "chai";
import { solidity, deployContract } from "ethereum-waffle";
import { fixture, wallets, fixtureLoader, provider, fastForwardToMaturity, CURRENCY } from "./fixtures";
import { Wallet } from "ethers";
import { WeiPerEther, AddressZero } from "ethers/constants";

import { Ierc20 as ERC20 } from "../typechain/Ierc20";
import { CashMarket } from "../typechain/CashMarket";
import { ErrorDecoder, ErrorCodes } from "../scripts/errorCodes";
import { Escrow } from "../typechain/Escrow";
import { Portfolios } from "../typechain/Portfolios";
import { Erc1155Token as ERC1155Token } from "../typechain/Erc1155Token";
import { TestUtils, BLOCK_TIME_LIMIT, AssetType } from "./testUtils";
import { BigNumber, parseEther, defaultAbiCoder } from "ethers/utils";

import ERC1155MockReceiverArtifact from "../mocks/ERC1155MockReceiver.json";
import { Iweth } from '../typechain/Iweth';
import { MockAggregator } from '../mocks/MockAggregator';
import { Erc1155Trade } from '../typechain/Erc1155Trade';

chai.use(solidity);
const { expect } = chai;

enum TradeType {
    TakeCollateral = 0,
    TakeFutureCash = 1,
    AddLiquidity = 2,
    RemoveLiquidity = 3
}

const MAX_IMPLIED_RATE = 10_000_000;
const MIN_IMPLIED_RATE = 0;

describe("ERC1155 Token", () => {
    let dai: ERC20;
    let weth: Iweth;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let rateAnchor: number;
    let futureCash: CashMarket;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let erc1155: ERC1155Token;
    let erc1155trade: Erc1155Trade;
    let t: TestUtils;
    let maturities: number[];
    let erc1155Receiver: any;
    let chainlink: MockAggregator;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.cashMarket;
        escrow = objs.escrow;
        portfolios = objs.portfolios;
        erc1155 = objs.erc1155;
        weth = objs.weth;
        chainlink = objs.chainlink;
        erc1155trade = objs.notional.erc1155trade;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));

        await weth.connect(wallet).deposit({value: parseEther("1000")});
        await weth.connect(wallet).approve(escrow.address, parseEther("100000000"));
        await weth.connect(wallet2).deposit({value: parseEther("1000")});
        await weth.connect(wallet2).approve(escrow.address, parseEther("100000000"));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);
        erc1155Receiver = await deployContract(owner, ERC1155MockReceiverArtifact);
        await escrow.connect(owner).deposit(dai.address, parseEther("50000"));

        // Set the blockheight to the beginning of the next period
        maturities = await futureCash.getActiveMaturities();
        await fastForwardToMaturity(provider, maturities[1]);

        t = new TestUtils(escrow, futureCash, portfolios, dai, owner, objs.chainlink, objs.weth, CURRENCY.DAI);
        maturities = await futureCash.getActiveMaturities();
        await t.setupLiquidity();
        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
    });

    afterEach(async () => {
        expect(await t.checkEthBalanceIntegrity([owner, wallet, wallet2, erc1155Receiver])).to.be.true;
        expect(await t.checkBalanceIntegrity([owner, wallet, wallet2, erc1155Receiver])).to.be.true;
        expect(await t.checkMarketIntegrity([owner, wallet, wallet2, erc1155Receiver], maturities)).to.be.true;
    });

    it("cannot send tokens to the zero address", async () => {
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(owner.address, 0)
        );

        await expect(
            erc1155.connect(owner).safeTransferFrom(owner.address, AddressZero, id, WeiPerEther.mul(900), "0x0")
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_ADDRESS));
    });

    it("cannot transfer matured assets", async () => {
        await futureCash.connect(wallet).takefCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, 0);
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 0)
        );

        await fastForwardToMaturity(provider, maturities[1]);
        await expect(
            erc1155.connect(wallet).safeTransferFrom(wallet.address, owner.address, id, WeiPerEther.mul(100), "0x0")
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_TRANSFER_MATURED_ASSET));
    });

    it("cannot overflow uint128 in value", async () => {
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(owner.address, 0)
        );

        await expect(
            erc1155
                .connect(owner)
                .safeTransferFrom(
                    owner.address,
                    wallet.address,
                    id,
                    "0xffffffffffffffffffffffffffffffffffffffff",
                    "0x0"
                )
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INTEGER_OVERFLOW));
    });

    it("only the sender can call transfer", async () => {
        await futureCash
            .connect(wallet)
            .takefCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, MIN_IMPLIED_RATE);
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 0)
        );

        await expect(
            erc1155.connect(owner).safeTransferFrom(wallet.address, owner.address, id, WeiPerEther.mul(100), "0x0")
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UNAUTHORIZED_CALLER));
    });

    it("cannot call transfer with too much balance", async () => {
        await futureCash
            .connect(wallet)
            .takefCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, MIN_IMPLIED_RATE);
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 0)
        );

        await expect(
            erc1155.connect(wallet).safeTransferFrom(wallet.address, owner.address, id, WeiPerEther.mul(105), "0x0")
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
    });

    it("can transfer cash receiver", async () => {
        await futureCash
            .connect(wallet)
            .takefCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, MIN_IMPLIED_RATE);
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 0)
        );

        await expect(
            erc1155.connect(wallet).safeTransferFrom(wallet.address, owner.address, id, WeiPerEther.mul(100), "0x0")
        ).to.emit(erc1155, "TransferSingle");

        expect(await portfolios.getAssets(wallet.address)).to.have.lengthOf(0);
        expect(await erc1155.balanceOf(wallet.address, id)).to.equal(0);
        expect(await t.hasCashPayer(owner, maturities[0], WeiPerEther.mul(9900))).to.be.true;
    });

    it("can transfer liquidity tokens between accounts", async () => {
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(owner.address, 0)
        );

        await expect(
            erc1155.connect(owner).safeTransferFrom(owner.address, wallet.address, id, WeiPerEther.mul(900), "0x0")
        ).to.emit(erc1155, "TransferSingle");

        expect(await t.hasLiquidityToken(owner, maturities[0], WeiPerEther.mul(9100), WeiPerEther.mul(10_000))).to.be
            .true;
        expect(await t.hasLiquidityToken(wallet, maturities[0], WeiPerEther.mul(900), new BigNumber(0))).to.be.true;
    });

    it("cannot transfer fCash payer between accounts", async () => {
        await futureCash
            .connect(wallet)
            .takeCurrentCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, MAX_IMPLIED_RATE);
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 0)
        );

        await expect(
            erc1155.connect(wallet).safeTransferFrom(wallet.address, owner.address, id, WeiPerEther.mul(100), "0x0")
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_TRANSFER_PAYER));
    });

    it("can transfer assets in batch", async () => {
        await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10_000), [1]);
        await futureCash
            .connect(wallet)
            .takefCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, MIN_IMPLIED_RATE);
        await futureCash
            .connect(wallet)
            .takefCash(maturities[1], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, MIN_IMPLIED_RATE);

        const id1 = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 0)
        );
        const id2 = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 1)
        );

        await expect(
            erc1155
                .connect(wallet)
                .safeBatchTransferFrom(
                    wallet.address,
                    owner.address,
                    [id1, id2],
                    [WeiPerEther.mul(50), WeiPerEther.mul(75)],
                    "0x0"
                )
        ).to.emit(erc1155, "TransferBatch");

        const balances = await erc1155.balanceOfBatch([wallet.address, wallet.address], [id1, id2]);
        expect(balances[0]).to.equal(WeiPerEther.mul(50));
        expect(balances[1]).to.equal(WeiPerEther.mul(25));
        expect(await t.hasCashPayer(owner, maturities[0], WeiPerEther.mul(9950))).to.be.true;
        expect(await t.hasCashPayer(owner, maturities[1], WeiPerEther.mul(9925))).to.be.true;
    });

    it("can decode asset ids", async () => {
        const asset = await portfolios.getAsset(owner.address, 0);
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](asset);
        const vals = await erc1155.decodeAssetId(id);

        expect(vals[0]).to.equal(asset.cashGroupId);
        expect(vals[1]).to.equal(asset.instrumentId);
        expect(vals[2]).to.equal(asset.maturity);
        expect(vals[3]).to.equal(asset.assetType);
    });

    it("can approve and use operators", async () => {
        await erc1155.connect(owner).setApprovalForAll(wallet2.address, true);
        expect(await erc1155.isApprovedForAll(owner.address, wallet2.address));
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(owner.address, 0)
        );

        await expect(
            erc1155.connect(wallet2).safeTransferFrom(owner.address, wallet.address, id, WeiPerEther.mul(900), "0x0")
        ).to.emit(erc1155, "TransferSingle");
    });

    it("supports erc1155 token receivers on success", async () => {
        await erc1155Receiver.setShouldReject(false);
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(owner.address, 0)
        );

        await expect(
            erc1155
                .connect(owner)
                .safeTransferFrom(owner.address, erc1155Receiver.address, id, WeiPerEther.mul(900), "0x0")
        ).to.emit(erc1155, "TransferSingle");
    });

    it("supports erc1155 token receivers on failure", async () => {
        await erc1155Receiver.setShouldReject(true);
        const id = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(owner.address, 0)
        );

        await expect(
            erc1155
                .connect(owner)
                .safeTransferFrom(owner.address, erc1155Receiver.address, id, WeiPerEther.mul(900), "0x0")
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ERC1155_NOT_ACCEPTED));
    });

    it("supports erc1155 token receivers on batch success", async () => {
        await erc1155Receiver.setShouldReject(false);
        await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10_000), [1]);
        await futureCash
            .connect(wallet)
            .takefCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, MIN_IMPLIED_RATE);
        await futureCash
            .connect(wallet)
            .takefCash(maturities[1], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, MIN_IMPLIED_RATE);

        const id1 = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 0)
        );
        const id2 = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 1)
        );

        await expect(
            erc1155
                .connect(wallet)
                .safeBatchTransferFrom(
                    wallet.address,
                    erc1155Receiver.address,
                    [id1, id2],
                    [WeiPerEther.mul(50), WeiPerEther.mul(75)],
                    "0x0"
                )
        ).to.emit(erc1155, "TransferBatch");
    });

    it("supports erc1155 token receivers on batch failure", async () => {
        await erc1155Receiver.setShouldReject(true);
        await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10_000), [1]);
        await futureCash
            .connect(wallet)
            .takefCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, MIN_IMPLIED_RATE);
        await futureCash
            .connect(wallet)
            .takefCash(maturities[1], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, MIN_IMPLIED_RATE);

        const id1 = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 0)
        );
        const id2 = await erc1155["encodeAssetId((uint8,uint16,uint32,bytes1,uint32,uint128))"](
            await portfolios.getAsset(wallet.address, 1)
        );

        await expect(
            erc1155
                .connect(wallet)
                .safeBatchTransferFrom(
                    wallet.address,
                    erc1155Receiver.address,
                    [id1, id2],
                    [WeiPerEther.mul(50), WeiPerEther.mul(75)],
                    "0x0"
                )
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ERC1155_NOT_ACCEPTED));
    });

    it("supports erc165 interface lookup", async () => {
        expect(await erc1155.supportsInterface("0xd9b67a26")).to.be.true;
        expect(await erc1155.supportsInterface("0xffffffff")).to.be.false;
    });

    describe("batch operations", async () => {
        it("reverts trade on maxTime", async () => {
            await expect(
                erc1155trade.connect(wallet).batchOperation(wallet.address, 0, [], [])
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_MAX_TIME));
            await expect(
                erc1155trade.connect(wallet).batchOperationWithdraw(wallet.address, 0, [], [], [])
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_MAX_TIME));
        });

        it("reverts trade on unapproved operators", async () => {
            await expect(
                erc1155trade.connect(wallet).batchOperation(owner.address, BLOCK_TIME_LIMIT, [], [])
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UNAUTHORIZED_CALLER));
            await expect(
                erc1155trade.connect(wallet).batchOperationWithdraw(owner.address, BLOCK_TIME_LIMIT, [], [], [])
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        });

        it("reverts trade on invalid currency deposit", async () => {
            await expect(
                erc1155trade.connect(wallet).batchOperation(wallet.address, BLOCK_TIME_LIMIT, [{ currencyId: 3, amount: parseEther("100") }],[])
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_CURRENCY));
        });

        it("reverts trade on invalid currency withdraw", async () => {
            await expect(
                erc1155trade.connect(wallet).batchOperationWithdraw(wallet.address, BLOCK_TIME_LIMIT, [], [], [{ to: owner.address, currencyId: 3, amount: parseEther("100") }])
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_CURRENCY));
        });

        it("allows trade [deposit]", async () => {
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                []
            );

            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(parseEther("100"));
        });

        it("allows trade [deposit, takefCash]", async () => {
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }]
            );
            expect(await t.hasCashReceiver(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("allows trade [deposit, takefCash, slippageData]", async () => {
            const slippage = defaultAbiCoder.encode(['uint32'], [0]);
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            );
            expect(await t.hasCashReceiver(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("reverts trade on slippage [deposit, takefCash, slippageData]", async () => {
            const slippage = defaultAbiCoder.encode(['uint32'], [500_000_000]);
            await expect(erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_SLIPPAGE));
        });

        it("allows trade [deposit, takeCurrentCash]", async () => {
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 0, amount: parseEther("1.5") }],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }]
            );
            expect(await t.hasCashPayer(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("allows trade [deposit, takeCurrentCash, slippageData]", async () => {
            const slippage = defaultAbiCoder.encode(['uint32'], [100_000_000]);
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 0, amount: parseEther("1.5") }],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            );
            expect(await t.hasCashPayer(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("reverts trade on slippage [deposit, takeCurrentCash, slippageData]", async () => {
            const slippage = defaultAbiCoder.encode(['uint32'], [0]);
            await expect(erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 0, amount: parseEther("1.5") }],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_SLIPPAGE));
        })

        it("allows trade [deposit, takeCurrentCash, withdraw]", async () => {
            const slippage = defaultAbiCoder.encode(['uint32'], [100_000_000]);
            const balanceBefore = await dai.balanceOf(wallet2.address);
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 0, amount: parseEther("1.5") }],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }],
                [{ to: wallet2.address, currencyId: 1, amount: 0 }]
            );
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(0);
            expect(await dai.balanceOf(wallet2.address)).to.be.above(balanceBefore);
        });

        it("reverts on fc check [deposit, takeCurrentCash, withdraw]", async () => {
            await expect(erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 0, amount: parseEther("1.5") }],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [
                    { to: wallet2.address, currencyId: 1, amount: 0 },
                    { to: wallet2.address, currencyId: 0, amount: parseEther("1") },
                ]
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));
        });

        it("allows trade [deposit, addLiquidity]", async () => {
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }]
            );
            expect(await t.hasLiquidityToken(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("allows trade [deposit, addLiquidity, withdraw]", async () => {
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{ to: wallet2.address, currencyId: 1, amount: 0 }]
            );
            expect(await t.hasLiquidityToken(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("allows trade [deposit, addLiquidity, slippageData(min/max rate)]", async () => {
            const slippage = defaultAbiCoder.encode(['uint32', 'uint32'], [0, 100_000_000]);
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            );
            expect(await t.hasLiquidityToken(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("allows trade [deposit, addLiquidity, slippageData(min/max rate, futureCash)]", async () => {
            const slippage = defaultAbiCoder.encode(['uint32', 'uint32', 'uint128'], [0, 100_000_000, parseEther("100")]);
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            );
            expect(await t.hasLiquidityToken(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("reverts trade on slippage [deposit, addLiquidity, slippageData(min/max rate, fCash)", async () => {
            let slippage = defaultAbiCoder.encode(['uint32', 'uint32', 'uint128'], [0, 1, parseEther("100")]);
            await expect(erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.OUT_OF_IMPLIED_RATE_BOUNDS));

            slippage = defaultAbiCoder.encode(['uint32', 'uint32', 'uint128'], [100_000_000, 200_000_000, parseEther("100")]);
            await expect(erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.OUT_OF_IMPLIED_RATE_BOUNDS));

            slippage = defaultAbiCoder.encode(['uint32', 'uint32', 'uint128'], [0, 100_000_000, parseEther("1")]);
            await expect(erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.OVER_MAX_FCASH));
        });

        it("allows trade [, removeLiquidity]", async () => {
            const slippage = defaultAbiCoder.encode(['uint32', 'uint32'], [0, 100_000_000]);
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            );

            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.RemoveLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }]
            );

            expect(await t.hasLiquidityToken(wallet2, maturities[0], parseEther("100"))).to.be.false;
        });

        it("reverts trade if not enough liquidity tokens on removeLiquidity", async () => {
            await expect(erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.RemoveLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }]
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
        });

        it("reverts trade if deposit is not enough for takefCash", async () => {
            await expect(erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }]
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
        });
        it("reverts trade if deposit is not enough for addLiquidity", async () => {
            await expect(erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }]
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
        });

        it("allows trade [depositEth, takeCurrentCash]", async () => {
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                {value: parseEther("1.5")}
            );
            expect(await escrow.cashBalances(CURRENCY.ETH, wallet2.address)).to.equal(parseEther("1.5"));
        });

        it("allows trade for batchOperationWithdraw [depositEth, takeCurrentCash]", async () => {
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [],
                {value: parseEther("1.5")}
            );
            expect(await escrow.cashBalances(CURRENCY.ETH, wallet2.address)).to.equal(parseEther("1.5"));
        });

        it("withdraws exact amount for batchOperationWithdraw [depositEth, takeCurrentCash]", async () => {
            await escrow.connect(wallet2).deposit(dai.address, parseEther("10"));
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
                {value: parseEther("1.5")}
            );
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(parseEther("10"));
        });

        it("withdraws exact amount for batchOperationWithdraw [deposit, takefCash]", async () => {
            await escrow.connect(wallet2).deposit(dai.address, parseEther("10"));
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(parseEther("10"));
        });

        it("withdraws exact amount for batchOperationWithdraw [deposit, removeLiquidity]", async () => {
            await escrow.connect(wallet2).deposit(dai.address, parseEther("10"));
            const slippage = defaultAbiCoder.encode(['uint32', 'uint32'], [0, 100_000_000]);
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            );

            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.RemoveLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(parseEther("10"));
        });

        it("withdraws exact amount for batchOperationWithdraw [deposit, takeCurrentCash, takefCash]", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [1]);
            await escrow.connect(wallet2).deposit(dai.address, parseEther("10"));
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }, {
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[1],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
                {value: parseEther("1.5")}
            );

            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(parseEther("10"));
        });

        it("allows roll for batchOperation [addLiquidity]", async () => {
            await t.setupLiquidity(wallet, 0.5, parseEther("100"));
            await fastForwardToMaturity(provider, maturities[0])
            const slippage = defaultAbiCoder.encode(['uint32', 'uint32', 'uint128'], [0, 100_000_000, parseEther("100")]);

            await erc1155trade.connect(wallet).batchOperation(
                wallet.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[1],
                    amount: parseEther("100"),
                    slippageData: slippage
                }]
            );

            expect(await t.hasLiquidityToken(wallet, maturities[1], parseEther("100"))).to.be.true;
            expect(await t.hasLiquidityToken(wallet, maturities[0], parseEther("100"))).to.be.false;
        })

        it("allows roll for batchOperation [takefCash]", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1]);

            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            await fastForwardToMaturity(provider, maturities[0])
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[1],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );
            expect(await t.hasCashReceiver(wallet2, maturities[1], parseEther("100"))).to.be.true;
        })

        it("withdraws exact amount for batchOperationWithdraw w/ ETH cash [takeCurrentCash]", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1]);
            await escrow.connect(wallet2).depositEth({ value: parseEther("10")})
            const daiBalance = await dai.balanceOf(wallet2.address)
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(0);
            expect(await dai.balanceOf(wallet2.address)).to.be.above(daiBalance)
        });

        it("withdraws exact amount for batchOperationWithdraw w/ Dai cash [takeCurrentCash]", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1]);
            await escrow.connect(wallet2).deposit(dai.address, parseEther("100"))
            const daiBalance = await dai.balanceOf(wallet2.address)
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(parseEther("100"));
            expect(await dai.balanceOf(wallet2.address)).to.be.above(daiBalance)
        });

        it("allows trade (move liquidity) for batchOperationWithdraw [removeLiquidity, addLiquidity]", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1]);
            // This will move the market so there is some residual cash
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            const slippage = defaultAbiCoder.encode(['uint32', 'uint32', 'uint128'], [0, 100_000_000, parseEther("1000")]);
            await erc1155trade.connect(owner).batchOperationWithdraw(
                owner.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.RemoveLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[1],
                    amount: parseEther("1000"),
                    slippageData: "0x"
                }, {
                    tradeType: TradeType.AddLiquidity, 
                    cashGroup: 1,
                    maturity: maturities[2],
                    amount: parseEther("1000"), // It would be nice if this specified the amount above...
                    slippageData: slippage
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            expect(await t.hasLiquidityToken(owner, maturities[1], parseEther("9000"))).to.be.true;
            expect(await t.hasLiquidityToken(owner, maturities[2], parseEther("1000"))).to.be.true;
        });

        it("allows trade (move lend) for batchOperationWithdraw [takeCurrentCash, takefCash]", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1]);

            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }, {
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[1],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            expect(await t.hasCashReceiver(wallet2, maturities[1], parseEther("100"))).to.be.true;
            expect(await t.hasCashPayer(wallet2, maturities[0])).to.be.false
            expect(await t.hasCashReceiver(wallet2, maturities[0])).to.be.false
        })

        it("allows trade (repay borrow) for batchOperationWithdraw [takefCash]", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1]);

            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 0, amount: parseEther("10") }],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }, {
                    to: wallet2.address,
                    currencyId: 0,
                    amount: parseEther("10")
                }],
            );

            expect(await t.hasCashPayer(wallet2, maturities[0])).to.be.false
            expect(await t.hasCashReceiver(wallet2, maturities[0])).to.be.false
            expect(await escrow.cashBalances(0, wallet2.address)).to.equal(0)
            expect(await escrow.cashBalances(1, wallet2.address)).to.equal(0)
        })

        it("allows trade (withdraw loan) for batchOperationWithdraw [takefCash]", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0]);

            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("100") }],
                [{ 
                    tradeType: TradeType.TakeFutureCash, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{ 
                    tradeType: TradeType.TakeCollateral, 
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            expect(await t.hasCashPayer(wallet2, maturities[0])).to.be.false
            expect(await t.hasCashReceiver(wallet2, maturities[0])).to.be.false
            expect(await escrow.cashBalances(1, wallet2.address)).to.equal(0)
        })

        it("allows deposit for batchOperation when undercollateralized", async () => {
            await t.setupLiquidity(owner);
            await t.borrowAndWithdraw(wallet2, parseEther("100"), 1.05)
            // Now under collateralized
            await t.chainlink.setAnswer(parseEther("1"))
            await erc1155trade.connect(wallet2).batchOperation(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 1, amount: parseEther("1") }],
                []
            )

            expect(await escrow.cashBalances(1, wallet2.address)).to.equal(parseEther("1"))
        });

        it("allows trade (roll borrow) for batchOperationWithdraw [takeCurrentCash, takefCash]", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1]);

            // First borrow to establish an existing debt in maturity 0
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 0, amount: parseEther("10") }],
                [{
                    tradeType: TradeType.TakeCollateral,
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );
            expect(await t.hasCashPayer(wallet2, maturities[0], parseEther("100"))).to.be.true;

            // Now we first borrow in maturity[1] to get some cash and then we lend in maturity[0]
            // to close out the fCash position
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{
                    tradeType: TradeType.TakeCollateral,
                    cashGroup: 1,
                    maturity: maturities[1],
                    amount: parseEther("110"), // We have to borrow a bit more to ensure that we have enough cash
                    slippageData: "0x"
                }, {
                    tradeType: TradeType.TakeFutureCash,
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            expect(await t.hasCashPayer(wallet2, maturities[0])).to.be.false;
            expect(await t.hasCashPayer(wallet2, maturities[1], parseEther("110"))).to.be.true;
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(0)
        })

        it("allows repay borrow for batchOperationWithdraw using [takeCurrentCash] when cash balances are negative", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1]);

            // First borrow to establish an existing debt in maturity 0
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 0, amount: parseEther("10") }],
                [{
                    tradeType: TradeType.TakeCollateral,
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            await fastForwardToMaturity(provider, maturities[0])
            await portfolios.settleMaturedAssets(wallet2.address)
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(parseEther('-100'))

            // Borrowing 50 will repay the cash balance and withdraw nothing
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{
                    tradeType: TradeType.TakeCollateral,
                    cashGroup: 1,
                    maturity: maturities[1],
                    amount: parseEther("50"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            expect(await t.hasCashPayer(wallet2, maturities[1], parseEther("50"))).to.be.true;
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.below(parseEther('-50'))
        })

        it("allows repay to positive balance for batchOperationWithdraw using [takeCurrentCash] when cash balances are negative", async () => {
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1]);

            // First borrow to establish an existing debt in maturity 0
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [{ currencyId: 0, amount: parseEther("10") }],
                [{
                    tradeType: TradeType.TakeCollateral,
                    cashGroup: 1,
                    maturity: maturities[0],
                    amount: parseEther("100"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );

            await fastForwardToMaturity(provider, maturities[0])
            await portfolios.settleMaturedAssets(wallet2.address)
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(parseEther('-100'))

            const daiBalanceBefore = await dai.balanceOf(wallet2.address)
            await erc1155trade.connect(wallet2).batchOperationWithdraw(
                wallet2.address,
                BLOCK_TIME_LIMIT,
                [],
                [{
                    tradeType: TradeType.TakeCollateral,
                    cashGroup: 1,
                    maturity: maturities[1],
                    amount: parseEther("200"),
                    slippageData: "0x"
                }],
                [{
                    to: wallet2.address,
                    currencyId: 1,
                    amount: 0
                }],
            );
            const daiBalanceAfter = await dai.balanceOf(wallet2.address)

            expect(await t.hasCashPayer(wallet2, maturities[1], parseEther("200"))).to.be.true;
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(0)
            expect(daiBalanceAfter.sub(daiBalanceBefore)).to.above(parseEther('50'))
            expect(daiBalanceAfter.sub(daiBalanceBefore)).to.below(parseEther('100'))
        })
    });

    describe("block trades", async () => {
        let maturityLength: number;
        const depositType = { 
            name: 'deposits',
            type: 'tuple[]',
            components: [
                {
                    "internalType": "uint16",
                    "name": "currencyId",
                    "type": "uint16"
                },
                {
                    "internalType": "uint128",
                    "name": "amount",
                    "type": "uint128"
                }
            ]
        };
        let cashPayerAssetId: BigNumber;
        let cashReceiverAssetId: BigNumber;
        let cashPayerIdiosyncraticAssetId: BigNumber;
        let cashReceiverIdiosyncraticAssetId: BigNumber;

        beforeEach(async () => {
            await erc1155trade.setBridgeProxy(owner.address);
            maturityLength = await futureCash.G_MATURITY_LENGTH();
            cashPayerAssetId = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                1, 0, maturities[0], AssetType.CASH_PAYER
            )
            cashReceiverAssetId = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                1, 0, maturities[0], AssetType.CASH_RECEIVER
            )

            // Creates an idiosyncratic fCash group with a max period size of 1 year.
            await portfolios.createCashGroup(1, 31_536_000, 1e9, 1, AddressZero);

            cashPayerIdiosyncraticAssetId = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                2, 0, maturities[0] + 100, AssetType.CASH_PAYER
            )
            cashReceiverIdiosyncraticAssetId = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                2, 0, maturities[0] + 100, AssetType.CASH_RECEIVER
            )

            // This messes with the free collateral checks
            await escrow.connect(wallet).withdraw(dai.address, WeiPerEther.mul(1000));
        });

        it("allows the bridge proxy to call the function", async () => {
            const data = defaultAbiCoder.encode([depositType], [[]]);

            await expect(erc1155trade.connect(wallet).safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerAssetId,
                parseEther("100"),
                data
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        });

        it("operators must be approved by both from and to (or from == msg.sender)", async () => {
            const data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);
            await erc1155trade.connect(wallet2).setApprovalForAll(wallet.address, true);
            await expect(erc1155trade.connect(wallet).safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerAssetId,
                parseEther("100"),
                data
            )).to.be.not.be.reverted;

            await expect(erc1155trade.connect(wallet2).safeTransferFrom(
                wallet.address,
                owner.address,
                cashPayerAssetId,
                parseEther("100"),
                data
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UNAUTHORIZED_CALLER));

            await erc1155trade.connect(owner).setApprovalForAll(wallet2.address, true);
            await erc1155trade.connect(wallet).setApprovalForAll(wallet2.address, true);
            await expect(erc1155trade.connect(wallet2).safeTransferFrom(
                owner.address,
                wallet.address,
                cashPayerAssetId,
                parseEther("100"),
                data
            )).to.not.be.reverted;
        });

        it("allows cash group trade [deposit, cashReceiver]", async () => {
            const data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashReceiverAssetId,
                parseEther("100"),
                data
            );

            expect(await escrow.cashBalances(CURRENCY.ETH, wallet.address)).to.equal(parseEther("1.5"));
            expect(await t.hasCashPayer(wallet, maturities[0], parseEther("100"))).to.be.true;
            expect(await t.hasCashReceiver(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("allows cash group trade [deposit, cashPayer]", async () => {
            const data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerAssetId,
                parseEther("100"),
                data
            );

            expect(await escrow.cashBalances(CURRENCY.ETH, wallet2.address)).to.equal(parseEther("1.5"));
            expect(await t.hasCashPayer(wallet2, maturities[0], parseEther("100"))).to.be.true;
            expect(await t.hasCashReceiver(wallet, maturities[0], parseEther("100"))).to.be.true;
        });

        it("allows cash group trade [cashReceiver]", async () => {
            await escrow.connect(wallet).depositEth({value: parseEther("1.5")});

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashReceiverAssetId,
                parseEther("100"),
                '0x'
            );

            expect(await t.hasCashPayer(wallet, maturities[0], parseEther("100"))).to.be.true;
            expect(await t.hasCashReceiver(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("allows cash group trade [cashPayer]", async () => {
            await escrow.connect(wallet2).depositEth({value: parseEther("1.5")});

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerAssetId,
                parseEther("100"),
                "0x"
            );

            expect(await t.hasCashReceiver(wallet, maturities[0], parseEther("100"))).to.be.true;
            expect(await t.hasCashPayer(wallet2, maturities[0], parseEther("100"))).to.be.true;
        });

        it("reverts on liquidity token trade", async () => {
            const id = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                1, 0, maturities[0], AssetType.LIQUIDITY_TOKEN
            )
            await expect(erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                id,
                parseEther("100"),
                "0x"
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_SWAP));
        });

        it("reverts cash group trade on insufficient free collateral", async () => {
            await expect(erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashReceiverAssetId,
                parseEther("100"),
                "0x"
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));
        });

        it("reverts if maturity does not match cash group", async () => {
            const pastId = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                1, 0, maturityLength, AssetType.CASH_PAYER
            );

            const wrongPeriodSize = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                1, 0, maturities[0] + 100, AssetType.CASH_PAYER
            );

            const pastNumPeriods = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                1, 0, maturities[3] + 2 * maturityLength, AssetType.CASH_PAYER
            );

            await expect(erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                pastId,
                parseEther("100"),
                defaultAbiCoder.encode([depositType], [[{currencyId: 0, amount: parseEther("1.5")}]])
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_MATURITY_ALREADY_PASSED));

            await expect(erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                wrongPeriodSize,
                parseEther("100"),
                defaultAbiCoder.encode([depositType], [[{currencyId: 0, amount: parseEther("1.5")}]])
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_SWAP));

            await expect(erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                pastNumPeriods,
                parseEther("100"),
                defaultAbiCoder.encode([depositType], [[{currencyId: 0, amount: parseEther("1.5")}]])
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.PAST_MAX_MATURITY));
        });

        it("allows idiosyncratic trade [cashReceiver]", async () => {
            await escrow.connect(wallet).depositEth({value: parseEther("1.5")});

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashReceiverIdiosyncraticAssetId,
                parseEther("100"),
                "0x"
            );

            expect(await t.hasCashPayer(wallet, maturities[0] + 100, parseEther("100"))).to.be.true;
            expect(await t.hasCashReceiver(wallet2, maturities[0] + 100, parseEther("100"))).to.be.true;
        });

        it("allows idiosyncratic trade [cashPayer]", async () => {
            await escrow.connect(wallet2).depositEth({value: parseEther("1.5")});

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerIdiosyncraticAssetId,
                parseEther("100"),
                "0x"
            );

            expect(await t.hasCashPayer(wallet2, maturities[0] + 100, parseEther("100"))).to.be.true;
            expect(await t.hasCashReceiver(wallet, maturities[0] + 100, parseEther("100"))).to.be.true;
        });

        it("allows idiosyncratic trade [deposit, cashReceiver]", async () => {
            const data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashReceiverIdiosyncraticAssetId,
                parseEther("100"),
                data
            );

            expect(await escrow.cashBalances(CURRENCY.ETH, wallet.address)).to.equal(parseEther("1.5"));
            expect(await t.hasCashPayer(wallet, maturities[0] + 100, parseEther("100"))).to.be.true;
            expect(await t.hasCashReceiver(wallet2, maturities[0] + 100, parseEther("100"))).to.be.true;
        });

        it("allows idiosyncratic trade [deposit, cashPayer]", async () => {
            const data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerIdiosyncraticAssetId,
                parseEther("100"),
                data
            );

            expect(await escrow.cashBalances(CURRENCY.ETH, wallet2.address)).to.equal(parseEther("1.5"));
            expect(await t.hasCashReceiver(wallet, maturities[0] + 100, parseEther("100"))).to.be.true;
            expect(await t.hasCashPayer(wallet2, maturities[0] + 100, parseEther("100"))).to.be.true;
        });

        it("reverts idiosyncratic trade on insufficient free collateral", async () => {
            await expect(erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashReceiverIdiosyncraticAssetId,
                parseEther("100"),
                "0x"
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));
        });

        it("reverts idiosyncratic trade on over max length", async () => {
            const id = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                2, 0, BLOCK_TIME_LIMIT, AssetType.CASH_PAYER
            )
            const data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await expect(erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                id,
                parseEther("100"),
                data
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.PAST_MAX_MATURITY));
        });

        it("reverts idiosyncratic trade in the past", async () => {
            const id = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                2, 0, maturityLength + 100, AssetType.CASH_PAYER
            )
            const data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await expect(erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                id,
                parseEther("100"),
                data
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_MATURITY_ALREADY_PASSED));
        });

        it("reverts on an invalid fCash group", async () => {
            let id = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                0, 0, maturityLength + 100, AssetType.CASH_PAYER
            );

            let data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await expect(erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                id,
                parseEther("100"),
                data
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_CASH_GROUP));

            id = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                3, 0, maturityLength + 100, AssetType.CASH_PAYER
            );

            data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);
            
            await expect(erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                id,
                parseEther("100"),
                data
            )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_CASH_GROUP));
        });

        it("still settle idiosyncratic trades to cash balances", async () => { 
            const data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerIdiosyncraticAssetId,
                parseEther("100"),
                data
            );

            await fastForwardToMaturity(provider, maturities[0] + 100);
            await portfolios.settleMaturedAssetsBatch([wallet.address, wallet2.address]);

            expect(await escrow.cashBalances(1, wallet2.address)).to.equal(parseEther("-100"));
            expect(await escrow.cashBalances(1, wallet.address)).to.equal(parseEther("100"));
        });

        it("still successfully liquidates if trade is larger than AMM liquidity", async () => {
            const data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("300") }]]);

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerAssetId,
                parseEther("20000"), // There is only 10k in liquidity
                data
            );

            await chainlink.setAnswer(parseEther("0.012"));
            expect(await t.isCollateralized(wallet2)).to.be.false;
            await escrow.liquidate(wallet2.address, 0, 1, 0);
            expect(await t.isCollateralized(wallet2)).to.be.true;
        });

        it("still liquidates idiosyncratic trades", async () => {
            const data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("300") }]]);

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerIdiosyncraticAssetId,
                parseEther("20000"),
                data
            );

            await chainlink.setAnswer(parseEther("0.012"));
            expect(await t.isCollateralized(wallet2)).to.be.false;
            await escrow.liquidate(wallet2.address, 0, 1, 0);
            expect(await t.isCollateralized(wallet2)).to.be.true;
        });

        it("calculates free collateral properly when there are two cash groups with the same currency", async () => {
            let data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerIdiosyncraticAssetId,
                parseEther("100"),
                data
            );
            const fc = await portfolios.freeCollateralView(wallet2.address);

            data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerAssetId,
                parseEther("100"),
                data
            );

            expect((await portfolios.freeCollateralView(wallet2.address))[1][1]).to.equal(fc[1][1].mul(2));
        });

        it("idiosyncratic assets aggregate in a portfolio", async () => {
            let data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerIdiosyncraticAssetId,
                parseEther("100"),
                data
            );

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerIdiosyncraticAssetId,
                parseEther("100"),
                data
            );

            expect(await portfolios.getAssets(wallet.address)).to.have.lengthOf(1);
            expect(await portfolios.getAssets(wallet2.address)).to.have.lengthOf(1);
        });

        it("idiosyncratic assets do not net out in the risk formula", async () => {
            let data = defaultAbiCoder.encode([depositType], [[{ currencyId: 0, amount: parseEther("1.5") }]]);
            cashReceiverIdiosyncraticAssetId = await erc1155trade["encodeAssetId(uint8,uint16,uint32,bytes1)"](
                2, 0, maturities[0] + 200, AssetType.CASH_RECEIVER
            )

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashPayerIdiosyncraticAssetId,
                parseEther("100"),
                data
            );

            await erc1155trade.safeTransferFrom(
                wallet.address,
                wallet2.address,
                cashReceiverIdiosyncraticAssetId,
                parseEther("100"),
                data
            );

            expect((await portfolios.freeCollateralView(wallet.address))[1][CURRENCY.DAI]).to.equal(parseEther("-100"));
            expect((await portfolios.freeCollateralView(wallet2.address))[1][CURRENCY.DAI]).to.equal(parseEther("-100"));
        });
    });
});
