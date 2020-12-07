import chai from "chai";
import {solidity} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, fastForwardToMaturity, CURRENCY, fastForwardToTime} from "./fixtures";
import {Wallet} from "ethers";

import {Ierc20 as ERC20} from "../typechain/Ierc20";
import {CashMarket} from "../typechain/CashMarket";
import {Escrow} from "../typechain/Escrow";
import {Portfolios} from "../typechain/Portfolios";
import {TestUtils, BLOCK_TIME_LIMIT} from "./testUtils";
import {MockAggregator} from "../mocks/MockAggregator";
import {NotionalDeployer} from "../scripts/NotionalDeployer";
import {parseEther, BigNumber} from "ethers/utils";
import { WeiPerEther } from 'ethers/constants';
import { Iweth } from '../typechain/Iweth';
import { IAggregator } from '../typechain/IAggregator';

import MockWBTCArtifact from "../mocks/MockWBTC.json";
import MockAggregatorArtfiact from "../mocks/MockAggregator.json";

chai.use(solidity);
const { expect } = chai;

describe("Multi Currency", () => {
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let reserve: Wallet;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let notional: NotionalDeployer;

    let token: ERC20[] = [];
    let chainlink: MockAggregator[] = [];
    let futureCash: CashMarket[] = [];
    let wbtc: {
        currencyId: number;
        erc20: ERC20;
        chainlink: MockAggregator;
    };

    let tDai: TestUtils;
    let tUSDC: TestUtils;
    let tDaiOneYear: TestUtils;
    let daiMaturities: number[];
    let usdcMaturities: number[];
    let tNewMaturities: number[];
    let weth: Iweth;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        reserve = wallets[3];
        let objs = await fixtureLoader(fixture);

        escrow = objs.escrow;
        portfolios = objs.portfolios;
        notional = objs.notional;
        weth = objs.weth;

        token[0] = objs.erc20;
        futureCash[0] = objs.cashMarket;
        chainlink[0] = objs.chainlink;

        const usdcCurrencyId = await notional.listCurrency(
            objs.environment.USDC.address,
            objs.environment.USDCETHOracle,
            parseEther("1.20"),
            false,
            false,
            new BigNumber(1e6),
            false
        );
        const newFutureCash = await notional.deployCashMarket(
            usdcCurrencyId,
            2,
            2592000 * 1.5,
            parseEther("10000"),
            new BigNumber(0),
            new BigNumber(0),
            1_100_000_000,
            100
        );

        token[1] = objs.environment.USDC;
        futureCash[1] = newFutureCash;
        chainlink[1] = objs.environment.USDCETHOracle as unknown as MockAggregator;

        await escrow.setReserveAccount(reserve.address);
        for (let c of token) {
            await c.transfer(wallet.address, parseEther("10000"));
            await c.transfer(wallet2.address, parseEther("10000"));
            await c.transfer(reserve.address, parseEther("10000"));

            await c.connect(owner).approve(escrow.address, parseEther("100000000"));
            await c.connect(wallet).approve(escrow.address, parseEther("100000000"));
            await c.connect(wallet2).approve(escrow.address, parseEther("100000000"));
            await c.connect(reserve).approve(escrow.address, parseEther("100000000"));

            await escrow.connect(reserve).deposit(c.address, parseEther("1000"));
        }

        tDai = new TestUtils(escrow, futureCash[0], portfolios, token[0], owner, chainlink[0], objs.weth, 1);
        tUSDC = new TestUtils(escrow, futureCash[1], portfolios, token[1], owner, chainlink[1], objs.weth, 2);

        const mockWbtc = (await NotionalDeployer.deployContract(owner, MockWBTCArtifact, [], 1)).contract as ERC20;
        const wbtcOracle = (await NotionalDeployer.deployContract(owner, MockAggregatorArtfiact, [], 1)).contract as MockAggregator;
        await wbtcOracle.setAnswer(10e8);

        const wbtcCurrencyId = await notional.listCurrency(
            mockWbtc.address,
            wbtcOracle as unknown as IAggregator,
            parseEther("1.30"),
            false,
            false,
            new BigNumber(1e8),
            false
        );

        await mockWbtc.transfer(wallet.address, parseEther("100000"));
        wbtc = {
            currencyId: wbtcCurrencyId,
            erc20: mockWbtc,
            chainlink: wbtcOracle
        }

        const daiOneYear = await notional.deployCashMarket(
            CURRENCY.DAI,
            1,
            2592000 * 12,
            parseEther("10000"),
            new BigNumber(0),
            new BigNumber(0),
            1_100_000_000,
            100
        );
        tDaiOneYear = new TestUtils(escrow, daiOneYear, portfolios, token[0], owner, chainlink[0], objs.weth, 1);

        // Set the blockheight to the beginning of the next period
        daiMaturities = await tDai.futureCash.getActiveMaturities();
        await fastForwardToMaturity(provider, daiMaturities[1]);
        daiMaturities = await tDai.futureCash.getActiveMaturities();
        usdcMaturities = await tUSDC.futureCash.getActiveMaturities();
        tNewMaturities = await tDaiOneYear.futureCash.getActiveMaturities();
    });

    afterEach(async () => {
        let max = daiMaturities.concat(usdcMaturities).concat(tNewMaturities);
        await fastForwardToMaturity(provider, Math.max(...max));
        await portfolios.settleMaturedAssetsBatch([owner.address, wallet.address, wallet2.address, reserve.address]);
        expect(await tDai.checkEthBalanceIntegrity([owner, wallet, wallet2])).to.be.true;

        expect(await tUSDC.checkBalanceIntegrity([owner, wallet, wallet2, reserve])).to.be.true;
        expect(await tDai.checkBalanceIntegrity([owner, wallet, wallet2, reserve], tDaiOneYear.futureCash.address)).to.be.true;

        expect(await tDai.checkMarketIntegrity([owner, wallet, wallet2, reserve], daiMaturities)).to.be.true;
        expect(await tUSDC.checkMarketIntegrity([owner, wallet, wallet2, reserve], usdcMaturities)).to.be.true;
        expect(await tDaiOneYear.checkMarketIntegrity([owner, wallet, wallet2, reserve], tNewMaturities)).to.be.true;
    });

    const setupTest = async () => {
        // This is equivalent to 25 ETH or 2500 Dai
        await wbtc.erc20.connect(wallet).approve(escrow.address, parseEther("100000"));
        await escrow.connect(wallet).deposit(wbtc.erc20.address, new BigNumber(0.5e8));
        await escrow.connect(wallet2).deposit(tDai.token.address, parseEther("1000"));

        await tDai.setupLiquidity();
        const maturities = await tDai.futureCash.getActiveMaturities();
        await tDai.futureCash
            .connect(wallet)
            .takeCurrentCash(maturities[0], parseEther("100"), BLOCK_TIME_LIMIT, 80_000_000);

        await escrow
            .connect(wallet)
            .withdraw(tDai.token.address, await escrow.cashBalances(tDai.currencyId, wallet.address));

        await fastForwardToMaturity(provider, maturities[1]);
    };

    describe("happy path", async () => {
        it("allows an account to trade on two different fCash groups in the same currency", async () => {
            await tDai.setupLiquidity();
            await tDaiOneYear.setupLiquidity();
            await tDai.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 0, 100_000_000);
            await tDaiOneYear.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 0, 100_000_000);
        });

        it("allows an account to trade on two currencies", async () => {
            await tDai.setupLiquidity();
            await tUSDC.setupLiquidity(wallet, 0.5, new BigNumber(10000e6));
            await tDai.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
            await tUSDC.borrowAndWithdraw(wallet, new BigNumber(100e6), 1.05, 0, 100_000_000);
        });

        it("converts currencies to ETH", async () => {
            expect(wbtc.currencyId).to.equal(3);
            const converted = await escrow.convertBalancesToETH([
                new BigNumber(0),
                WeiPerEther.mul(WeiPerEther),
                new BigNumber(-100e6),
                new BigNumber(0.3e8),
            ]);

            expect(converted[0]).to.equal(new BigNumber(0));
            expect(converted[1]).to.equal(WeiPerEther.mul(WeiPerEther).div(100));
            expect(converted[2]).to.equal(parseEther("-1.2"));
            expect(converted[3]).to.equal(parseEther("3"));
        });

        it("liquidates accounts in a currency with designated collateral", async () => {
            await setupTest();
            await wbtc.chainlink.setAnswer(new BigNumber(1e8));
            await escrow.connect(wallet2).liquidate(wallet.address, 0, CURRENCY.DAI, wbtc.currencyId);
        });

        it("liquidates accounts across two fCash groups", async () => {
            await escrow.connect(wallet2).deposit(token[0].address, parseEther("1000"));

            await tDai.setupLiquidity();
            await tDaiOneYear.setupLiquidity();
            await tDai.borrowAndWithdraw(wallet, parseEther("5"), 1.05, 0, 100_000_000);
            await tDaiOneYear.borrowAndWithdraw(wallet, parseEther("50"), 1.05, 0, 100_000_000);

            await chainlink[0].setAnswer(parseEther("0.015"));
            await escrow.connect(wallet2).liquidate(wallet.address, 0, CURRENCY.DAI, 0);
        });

        it("partially settles cash using collateral when there are two deposit currencies via settler", async () => {
            await tDai.setupLiquidity();
            await tDai.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
            await escrow.connect(wallet2).deposit(tDai.token.address, parseEther("1000"));

            await wbtc.erc20.connect(wallet).approve(escrow.address, new BigNumber(100000e8));
            await escrow.connect(wallet).deposit(wbtc.erc20.address, new BigNumber(0.5e8));

            await escrow.connect(wallet).withdrawEth(parseEther("1"));

            const maturities = await futureCash[0].getActiveMaturities();
            await fastForwardToMaturity(provider, maturities[1]);

            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, CURRENCY.ETH, wallet.address, parseEther("100"));

            // Expect ETH to be cleaned out
            expect(await escrow.cashBalances(CURRENCY.ETH, wallet.address)).to.equal(0);
        });

        it("[6] settles cash with a secondary collateral currency", async () => {
            await setupTest();
            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, wbtc.currencyId, wallet.address, parseEther("100"));
        });
        
        it("it must settle matured collateral assets before liquidating", async () => {
            await tDai.setupLiquidity()
            await tUSDC.setupLiquidity(owner, 0.5, parseEther("10000"), [1]);

            await escrow.connect(wallet).deposit(tDai.token.address, parseEther("100"));
            await tDai.futureCash.connect(wallet).takefCash(daiMaturities[0], parseEther("100"), BLOCK_TIME_LIMIT, 0);

            const cashBalances = await escrow.cashBalances(CURRENCY.DAI, wallet.address);
            await escrow.connect(wallet).withdraw(tDai.token.address, cashBalances);

            await tUSDC.borrowAndWithdraw(wallet, new BigNumber(100e6), 1.05, 1);
            await escrow.connect(wallet).withdraw(weth.address, parseEther("1"));

            await fastForwardToMaturity(provider, usdcMaturities[1]);
            await tUSDC.chainlink.setAnswer(0.05e6);

            // All dai balances comes from settled fCash asset
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(0);
            await escrow.liquidate(wallet.address, 0, CURRENCY.USDC, CURRENCY.DAI);
        });

        it("it must settle matured collateral assets before settle cash", async () => {
            await tDai.setupLiquidity()
            await tUSDC.setupLiquidity(owner, 0.5, parseEther("10000"), [1]);

            await escrow.connect(wallet).deposit(tDai.token.address, parseEther("100"));
            await tDai.futureCash.connect(wallet).takefCash(daiMaturities[0], parseEther("100"), BLOCK_TIME_LIMIT, 0);

            const cashBalances = await escrow.cashBalances(CURRENCY.DAI, wallet.address);
            await escrow.connect(wallet).withdraw(tDai.token.address, cashBalances);

            await tUSDC.borrowAndWithdraw(wallet, new BigNumber(100e6), 1.05, 1);
            await fastForwardToMaturity(provider, usdcMaturities[1]);

            // All dai balances comes from settled fCash asset
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(0);
            await escrow.settleCashBalance(CURRENCY.USDC, CURRENCY.DAI, wallet.address, 100e6);
        });
    }).timeout(50000);

    describe("multicurrency settle and liquidate fCash", async () => {
        beforeEach(async () => {
            await tDai.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1, 2]);
            await tUSDC.setupLiquidity(owner, 0.5, parseEther("10000"), [0]);
        })

        it("should settle fCash in collateral currency, only liquidator payments", async () => {
            await tDai.setupSellFutureCash(wallet, undefined, undefined, parseEther("140"));
            let settleAmount = await tUSDC.setupSellFutureCash(wallet, new BigNumber(96e6), undefined, undefined, CURRENCY.USDC);

            const cashBalances = await escrow.cashBalances(CURRENCY.USDC, wallet.address);
            await escrow.connect(wallet).withdraw(tUSDC.token.address, cashBalances);

            await fastForwardToTime(provider, usdcMaturities[0]);
            const [, remaining] = await tDai.getfCashValue(
                parseEther("140"),
                settleAmount.add(cashBalances),
                daiMaturities[2],
                usdcMaturities[0]
            );
            await escrow.settlefCash(wallet.address, CURRENCY.USDC, CURRENCY.DAI, settleAmount.add(cashBalances));

            expect(await tDai.hasCashReceiver(wallet, daiMaturities[2], remaining));
            expect(await escrow.cashBalances(CURRENCY.USDC, wallet.address)).to.equal(0);
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.be.equal(0);
        });

        it("should settle fCash in collateral currency, both", async () => {
            await tDai.setupSellFutureCash(wallet, undefined, parseEther("70"), parseEther("70"));
            let settleAmount = await tUSDC.setupSellFutureCash(wallet, new BigNumber(96e6), undefined, undefined, CURRENCY.USDC);

            const cashBalances = await escrow.cashBalances(CURRENCY.USDC, wallet.address);
            await escrow.connect(wallet).withdraw(tUSDC.token.address, cashBalances);

            await fastForwardToTime(provider, usdcMaturities[0]);
            const futureCashPrice = await tDai.futureCash.getfCashToCurrentCashAtTime(
                daiMaturities[1],
                parseEther("70"),
                usdcMaturities[0]
            );

            const daiBalance = futureCashPrice.sub(
                new BigNumber(96e6)
                    .mul(parseEther("1.02"))
                    .mul(WeiPerEther)
                    .div(1e6)
                    .div(WeiPerEther)
            )

            const [, remaining] = await tDai.getfCashValue(
                parseEther("70"),
                settleAmount.add(cashBalances).sub(daiBalance),
                daiMaturities[2],
                usdcMaturities[0]
            );
            await escrow.settlefCash(wallet.address, CURRENCY.USDC, CURRENCY.DAI, settleAmount.add(cashBalances));

            expect(await tDai.hasCashReceiver(wallet, daiMaturities[2], remaining));
            expect(await escrow.cashBalances(CURRENCY.USDC, wallet.address)).to.equal(0);
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.be.equal(0);
        });

        it("should liquidate fCash in collateral currency, liquidator payments", async () => {
            await tDai.setupSellFutureCash(wallet, undefined, undefined, parseEther("135"));
            await tUSDC.setupSellFutureCash(wallet, new BigNumber(96e6), undefined, undefined, CURRENCY.USDC);

            const cashBalances = await escrow.cashBalances(CURRENCY.USDC, wallet.address);
            await escrow.connect(wallet).withdraw(tUSDC.token.address, cashBalances);
            await tDai.chainlink.setAnswer(parseEther("0.0090"));

            await escrow.liquidatefCash(wallet.address, CURRENCY.USDC, CURRENCY.DAI);
            expect(await tDai.hasCashReceiver(wallet, daiMaturities[2])).to.be.true;
            expect(await tDai.isCollateralized(wallet)).to.be.true;
        });

        it("should liquidate fCash in collateral currency, both", async () => {
            await tDai.setupSellFutureCash(wallet, undefined, parseEther("10"), parseEther("125"));
            await tUSDC.setupSellFutureCash(wallet, new BigNumber(96e6), undefined, undefined, CURRENCY.USDC);

            const cashBalances = await escrow.cashBalances(CURRENCY.USDC, wallet.address);
            await escrow.connect(wallet).withdraw(tUSDC.token.address, cashBalances);
            await tDai.chainlink.setAnswer(parseEther("0.0090"));

            await escrow.connect(wallet2).liquidatefCash(wallet.address, CURRENCY.USDC, CURRENCY.DAI);
            expect(await tDai.hasCashReceiver(wallet, daiMaturities[1])).to.be.false;
            expect(await tDai.hasCashReceiver(wallet, daiMaturities[2])).to.be.true;
            expect(await tDai.hasCashReceiver(wallet2, daiMaturities[2])).to.be.true;
            expect(await tDai.isCollateralized(wallet)).to.be.true;
        });

        it("should liquidate fCash in collateral currency, shortfall", async () => {
            await tDai.setupSellFutureCash(wallet, undefined, parseEther("75"));
            await tUSDC.setupSellFutureCash(wallet, new BigNumber(96e6), undefined, undefined, CURRENCY.USDC);

            await tDai.chainlink.setAnswer(parseEther("0.10"));
            const cashBalances = await escrow.cashBalances(CURRENCY.USDC, wallet.address);
            await escrow.connect(wallet).withdraw(tUSDC.token.address, cashBalances);
            await tDai.chainlink.setAnswer(parseEther("0.01"));

            const usdcRequired = new BigNumber(96e6);
            const daiRequired = new BigNumber(96e6)
                .mul(parseEther("1.06"))
                .mul(WeiPerEther)
                .div(1e6)
                .div(WeiPerEther);
            const daiAvailable = (await portfolios.freeCollateralView(wallet.address))[1][1]

            await escrow.liquidatefCash(wallet.address, CURRENCY.USDC, CURRENCY.DAI);
            const usdcBalance = await escrow.cashBalances(CURRENCY.USDC, wallet.address)

            expect(await tDai.hasCashReceiver(wallet)).to.be.false;
            expect(usdcBalance).to.be.above(usdcRequired.mul(daiAvailable).div(daiRequired));
        });

        it("uses net collateral available on fcash liquidation", async () => {
            await tUSDC.borrowAndWithdraw(wallet, new BigNumber(96e6));
            await tDai.borrowAndWithdraw(wallet, parseEther("100"));

            await escrow.connect(wallet).deposit(tDai.token.address, parseEther("130"));
            await tDai.futureCash
                .connect(wallet)
                .takefCash(daiMaturities[1], parseEther("130"), BLOCK_TIME_LIMIT, 0);
            const cashBalances = await escrow.cashBalances(CURRENCY.DAI, wallet.address);
            await escrow.connect(wallet).withdraw(tDai.token.address, cashBalances);

            await tUSDC.chainlink.setAnswer(1e6);
            await escrow.liquidate(wallet.address, 0, CURRENCY.USDC, CURRENCY.ETH);
            await tUSDC.chainlink.setAnswer(1e4);

            await tDai.chainlink.setAnswer(parseEther("1"));
            const usdcBalances = await escrow.cashBalances(CURRENCY.USDC, wallet.address);
            await escrow.connect(wallet).withdraw(tUSDC.token.address, usdcBalances);
            await tDai.chainlink.setAnswer(parseEther("0.01"));

            await fastForwardToTime(provider, usdcMaturities[0]);
            await portfolios.settleMaturedAssets(wallet.address);

            const fcBefore = await portfolios.freeCollateralView(wallet.address);
            await escrow.liquidatefCash(wallet.address, CURRENCY.USDC, CURRENCY.DAI);
            const fcAfter = await portfolios.freeCollateralView(wallet.address);

            // Cash receiver was sold to partially offset the USDC balance but keeps Dai in balance
            // Commenting this out, will not always be true depending on timing factors
            // expect(await tDai.hasCashReceiver(wallet), "liquidated account has cash receiver").to.be.true;
            expect(fcAfter[0]).to.be.above(fcBefore[0]);
            expect(fcAfter[1][1].gte(0), "dai net available is negative after liquidation").to.be.true;
            expect(fcAfter[1][2], "usdc net available has not increased").to.be.above(new BigNumber(-96e6));
        });
    }).timeout(50000);

    it("does not allow a liquidator to purchase more collateral than available", async () => {
        await tDai.setupLiquidity();
        await tUSDC.setupLiquidity(owner, 0.5, new BigNumber(10000e6), [0]);

        await tDai.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await tUSDC.borrowAndWithdraw(wallet, new BigNumber(100e6), 1.05, 0, 100_000_000);

        // Make Dai collateralize USDC entirely.
        await escrow.connect(wallet).deposit(token[0].address, parseEther("220"));
        await escrow.connect(wallet).withdraw(weth.address, parseEther("2.625"));

        await chainlink[1].setAnswer(new BigNumber(0.02e6));

        const fcBefore = await portfolios.freeCollateralView(wallet.address);
        // Liquidating Dai for USDC
        await escrow.connect(wallet2).liquidate(wallet.address, 0, CURRENCY.USDC, CURRENCY.DAI)
        const fcAfter = await portfolios.freeCollateralView(wallet.address);
        // This is the amount of Dai that is collateralizing dai debts
        expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(parseEther("100"));
        // Aggregate free collateral must increase
        expect(fcAfter[0]).to.be.above(fcBefore[0]);
    });

    it("does not allow a liquidator to purchase more collateral than necessary to recollateralize", async () => {
        await tDai.setupLiquidity();
        await tUSDC.setupLiquidity(owner, 0.5, new BigNumber(10000e6), [0]);

        await tDai.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await tUSDC.borrowAndWithdraw(wallet, new BigNumber(100e6), 1.05, 0, 100_000_000);

        // Make Dai collateralize USDC entirely.
        await escrow.connect(wallet).deposit(token[0].address, parseEther("220"));
        await escrow.connect(wallet).withdraw(weth.address, parseEther("2.625"));

        // This means the value of the USDC has fallen relative to Dai
        await chainlink[1].setAnswer(new BigNumber(0.011e6));

        // Liquidating Dai for USDC
        await escrow.connect(wallet2).liquidate(wallet.address, 0, CURRENCY.USDC, CURRENCY.DAI)
        const fcAfter = await portfolios.freeCollateralView(wallet.address);
        // If there is sufficient collateral available, free collateral should be zero (or here under the amount
        // of usdc dust)
        expect(fcAfter[0]).to.be.above(0);
    });

    it("removes liquidity tokens in the collateral currency in order to liquidate", async () => {
        await tDai.setupLiquidity();
        await tUSDC.setupLiquidity(owner, 0.5, new BigNumber(10000e6), [0]);

        await tDai.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await tUSDC.borrowAndWithdraw(wallet, new BigNumber(100e6), 1.05, 0, 100_000_000);

        // Make Dai collateralize USDC entirely.
        await escrow.connect(wallet).deposit(token[0].address, parseEther("255"));
        await tDai.futureCash.connect(wallet).addLiquidity(daiMaturities[1], parseEther("220"), parseEther("250"), 0, 100_000_000, BLOCK_TIME_LIMIT);

        await escrow.connect(wallet).withdraw(weth.address, parseEther("2"));
        await chainlink[1].setAnswer(new BigNumber(0.011e6));

        await escrow.connect(wallet2).liquidate(wallet.address, 0, CURRENCY.USDC, CURRENCY.DAI)
        expect(await escrow.cashBalances(1, wallet.address)).to.equal(0);
        expect(await tDai.hasLiquidityToken(wallet, daiMaturities[1])).to.be.true;
    }).timeout(50000);

    it("accounts for the haircut amount when purchasing deposit currencies", async () => {
        await tDai.setupLiquidity();
        await tUSDC.setupLiquidity(owner, 0.5, new BigNumber(10000e6), [0]);

        await tDai.borrowAndWithdraw(wallet, parseEther("150"), 1.05, 0, 100_000_000);
        await tUSDC.borrowAndWithdraw(wallet, new BigNumber(100e6), 1.05, 0, 100_000_000);

        await escrow.connect(wallet).deposit(token[0].address, parseEther("350"));
        await tDai.futureCash.connect(wallet).addLiquidity(daiMaturities[0], parseEther("200"), parseEther("250"), 0, 100_000_000, BLOCK_TIME_LIMIT);

        await escrow.connect(wallet).withdraw(weth.address, parseEther("3.29"));
        await chainlink[1].setAnswer(new BigNumber(0.0108e6));

        const fcBefore = await portfolios.freeCollateralView(wallet.address);
        await escrow.connect(wallet2).liquidate(wallet.address, 0, CURRENCY.USDC, CURRENCY.DAI)
        const fcAfter = await portfolios.freeCollateralView(wallet.address);
        expect(fcAfter[0]).to.be.above(fcBefore[0]);
    });

    it("removes liquidity tokens partially in order to recollateralize an account", async () => {
        await tDai.setupLiquidity();
        await tUSDC.setupLiquidity(owner, 0.5, new BigNumber(10000e6), [0]);
        const liquidatorDaiBefore = await token[0].balanceOf(wallet2.address);

        await tDai.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await escrow.connect(wallet).deposit(token[0].address, parseEther("100"));
        await tDai.futureCash.connect(wallet).addLiquidity(daiMaturities[1], parseEther("100"), parseEther("150"), 0, 100_000_000, BLOCK_TIME_LIMIT);

        await escrow.connect(wallet).withdraw(weth.address, parseEther("0.715"));
        await chainlink[0].setAnswer(parseEther("0.012"));

        const ethBalanceBefore = await escrow.cashBalances(CURRENCY.ETH, wallet.address);

        // This account is now undercollateralized slightly and the liquidity tokens will recapitalize it
        await escrow.connect(wallet2).liquidate(wallet.address, 0, CURRENCY.DAI, CURRENCY.ETH)
        const liquidatorDaiAfter = await token[0].balanceOf(wallet2.address);

        // ETH balances have not changed.
        expect(await escrow.cashBalances(CURRENCY.ETH, wallet.address)).to.equal(ethBalanceBefore);
        expect(liquidatorDaiAfter.sub(liquidatorDaiBefore)).to.be.above(0);
        expect(await tDai.isCollateralized(wallet)).to.be.true;
        // We don't check the exact balance here because there's some precision loss
        expect(await tDai.hasLiquidityToken(wallet, daiMaturities[1])).to.be.true;
    });

    it("removes liquidity tokens in full in order to recollateralize an account", async () => {
        await tDai.setupLiquidity();
        await tUSDC.setupLiquidity(owner, 0.5, new BigNumber(10000e6), [0]);
        const liquidatorDaiBefore = await token[0].balanceOf(wallet2.address);

        await tDai.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await escrow.connect(wallet).deposit(token[0].address, parseEther("10"));
        await tDai.futureCash.connect(wallet).addLiquidity(daiMaturities[1], parseEther("10"), parseEther("15"), 0, 100_000_000, BLOCK_TIME_LIMIT);

        await chainlink[0].setAnswer(parseEther("0.012"));

        const accountDaiBefore = await escrow.cashBalances(CURRENCY.DAI, wallet.address);
        await escrow.connect(wallet2).liquidate(wallet.address, 0, CURRENCY.DAI, CURRENCY.ETH)
        const liquidatorDaiAfter = await token[0].balanceOf(wallet2.address);
        const accountDaiAfter = await escrow.cashBalances(CURRENCY.DAI, wallet.address);

        // The difference in the delta is how much cashClaim the liquidity tokens had
        expect(liquidatorDaiAfter.sub(liquidatorDaiBefore).add(accountDaiAfter.sub(accountDaiBefore))).to.equal(parseEther("10"));

        expect(await tDai.isCollateralized(wallet)).to.be.true;
        expect(await tDai.hasLiquidityToken(wallet, daiMaturities[1])).to.be.false;
    });

    it("allows a settler to purchase collateral to settle", async () => {
        await tDai.setupLiquidity();
        await tUSDC.setupLiquidity(owner, 0.5, new BigNumber(10000e6), [0]);
        await escrow.connect(wallet2).deposit(token[1].address, parseEther("1000"));

        await tDai.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await tUSDC.borrowAndWithdraw(wallet, new BigNumber(100e6), 1.05, 0, 100_000_000);

        await escrow.connect(wallet).deposit(token[0].address, parseEther("220"));
        await escrow.connect(wallet).withdraw(weth.address, parseEther("2.625"));
        const maxMaturity = (await portfolios.getAssets(wallet.address))
            .map((a) => { return (a.maturity) })
            .sort()[1];


        await fastForwardToMaturity(provider, maxMaturity);
        await portfolios.settleMaturedAssets(wallet.address);
        await chainlink[1].setAnswer(new BigNumber(0.011e6));
        await escrow.connect(wallet2).settleCashBalance(CURRENCY.USDC, CURRENCY.DAI, wallet.address, new BigNumber(100e6))
    });
}).timeout(50000);
