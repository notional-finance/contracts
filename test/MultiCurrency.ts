import chai from "chai";
import {solidity} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, fastForwardToMaturity, CURRENCY} from "./fixtures";
import {Wallet} from "ethers";

import {Erc20 as ERC20} from "../typechain/Erc20";
import {FutureCash} from "../typechain/FutureCash";
import {Escrow} from "../typechain/Escrow";
import {Portfolios} from "../typechain/Portfolios";
import {TestUtils, BLOCK_TIME_LIMIT} from "./testUtils";
import {MockAggregator} from "../typechain/MockAggregator";
import {SwapnetDeployer} from "../scripts/SwapnetDeployer";
import {parseEther, BigNumber} from "ethers/utils";
import { WeiPerEther } from 'ethers/constants';
import { Iweth } from '../typechain/Iweth';

chai.use(solidity);
const { expect } = chai;

describe("Multi Currency", () => {
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let reserve: Wallet;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let swapnet: SwapnetDeployer;

    let token: ERC20[] = [];
    let chainlink: MockAggregator[] = [];
    let futureCash: FutureCash[] = [];
    let wbtc: {
        currencyId: number;
        erc20: ERC20;
        chainlink: MockAggregator;
    };

    let t1: TestUtils;
    let t2: TestUtils;
    let tNew: TestUtils;
    let t1Maturities: number[];
    let t2Maturities: number[];
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
        swapnet = objs.swapnet;
        weth = objs.weth;

        token[0] = objs.erc20;
        futureCash[0] = objs.futureCash;
        chainlink[0] = objs.chainlink;

        const newCurrency = await swapnet.deployMockCurrency(
            parseEther("0.01"),
            parseEther("1.20")
        );
        const newFutureCash = await swapnet.deployFutureCashMarket(
            newCurrency.currencyId,
            2,
            2592000 * 1.5,
            parseEther("10000"),
            new BigNumber(0),
            new BigNumber(0),
            1e9,
            1_100_000_000,
            100
        );

        token[1] = newCurrency.erc20;
        futureCash[1] = newFutureCash;
        chainlink[1] = newCurrency.chainlink;

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

        t1 = new TestUtils(escrow, futureCash[0], portfolios, token[0], owner, chainlink[0], objs.weth, 1);
        t2 = new TestUtils(escrow, futureCash[1], portfolios, token[1], owner, chainlink[1], objs.weth, 2);

        wbtc = await swapnet.deployMockCurrency(
            parseEther("10"),
            parseEther("1.3")
        );
        await wbtc.erc20.transfer(wallet.address, parseEther("100000"));

        const futureCashNew = await swapnet.deployFutureCashMarket(
            CURRENCY.DAI,
            1,
            2592000 * 3,
            parseEther("10000"),
            new BigNumber(0),
            new BigNumber(0),
            1e9,
            1_100_000_000,
            100
        );
        tNew = new TestUtils(escrow, futureCashNew, portfolios, token[0], owner, chainlink[0], objs.weth, 1);

        // Set the blockheight to the beginning of the next period
        t1Maturities = await t1.futureCash.getActiveMaturities();
        await fastForwardToMaturity(provider, t1Maturities[1]);
        t1Maturities = await t1.futureCash.getActiveMaturities();
        t2Maturities = await t2.futureCash.getActiveMaturities();
        tNewMaturities = await tNew.futureCash.getActiveMaturities();
    });

    afterEach(async () => {
        expect(await t1.checkEthBalanceIntegrity([owner, wallet, wallet2])).to.be.true;

        expect(await t1.checkBalanceIntegrity([owner, wallet, wallet2, reserve], tNew.futureCash.address)).to.be.true;
        expect(await t2.checkBalanceIntegrity([owner, wallet, wallet2, reserve])).to.be.true;

        expect(await t1.checkMarketIntegrity([owner, wallet, wallet2, reserve], t1Maturities)).to.be.true;
        expect(await t2.checkMarketIntegrity([owner, wallet, wallet2, reserve], t2Maturities)).to.be.true;
        expect(await tNew.checkMarketIntegrity([owner, wallet, wallet2, reserve], tNewMaturities)).to.be.true;
    });

    const setupTest = async () => {
        // This is equivalent to 25 ETH or 2500 Dai
        await wbtc.erc20.connect(wallet).approve(escrow.address, parseEther("100000"));
        await escrow.connect(wallet).deposit(wbtc.erc20.address, parseEther("0.5"));
        await escrow.connect(wallet2).deposit(t1.dai.address, parseEther("1000"));

        await t1.setupLiquidity();
        const maturities = await t1.futureCash.getActiveMaturities();
        await t1.futureCash
            .connect(wallet)
            .takeCollateral(maturities[0], parseEther("100"), BLOCK_TIME_LIMIT, 80_000_000);

        await escrow
            .connect(wallet)
            .withdraw(t1.dai.address, await escrow.cashBalances(t1.currencyId, wallet.address));

        await fastForwardToMaturity(provider, maturities[1]);
    };

    describe("happy path", async () => {
        it("allows an account to trade on two different future cash groups in the same currency", async () => {
            await t1.setupLiquidity();
            await tNew.setupLiquidity();
            await t1.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 0, 100_000_000);
            await tNew.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 0, 100_000_000);
        });

        it("allows an account to trade on two currencies", async () => {
            await t1.setupLiquidity();
            await t2.setupLiquidity();
            await t1.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
            await t2.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        });

        it("converts currencies to ETH", async () => {
            expect(wbtc.currencyId).to.equal(3);
            const converted = await escrow.convertBalancesToETH([
                new BigNumber(0),
                WeiPerEther.mul(WeiPerEther),
                parseEther("-100"),
                parseEther("0.3")
            ]);

            expect(converted[0]).to.equal(new BigNumber(0));
            expect(converted[1]).to.equal(WeiPerEther.mul(WeiPerEther).div(100));
            expect(converted[2]).to.equal(parseEther("-1.2"));
            expect(converted[3]).to.equal(parseEther("3"));
        });

        it("liquidates accounts in a currency with designated collateral", async () => {
            await setupTest();
            await wbtc.chainlink.setAnswer(parseEther("1"));
            await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, wbtc.currencyId);
        });

        it("liquidates accounts across two future cash groups", async () => {
            await escrow.connect(wallet2).deposit(token[0].address, parseEther("1000"));

            await t1.setupLiquidity();
            await tNew.setupLiquidity();
            await t1.borrowAndWithdraw(wallet, parseEther("5"), 1.05, 0, 100_000_000);
            await tNew.borrowAndWithdraw(wallet, parseEther("50"), 1.05, 0, 100_000_000);

            await chainlink[0].setAnswer(parseEther("0.015"));
            await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, 0);
        });

        it("partially settles cash using collateral when there are two deposit currencies via settler", async () => {
            await t1.setupLiquidity();
            await t1.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
            await escrow.connect(wallet2).deposit(t1.dai.address, parseEther("1000"));
            await wbtc.erc20.connect(wallet).approve(escrow.address, parseEther("100000"));
            await escrow.connect(wallet).deposit(wbtc.erc20.address, parseEther("0.5"));
            await escrow.connect(wallet).withdrawEth(parseEther("1"));

            const maturities = await futureCash[0].getActiveMaturities();
            await fastForwardToMaturity(provider, maturities[1]);

            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, CURRENCY.ETH, wallet.address, parseEther("100"));

            // Expect ETH to be cleaned out
            expect(await escrow.cashBalances(CURRENCY.ETH, wallet.address)).to.equal(0);
        });
    });

    // See flow chart at ../docs/SettleCash.png
    describe("settle cash situations [4-8]", async () => {
        it("[4] does not settle cash with the reserve account if the account has collateral", async () => {
            await setupTest();
            await wbtc.chainlink.setAnswer(parseEther("1"));
            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, wbtc.currencyId, wallet.address, parseEther("100"));
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(parseEther("-100"));
        });

        it("[6] settles cash with a secondary deposit currency", async () => {
            await setupTest();
            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, wbtc.currencyId, wallet.address, parseEther("100"));
        });

        it("[7] settles cash with the reserve account when the account is insolvent", async () => {
            await setupTest();
            await wbtc.chainlink.setAnswer(parseEther("1"));
            // liquidate to clear out the BTC
            await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, wbtc.currencyId);

            // deposit eth
            expect(await escrow.cashBalances(CURRENCY.WBTC, wallet.address)).to.equal(0);
            const cashBalance = await escrow.cashBalances(CURRENCY.DAI, wallet.address);
            const reserveBalance = await escrow.cashBalances(t1.currencyId, reserve.address);

            // This will settle via the reserve account
            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, wbtc.currencyId, wallet.address, cashBalance.mul(-1));
            expect(await escrow.cashBalances(t1.currencyId, reserve.address)).to.equal(
                reserveBalance.add(cashBalance)
            );
        });

        it("[8] does not settle cash with the reserve account if the account has future cash", async () => {
            await setupTest();

            await t2.setupLiquidity(owner, 0.5, parseEther("10000"), [1]);
            await escrow.connect(wallet).deposit(t2.dai.address, parseEther("100"));
            const maturities = await t2.futureCash.getActiveMaturities();
            await t2.futureCash.connect(wallet).takeFutureCash(maturities[1], parseEther("100"), BLOCK_TIME_LIMIT, 0);

            await wbtc.chainlink.setAnswer(parseEther("1.5"));

            // liquidate to clear out the BTC
            await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, wbtc.currencyId);

            const cashBalance = await escrow.cashBalances(t1.currencyId, wallet.address);
            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, wbtc.currencyId, wallet.address, cashBalance.mul(-1));

            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(cashBalance)
            // This fast forwards for the after each check
            await fastForwardToMaturity(provider, maturities[1]);
        });
    });

    it("does not allow a liquidator to purchase more collateral than available", async () => {
        await t1.setupLiquidity();
        await t2.setupLiquidity();
        await escrow.connect(wallet2).deposit(token[1].address, parseEther("1000"));

        await t1.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await t2.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);

        // Make Dai collateralize USDC entirely.
        await escrow.connect(wallet).deposit(token[0].address, parseEther("220"));
        await escrow.connect(wallet).withdraw(weth.address, parseEther("2.625"));

        await chainlink[1].setAnswer(parseEther("0.02"));

        const fcBefore = await portfolios.freeCollateralView(wallet.address);
        // Liquidating Dai for USDC
        await escrow.connect(wallet2).liquidate(wallet.address, 2, 1)
        const fcAfter = await portfolios.freeCollateralView(wallet.address);
        // This is the amount of Dai that is collateralizing dai debts
        expect(await escrow.cashBalances(1, wallet.address)).to.equal(parseEther("100"));
        // Aggregate free collateral must increase
        expect(fcAfter[0]).to.be.above(fcBefore[0]);
    });

    it("does not allow a liquidator to purchase more collateral than necessary to recollateralize", async () => {
        await t1.setupLiquidity();
        await t2.setupLiquidity();
        await escrow.connect(wallet2).deposit(token[1].address, parseEther("1000"));

        await t1.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await t2.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);

        // Make Dai collateralize USDC entirely.
        await escrow.connect(wallet).deposit(token[0].address, parseEther("220"));
        await escrow.connect(wallet).withdraw(weth.address, parseEther("2.625"));

        // This means the value of the USDC has fallen relative to Dai
        await chainlink[1].setAnswer(parseEther("0.011"));

        // Liquidating Dai for USDC
        await escrow.connect(wallet2).liquidate(wallet.address, 2, 1)
        const fcAfter = await portfolios.freeCollateralView(wallet.address);
        // If there is sufficient collateral available, free collateral should be zero.
        expect(fcAfter[0]).to.equal(0);
    });

    it("removes liquidity tokens in the deposit currency in order to liquidate", async () => {
        await t1.setupLiquidity();
        await t2.setupLiquidity();
        await escrow.connect(wallet2).deposit(token[1].address, parseEther("1000"));

        await t1.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await t2.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);

        // Make Dai collateralize USDC entirely.
        await escrow.connect(wallet).deposit(token[0].address, parseEther("255"));
        await t1.futureCash.connect(wallet).addLiquidity(t1Maturities[1], parseEther("220"), parseEther("250"), 0, 100_000_000, BLOCK_TIME_LIMIT);

        await escrow.connect(wallet).withdraw(weth.address, parseEther("2"));
        await chainlink[1].setAnswer(parseEther("0.02"));

        await escrow.connect(wallet2).liquidate(wallet.address, 2, 1)
        expect(await escrow.cashBalances(1, wallet.address)).to.equal(0);
        expect(await t1.hasLiquidityToken(wallet, t1Maturities[1])).to.be.true;
    });

    it("accounts for the haircut amount when purchasing deposit currencies", async () => {
        await t1.setupLiquidity();
        await t2.setupLiquidity();
        await escrow.connect(wallet2).deposit(token[1].address, parseEther("1000"));

        await t1.borrowAndWithdraw(wallet, parseEther("150"), 1.05, 0, 100_000_000);
        await t2.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);

        await escrow.connect(wallet).deposit(token[0].address, parseEther("350"));
        await t1.futureCash.connect(wallet).addLiquidity(t1Maturities[0], parseEther("200"), parseEther("250"), 0, 100_000_000, BLOCK_TIME_LIMIT);

        await escrow.connect(wallet).withdraw(weth.address, parseEther("3.3325"));
        await chainlink[1].setAnswer(parseEther("0.0108"));
        await swapnet.risk.setHaircut(parseEther("0.7"));

        const fcBefore = await portfolios.freeCollateralView(wallet.address);
        await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.USDC, CURRENCY.DAI)
        const fcAfter = await portfolios.freeCollateralView(wallet.address);
        expect(fcAfter[0]).to.be.above(fcBefore[0]);
    });

    it("removes liquidity tokens partially in order to recollateralize an account", async () => {
        await t1.setupLiquidity();
        await t2.setupLiquidity();
        await escrow.connect(wallet2).deposit(token[0].address, parseEther("1000"));

        await t1.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await escrow.connect(wallet).deposit(token[0].address, parseEther("100"));
        await t1.futureCash.connect(wallet).addLiquidity(t1Maturities[1], parseEther("100"), parseEther("150"), 0, 100_000_000, BLOCK_TIME_LIMIT);

        await escrow.connect(wallet).withdraw(weth.address, parseEther("1.2"));
        await chainlink[0].setAnswer(parseEther("0.012"));

        const ethBalanceBefore = await escrow.cashBalances(CURRENCY.ETH, wallet.address);
        const liquidatorDaiBefore = await escrow.cashBalances(CURRENCY.DAI, wallet2.address);

        // This account is now undercollateralized slightly and the liquidity tokens will recapitalize it
        await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, CURRENCY.ETH)
        const liquidatorDaiAfter = await escrow.cashBalances(CURRENCY.DAI, wallet2.address);

        // ETH balances have not changed.
        expect(await escrow.cashBalances(CURRENCY.ETH, wallet.address)).to.equal(ethBalanceBefore);
        expect(liquidatorDaiAfter.sub(liquidatorDaiBefore)).to.be.above(0);
        expect(await t1.isCollateralized(wallet)).to.be.true;
        // We don't check the exact balance here because there's some precision loss
        expect(await t1.hasLiquidityToken(wallet, t1Maturities[1])).to.be.true;
    });

    it("removes liquidity tokens in full in order to recollateralize an account", async () => {
        await t1.setupLiquidity();
        await t2.setupLiquidity();
        await escrow.connect(wallet2).deposit(token[0].address, parseEther("1000"));

        await t1.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await escrow.connect(wallet).deposit(token[0].address, parseEther("10"));
        await t1.futureCash.connect(wallet).addLiquidity(t1Maturities[1], parseEther("10"), parseEther("15"), 0, 100_000_000, BLOCK_TIME_LIMIT);

        await chainlink[0].setAnswer(parseEther("0.012"));

        const liquidatorDaiBefore = await escrow.cashBalances(CURRENCY.DAI, wallet2.address);
        const accountDaiBefore = await escrow.cashBalances(CURRENCY.DAI, wallet.address);
        await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, CURRENCY.ETH)
        const liquidatorDaiAfter = await escrow.cashBalances(CURRENCY.DAI, wallet2.address);
        const accountDaiAfter = await escrow.cashBalances(CURRENCY.DAI, wallet.address);

        // The difference in the delta is how much cashClaim the liquidity tokens had
        expect(liquidatorDaiAfter.sub(liquidatorDaiBefore).add(accountDaiAfter.sub(accountDaiBefore))).to.equal(parseEther("10"));

        expect(await t1.isCollateralized(wallet)).to.be.true;
        expect(await t1.hasLiquidityToken(wallet, t1Maturities[1])).to.be.false;
    });

    it("allows a settler to purchase collateral to settle", async () => {
        await t1.setupLiquidity();
        await t2.setupLiquidity();
        await escrow.connect(wallet2).deposit(token[1].address, parseEther("1000"));

        await t1.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
        await t2.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);

        await escrow.connect(wallet).deposit(token[0].address, parseEther("220"));
        await escrow.connect(wallet).withdraw(weth.address, parseEther("2.625"));
        const maxMaturity = (await portfolios.getAssets(wallet.address))
            .map((a) => { return (a.maturity) })
            .sort()[1];


        await fastForwardToMaturity(provider, maxMaturity);
        await portfolios.settleMaturedAssets(wallet.address);
        await chainlink[1].setAnswer(parseEther("0.011"));
        await escrow.connect(wallet2).settleCashBalance(2, 1, wallet.address, parseEther("100"))
    });
});
