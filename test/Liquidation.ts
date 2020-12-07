import chai from "chai";
import { solidity } from "ethereum-waffle";
import {
    fixture,
    wallets,
    fixtureLoader,
    provider,
    CURRENCY,
    fastForwardToMaturity, fastForwardToTime
} from "./fixtures";
import { Wallet } from "ethers";
import { WeiPerEther } from "ethers/constants";

import {Ierc20 as ERC20} from "../typechain/Ierc20";
import { CashMarket } from "../typechain/CashMarket";
import { ErrorDecoder, ErrorCodes } from "../scripts/errorCodes";
import { Escrow } from "../typechain/Escrow";
import { Portfolios } from "../typechain/Portfolios";
import { MockAggregator } from "../mocks/MockAggregator";
import { TestUtils, BLOCK_TIME_LIMIT } from "./testUtils";
import { parseEther } from "ethers/utils";
import { Iweth } from '../typechain/Iweth';

chai.use(solidity);
const { expect } = chai;

describe("Liquidation", () => {
    let dai: ERC20;
    let futureCash: CashMarket;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let chainlink: MockAggregator;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let maturities: number[];
    let rateAnchor: number;
    let t: TestUtils;
    let weth: Iweth;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.cashMarket;
        escrow = objs.escrow;
        portfolios = objs.portfolios;
        chainlink = objs.chainlink;
        weth = objs.weth;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));

        await futureCash.setMaxTradeSize(WeiPerEther.mul(10_000));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);
        // The fee is one basis point.
        await futureCash.setFee(100_000, 0);

        // Set the blockheight to the beginning of the next period
        maturities = await futureCash.getActiveMaturities();
        await fastForwardToMaturity(provider, maturities[1]);
        t = new TestUtils(escrow, futureCash, portfolios, dai, owner, objs.chainlink, objs.weth, CURRENCY.DAI);

        maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(30_000));
        await futureCash.addLiquidity(
            maturities[0],
            WeiPerEther.mul(10_000),
            WeiPerEther.mul(10_000),
            0, 100_000_000, 
            BLOCK_TIME_LIMIT
        );
        await futureCash.addLiquidity(
            maturities[1],
            WeiPerEther.mul(10_000),
            WeiPerEther.mul(10_000),
            0, 100_000_000, 
            BLOCK_TIME_LIMIT
        );
        await futureCash.addLiquidity(
            maturities[2],
            WeiPerEther.mul(10_000),
            WeiPerEther.mul(10_000),
            0, 100_000_000, 
            BLOCK_TIME_LIMIT
        );
    });

    afterEach(async () => {
        await fastForwardToMaturity(provider, maturities[3]);
        expect(await t.checkEthBalanceIntegrity([owner, wallet, wallet2])).to.be.true;
        expect(await t.checkBalanceIntegrity([owner, wallet, wallet2])).to.be.true;
        expect(await t.checkMarketIntegrity([owner, wallet, wallet2], maturities)).to.be.true;
    });

    describe("settle cash, local currency scenarios [1-3]", async () => {
        it("[1] should not do anything if the value is set to 0", async () => {
            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, CURRENCY.ETH, owner.address, 0);
        });

        it("[1] should settle not cash between accounts when there is insufficient cash balance", async () => {
            const [, collateralAmount] = await t.borrowAndWithdraw(wallet2, WeiPerEther.mul(500), 1.5);
            await escrow.connect(wallet2).deposit(dai.address, collateralAmount);

            await t.mineAndSettleAccount([owner, wallet, wallet2]);

            await expect(
                escrow
                    .connect(wallet2)
                    .settleCashBalance(CURRENCY.DAI, CURRENCY.ETH, owner.address, WeiPerEther.mul(250))
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INCORRECT_CASH_BALANCE));
            await expect(
                escrow.settleCashBalance(
                    CURRENCY.DAI,
                    CURRENCY.ETH,
                    wallet2.address,
                    WeiPerEther.mul(550)
                )
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INCORRECT_CASH_BALANCE));
            await expect(
                escrow.connect(wallet2).settleCashBalance(
                    CURRENCY.DAI,
                    CURRENCY.ETH,
                    owner.address,
                    WeiPerEther.mul(550)
                )
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INCORRECT_CASH_BALANCE));
            await expect(
                escrow.settleCashBalance(
                    CURRENCY.DAI,
                    CURRENCY.ETH,
                    wallet2.address,
                    WeiPerEther.mul(500)
                )
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INCORRECT_CASH_BALANCE));
        });

        it("[3] should settle cash with the dai portion of the liquidity token", async () => {
            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            await futureCash
                .connect(wallet)
                .takeCurrentCash(maturities[0], WeiPerEther.mul(200), BLOCK_TIME_LIMIT, 60_000_000);
            await futureCash
                .connect(wallet)
                .addLiquidity(maturities[1], WeiPerEther.mul(500), WeiPerEther.mul(500), 0, 100_000_000, BLOCK_TIME_LIMIT);
            const daiBalance = await escrow.cashBalances(CURRENCY.DAI, wallet.address);
            // At this point the dai claim in the liquidity tokens is collateralizing the payer. Leave 100 dai in just to
            // test that we will settle both properly.
            await escrow.connect(wallet).withdraw(dai.address, daiBalance.sub(WeiPerEther.mul(100)));

            await t.mineAndSettleAccount([owner, wallet, wallet2]);
            const [isSettled] = await t.settleCashBalance(wallet);
            expect(isSettled).to.be.true;

            // Portfolio: we should have sold part of the tokens and the cash payer has updated
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(0);
            expect(await t.hasLiquidityToken(wallet, maturities[1], parseEther("400"))).to.be.true;
        });

        it("[3] should settle cash with the entire liquidity token", async () => {
            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            await futureCash
                .connect(wallet)
                .takeCurrentCash(maturities[0], WeiPerEther.mul(200), BLOCK_TIME_LIMIT, 60_000_000);
            await futureCash
                .connect(wallet)
                .addLiquidity(maturities[1], WeiPerEther.mul(200), WeiPerEther.mul(200), 0, 100_000_000, BLOCK_TIME_LIMIT);
            await futureCash
                .connect(wallet)
                .addLiquidity(maturities[2], WeiPerEther.mul(200), WeiPerEther.mul(200), 0, 100_000_000, BLOCK_TIME_LIMIT);
            const daiBalance = await escrow.cashBalances(CURRENCY.DAI, wallet.address);
            // At this point the dai claim in the liquidity tokens is collateralizing the payer.
            await escrow.connect(wallet).withdraw(dai.address, daiBalance);

            await t.mineAndSettleAccount([owner, wallet, wallet2]);
            const [isSettled] = await t.settleCashBalance(wallet);
            expect(isSettled).to.be.true;

            // Portfolio: we should have sold all of the tokens and the cash payer has been removed.
            expect(await t.hasLiquidityToken(wallet, maturities[1])).to.be.false;
            expect(await t.hasLiquidityToken(wallet, maturities[2])).to.be.true;
        });
    });

    describe("settle cash, trading scenarios [4-6]", async () => {
        it("[4] settle cash should not touch assets when the account is undercollateralized", async () => {
            const [ethAmount, collateralAmount] = await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100), 1.5);
            // Deposit some dai back into escrow
            const daiLeft = collateralAmount.sub(WeiPerEther.mul(70));
            await escrow.connect(wallet).deposit(dai.address, daiLeft);

            await t.mineAndSettleAccount([owner, wallet, wallet2]);
            const debtBalance = await escrow.cashBalances(CURRENCY.DAI, wallet.address);

            // ETH price has moved, portfolio is undercollateralized
            await chainlink.setAnswer(WeiPerEther);
            expect(await t.isCollateralized(wallet)).to.be.false;

            await escrow.settleCashBalance(
                CURRENCY.DAI,
                CURRENCY.ETH,
                wallet.address,
                debtBalance.mul(-1)
            );

            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(debtBalance);
            expect(await escrow.cashBalances(CURRENCY.ETH, wallet.address)).to.equal(ethAmount);
            expect(await t.isCollateralized(wallet)).to.be.false;
        });

        it("[6] should settle cash between accounts when eth must be sold", async () => {
            const settlerDaiBalanceBefore = await dai.balanceOf(wallet2.address);
            const settlerEthBalanceBefore = await weth.balanceOf(wallet2.address);
            const [ethAmount] = await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100), 1.5);

            await t.mineAndSettleAccount([owner, wallet, wallet2]);
            // Wallet2 will settle cash on behalf of owner
            const [isSettled] = await t.settleCashBalance(wallet, WeiPerEther.mul(100), wallet2);
            expect(isSettled).to.be.true;

            // Purchased 100 Dai at a price of 1.02 ETH
            const settleDiscount = await escrow.G_SETTLEMENT_DISCOUNT();
            const ethPurchased = parseEther("1").mul(settleDiscount).div(WeiPerEther);
            expect(await escrow.cashBalances(CURRENCY.ETH, wallet.address)).to.equal(
                ethAmount.sub(ethPurchased)
            );

            const settlerEthBalanceAfter = await weth.balanceOf(wallet2.address);
            expect(settlerEthBalanceAfter.sub(settlerEthBalanceBefore)).to.equal(ethPurchased);

            // 100 Dai has been transfered to the owner wallet in exchange for ETH.
            const settlerDaiBalanceAfter = await dai.balanceOf(wallet2.address);
            expect(settlerDaiBalanceBefore.sub(settlerDaiBalanceAfter)).to.equal(parseEther("100"));
        });

    });

    describe("settle cash w/ fCash scenarios", async () => {
        it("should not settle fCash if undercollateralized", async () => {
            await t.setupSellFutureCash(wallet, parseEther("100"), parseEther("100"));
            await expect(
                escrow.settlefCash(wallet.address, CURRENCY.DAI, CURRENCY.DAI, parseEther("100"))
            ).be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL))
        });

        it("should not settle fCash if has cash balances", async () => {
            await t.setupSellFutureCash(wallet, parseEther("96"), parseEther("100"));
            await escrow.connect(wallet).depositEth({value: parseEther("0.02")});
            await fastForwardToMaturity(provider, maturities[0]);

            await expect(
                escrow.settlefCash(wallet.address, CURRENCY.DAI, CURRENCY.DAI, parseEther("10"))
            ).be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.ACCOUNT_HAS_COLLATERAL));

            await expect(
                escrow.settlefCash(wallet.address, CURRENCY.DAI, CURRENCY.DAI, parseEther("200"))
            ).be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INCORRECT_CASH_BALANCE));
        });

        it("should not settle fCash if has liquidity tokens", async () => {
            await t.setupSellFutureCash(wallet, parseEther("96"), parseEther("100"));
            await escrow.connect(wallet).deposit(dai.address, parseEther("10"));
            await futureCash.connect(wallet).addLiquidity(maturities[1], parseEther("5"), parseEther("10"), 0, 100_000_000, BLOCK_TIME_LIMIT);
            await fastForwardToMaturity(provider, maturities[0]);

            await expect(
                escrow.settlefCash(wallet.address, CURRENCY.DAI, CURRENCY.DAI, parseEther("10"))
            ).be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.PORTFOLIO_HAS_LIQUIDITY_TOKENS));
        });

        it("should settle fCash in local currency, only liquidator payments", async () => {
            const settleAmount = await t.setupSellFutureCash(wallet, parseEther("95"), undefined, parseEther("100"));

            await fastForwardToTime(provider, maturities[1]);
            const [, remaining] = await t.getfCashValue(
                parseEther("100"),
                settleAmount,
                maturities[2],
                maturities[1]
            );

            await escrow.settlefCash(wallet.address, CURRENCY.DAI, CURRENCY.DAI, settleAmount);
            expect(await t.hasCashReceiver(wallet, maturities[2], remaining)).to.be.true;
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(0)
        });
    });

    describe("settle cash w/ reserves", async () => {
        it("should not settle reserves if has cash", async () => {
            await escrow.connect(wallet).deposit(dai.address, parseEther("10"));
            await expect(
                escrow.settleReserve(wallet.address, CURRENCY.ETH)
            ).be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.ACCOUNT_HAS_COLLATERAL));
        });

        it("should not settle reserves if has fCash", async () => {
            await escrow.connect(wallet).deposit(dai.address, parseEther("10"));
            await futureCash.connect(wallet).takefCash(maturities[0], parseEther("10"), BLOCK_TIME_LIMIT, 0);
            const cashBalances = await escrow.cashBalances(CURRENCY.DAI, wallet.address);
            await escrow.connect(wallet).withdraw(dai.address, cashBalances);

            await expect(
                escrow.settleReserve(wallet.address, CURRENCY.ETH)
            ).be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.ACCOUNT_HAS_COLLATERAL));
        });

        it("should not settle reserves if has liquidity tokens", async () => {
            await escrow.connect(wallet).deposit(dai.address, parseEther("10"));
            await futureCash.connect(wallet).addLiquidity(maturities[0], parseEther("10"), parseEther("10"), 0, 100_000_000, BLOCK_TIME_LIMIT);

            await expect(
                escrow.settleReserve(wallet.address, CURRENCY.ETH)
            ).be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.ACCOUNT_HAS_COLLATERAL));
        });

        it("should settle reserves in full", async () => {
            await escrow.setReserveAccount(wallet2.address);
            await escrow.connect(wallet2).deposit(dai.address, WeiPerEther.mul(1000));
            const settleAmount = await t.setupSellFutureCash(wallet, parseEther("100"));

            await fastForwardToTime(provider, maturities[0]);
            await portfolios.settleMaturedAssets(wallet.address);

            await escrow.settleReserve(wallet.address, CURRENCY.DAI);
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(0);
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(parseEther("1000").sub(settleAmount));
        });

        it("should settle reserves partially", async () => {
            await escrow.setReserveAccount(wallet2.address);
            await escrow.connect(wallet2).deposit(dai.address, WeiPerEther.mul(50));
            const settleAmount = await t.setupSellFutureCash(wallet, parseEther("100"));

            await fastForwardToTime(provider, maturities[0]);
            await portfolios.settleMaturedAssets(wallet.address);

            await escrow.settleReserve(wallet.address, CURRENCY.DAI);
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(parseEther("50").sub(settleAmount));
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(0);
        });
    });

    describe("liquidate w/ fcash", async () => {
        it("should not liquidate fCash if collateralized", async () => {
            await t.setupSellFutureCash(wallet, parseEther("95"), parseEther("100"));
            await fastForwardToMaturity(provider, maturities[0]);

            await expect(
                escrow.liquidatefCash(wallet.address, CURRENCY.DAI, CURRENCY.ETH)
            ).be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL))
        });

        it("should not liquidate fCash if has cash balances", async () => {
            await t.setupSellFutureCash(wallet, parseEther("100"), parseEther("100"));
            await escrow.connect(wallet).depositEth({value: parseEther("0.02")});
            await fastForwardToMaturity(provider, maturities[0]);

            await expect(
                escrow.liquidatefCash(wallet.address, CURRENCY.DAI, CURRENCY.ETH)
            ).be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.ACCOUNT_HAS_COLLATERAL));
        });
    });

    // liquidate //
    describe("liquidation scenarios", async () => {
        it("[1] should not liquidate an account that is properly collateralized", async () => {
            await escrow.connect(wallet).depositEth({ value: WeiPerEther.mul(5) });
            await futureCash
                .connect(wallet)
                .takeCurrentCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, 60_000_000);

            expect((await portfolios.freeCollateralView(wallet.address))[0]).to.be.above(0);
            await expect(escrow.liquidate(wallet.address, 0, CURRENCY.DAI, CURRENCY.ETH)).to.be.revertedWith(
                ErrorDecoder.encodeError(ErrorCodes.CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL)
            );
        });

        it("[2] should recollateralize an account using just liquidity tokens before it touches eth", async () => {
            await escrow.connect(wallet).deposit(dai.address, parseEther("10"));
            await futureCash.connect(wallet).addLiquidity(maturities[1], parseEther("10"), parseEther("10"), 0, 100_000_000, BLOCK_TIME_LIMIT);
            const [ethBalanceBefore] = await t.borrowAndWithdraw(wallet, parseEther("100"));

            const newRate = parseEther("0.013");
            await chainlink.setAnswer(newRate);
            expect(await t.isCollateralized(wallet)).to.be.false;

            await escrow.liquidate(wallet.address, 0, CURRENCY.DAI, CURRENCY.ETH);

            expect(await t.hasLiquidityToken(wallet, maturities[1])).to.be.false;
            expect(await escrow.cashBalances(CURRENCY.ETH, wallet.address)).to.be.below(ethBalanceBefore);
        });

        it("[3] should liquidate an account when it is under collateralized by eth", async () => {
            const [ethBalanceBefore, ] = await t.borrowAndWithdraw(wallet, parseEther("100"));

            // Change this via chainlink
            const newRate = parseEther("0.011");
            await chainlink.setAnswer(newRate);
            expect(await t.isCollateralized(wallet)).to.be.false;

            const fcBefore = await portfolios.freeCollateralView(wallet.address);
            await escrow.liquidate(wallet.address, 0, CURRENCY.DAI, CURRENCY.ETH);
            const ethBalanceAfter = await escrow.cashBalances(CURRENCY.ETH, wallet.address);

            const fcAfter = await portfolios.freeCollateralView(wallet.address);
            expect(await t.isCollateralized(wallet)).to.be.true;

            const liquidationBonus = await escrow.G_LIQUIDATION_DISCOUNT();
            const exchangeRate = await escrow.getExchangeRate(CURRENCY.DAI, CURRENCY.ETH);
            const daiFCChange = fcBefore[0]
                .mul(-1)
                .mul(parseEther("1.01")) // Buffer
                .mul(WeiPerEther)
                .div(newRate)
                .div(exchangeRate.buffer.sub(liquidationBonus));
            
            const ethPurchased = daiFCChange
                .mul(newRate)
                .mul(liquidationBonus)
                .div(WeiPerEther)
                .div(WeiPerEther);

            // We ignore the last two units of precision here.
            expect(ethBalanceBefore.sub(ethBalanceAfter).div(100)).to.equal(ethPurchased.div(100));
            expect(fcBefore[1][1].abs().sub(fcAfter[1][1].abs()).div(100)).to.equal(daiFCChange.div(100));
        });

        it("[3] should account for dai when partially liquidating an account", async () => {
            const liquidatorEthBalanceBefore = await weth.balanceOf(owner.address);
            const liquidatorDaiBalanceBefore = await dai.balanceOf(owner.address);

            const [ethBalanceBefore, collateralAmount] = await t.borrowAndWithdraw(wallet, parseEther("100"));
            const daiLeft = collateralAmount.sub(parseEther("50"));
            await escrow.connect(wallet).deposit(dai.address, daiLeft);

            // Change this via chainlink
            const newRate = parseEther("0.022");
            await chainlink.setAnswer(newRate);
            expect(await t.isCollateralized(wallet)).to.be.false;

            const fcBefore = await portfolios.freeCollateralView(wallet.address);
            await escrow.liquidate(wallet.address, 0, CURRENCY.DAI, CURRENCY.ETH);
            expect(await t.isCollateralized(wallet)).to.be.true;

            let ethBalanceAfter = await escrow.cashBalances(CURRENCY.ETH, wallet.address);

            const liquidationBonus = await escrow.G_LIQUIDATION_DISCOUNT();
            const exchangeRate = await escrow.getExchangeRate(CURRENCY.DAI, CURRENCY.ETH);
            const daiPurchased = fcBefore[0]
                .mul(-1)
                .mul(parseEther("1.01")) // Buffer
                .mul(WeiPerEther)
                .div(newRate)
                .div(exchangeRate.buffer.sub(liquidationBonus));

            const ethPurchased = daiPurchased
                .mul(newRate)
                .mul(liquidationBonus)
                .div(WeiPerEther)
                .div(WeiPerEther);

            expect(ethBalanceBefore.sub(ethBalanceAfter).div(1e5)).to.equal(ethPurchased.div(1e5));

            const liquidatorEthBalanceAfter = await weth.balanceOf(owner.address);
            const liquidatorDaiBalanceAfter = await dai.balanceOf(owner.address);
            expect((liquidatorEthBalanceAfter.sub(liquidatorEthBalanceBefore)).div(1e5)).to.equal(ethPurchased.div(1e5));
            expect((liquidatorDaiBalanceBefore.sub(daiPurchased)).div(1e5)).to.equal(
                liquidatorDaiBalanceAfter.div(1e5)
            );
        });

        it("[4] should liquidate an account up to a certain amount of DAI", async () => {
            const [ethBalanceBefore, ] = await t.borrowAndWithdraw(wallet, parseEther("100"));
            const liquidatorEthBalanceBefore = await weth.balanceOf(owner.address);
            const liquidatorDaiBalanceBefore = await dai.balanceOf(owner.address);

            // Change this via chainlink
            const newRate = parseEther("0.011");
            await chainlink.setAnswer(newRate);
            expect(await t.isCollateralized(wallet)).to.be.false;

            const fcBefore = await portfolios.freeCollateralView(wallet.address);
            const liquidationBonus = await escrow.G_LIQUIDATION_DISCOUNT();
            const maxDaiLiquidate = parseEther('2.5')

            await escrow.liquidate(wallet.address, maxDaiLiquidate, CURRENCY.DAI, CURRENCY.ETH);
            const ethBalanceAfter = await escrow.cashBalances(CURRENCY.ETH, wallet.address);

            const fcAfter = await portfolios.freeCollateralView(wallet.address);

            const ethPurchased = maxDaiLiquidate
                .mul(newRate)
                .mul(liquidationBonus)
                .div(WeiPerEther)
                .div(WeiPerEther);

            const liquidatorEthBalanceAfter = await weth.balanceOf(owner.address);
            const liquidatorDaiBalanceAfter = await dai.balanceOf(owner.address);
            // We ignore the last two units of precision here.
            expect((liquidatorEthBalanceAfter.sub(liquidatorEthBalanceBefore)).div(100)).to.equal(ethPurchased.div(100));
            expect(liquidatorDaiBalanceBefore.sub(liquidatorDaiBalanceAfter)).to.equal(maxDaiLiquidate);
            expect(fcBefore[1][1].abs().sub(fcAfter[1][1].abs()), "FC does not match").to.equal(maxDaiLiquidate);
            expect(ethBalanceBefore.sub(ethBalanceAfter).div(100), "ETH balances do not match").to.equal(ethPurchased.div(100));
        });
    });
}).timeout(50000);
