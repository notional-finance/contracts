import chai from "chai";
import {solidity} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, mineBlocks} from "./fixtures";
import {Wallet} from "ethers";
import {WeiPerEther} from "ethers/constants";

import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import { ErrorDecoder, ErrorCodes } from '../scripts/errorCodes';

chai.use(solidity);
const {expect} = chai;

describe("Future Cash", () => {
    let dai: ERC20;
    let futureCash: FutureCash;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let rateAnchor: number;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(futureCash.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(futureCash.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(futureCash.address, WeiPerEther.mul(100_000_000));

        await futureCash.setMaxTradeSize(WeiPerEther.mul(10_000));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);
        await futureCash.setHaircutSize(WeiPerEther.div(100).mul(30), WeiPerEther.add(WeiPerEther.div(100).mul(2)));
        await futureCash.setNumPeriods(4);
        await futureCash.setFee(0);

        // Set the blockheight to the beginning of the next period
        let block = await provider.getBlockNumber();
        await mineBlocks(provider, 20 - (block % 20));
    });

    // maturities //
    it("should not allow add liquidity on invalid maturities", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(30));
        // add liquidity
        await expect(futureCash.addLiquidity(maturities[0] - 10, WeiPerEther.mul(10), WeiPerEther.mul(10), 1000))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
        await expect(futureCash.addLiquidity(maturities[0] - 20, WeiPerEther.mul(10), WeiPerEther.mul(10), 1000))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
        await expect(futureCash.addLiquidity(maturities[3] + 20, WeiPerEther.mul(10), WeiPerEther.mul(10), 1000))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
    });

    // deposits //
    it("allows users to deposit eth", async () => {
        await futureCash.depositEth({value: WeiPerEther.mul(200)});
        expect(await futureCash.ethBalances(owner.address)).to.equal(WeiPerEther.mul(200));
    });

    it("allows users to deposit dai", async () => {
        await dai.approve(futureCash.address, WeiPerEther);
        await futureCash.depositDai(WeiPerEther);
        expect(await futureCash.daiBalances(owner.address)).to.equal(WeiPerEther);
    });

    // withdraws //
    it("allows users to withdraw eth", async () => {
        let balance = await owner.getBalance();
        await futureCash.depositEth({value: WeiPerEther});
        await futureCash.withdrawEth(WeiPerEther.div(2));
        expect(await futureCash.ethBalances(owner.address)).to.equal(WeiPerEther.div(2));
        expect(balance.sub(await owner.getBalance())).to.be.at.least(WeiPerEther.div(2));
    });

    it("allows users to withdraw dai", async () => {
        let balance = await dai.balanceOf(owner.address);
        await futureCash.depositEth({value: WeiPerEther});
        await dai.approve(futureCash.address, WeiPerEther);
        await futureCash.depositDai(WeiPerEther);
        await futureCash.withdrawDai(WeiPerEther.div(2));
        expect(await futureCash.daiBalances(owner.address)).to.equal(WeiPerEther.div(2));
        expect(balance.sub(await dai.balanceOf(owner.address))).to.be.at.least(WeiPerEther.div(2));
    });

    it("prevents users from withdrawing more eth than they own", async () => {
        await futureCash.depositEth({value: WeiPerEther});
        await expect(futureCash.withdrawEth(WeiPerEther.mul(2)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
    });

    it("prevents users from withdrawing more dai than they own", async () => {
        await dai.approve(futureCash.address, WeiPerEther);
        await futureCash.depositDai(WeiPerEther);
        await expect(futureCash.withdrawDai(WeiPerEther.mul(2)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
    });

    it("prevents users from withdrawing eth if they do not have enough collateral", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.connect(wallet).depositEth({value: WeiPerEther.mul(7)});
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(200), 1000, 0);
        // Remove the dai so only the ETH is collateralizing the CASH_PAYER
        await futureCash.connect(wallet).withdrawDai(await futureCash.daiBalances(wallet.address));

        // // We need about 6.9 ETH to collateralize the account.
        await expect(futureCash.connect(wallet).withdrawEth(WeiPerEther.div(100).mul(20)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));

        let balance = await wallet.getBalance();
        await expect(futureCash.connect(wallet).withdrawEth(WeiPerEther.div(100).mul(2)))
            .to.not.be.reverted;
        // Not exact because of gas costs
        expect(await wallet.getBalance()).to.be.above(balance.add(WeiPerEther.div(100).mul(1)));
        expect(await futureCash.ethBalances(wallet.address)).to.equal(
            WeiPerEther.mul(7).sub(WeiPerEther.div(100).mul(2))
        );
    });

    it("prevents users from withdrawing dai if they do not have enough collateral", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.connect(wallet).depositEth({value: WeiPerEther.mul(7)});
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(200), 1000, 0);
        // Remove most the ETH so only the dai is collateralizing the CASH_PAYER
        await futureCash.connect(wallet).withdrawEth(WeiPerEther.mul(6));

        // We need about 200 Dai to collateralize the cash payer
        let balance = await dai.balanceOf(wallet.address);
        let daiBalance = await futureCash.daiBalances(wallet.address);
        await expect(futureCash.connect(wallet).withdrawDai(WeiPerEther.mul(30)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));
        await expect(futureCash.connect(wallet).withdrawDai(WeiPerEther.mul(10))).to.not.be.reverted;
        expect(await dai.balanceOf(wallet.address)).to.equal(balance.add(WeiPerEther.mul(10)));
        expect(await futureCash.daiBalances(wallet.address)).to.equal(daiBalance.sub(WeiPerEther.mul(10)));
    });

    // liquidity tokens //
    it("should allow add liquidity", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(30));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);

        // Free collateral should not have changed
        expect(await futureCash.freeCollateral(owner.address)).to.equal(WeiPerEther.mul(30));

        let trades = await futureCash.getAccountTrades(owner.address);
        expect(trades.length).to.equal(2);
        expect(trades[0].tradeType).to.equal(await futureCash.LIQUIDITY_TOKEN());
        expect(trades[0].maturity).to.equal(maturities[0]);
        expect(trades[0].notional).to.equal(WeiPerEther.mul(10));

        expect(trades[1].tradeType).to.equal(await futureCash.CASH_PAYER());
        expect(trades[1].maturity).to.equal(maturities[0]);
        expect(trades[1].notional).to.equal(WeiPerEther.mul(10));
    });

    it("should not allow add liquidity if there is insufficient balance", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(5));
        await expect(futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UINT128_SUBTRACTION_UNDERFLOW));
    });

    it("should allow remove liquidity", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(30));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);

        await futureCash.removeLiquidity(maturities[0], WeiPerEther.mul(5), 0, 1000);
        expect(await futureCash.freeCollateral(owner.address)).to.equal(WeiPerEther.mul(30));

        let trades = await futureCash.getAccountTrades(owner.address);
        expect(trades.length).to.equal(2);
        expect(trades[0].tradeType).to.equal(await futureCash.LIQUIDITY_TOKEN());
        expect(trades[0].maturity).to.equal(maturities[0]);
        expect(trades[0].notional).to.equal(WeiPerEther.mul(5));

        expect(trades[1].tradeType).to.equal(await futureCash.CASH_PAYER());
        expect(trades[1].maturity).to.equal(maturities[0]);
        expect(trades[1].notional).to.equal(WeiPerEther.mul(5));
    });

    it("should allow not allow remove liquidity if the account does not have liquidty tokens", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(30));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);

        await expect(futureCash.removeLiquidity(maturities[0], WeiPerEther.mul(15), 0, 1000))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
    });

    it("should allow users to add liquidity to invalid periods", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.setNumPeriods(0);
        await futureCash.depositDai(WeiPerEther.mul(30));
        await expect(futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
    });

    it("should allow liquidity to roll", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(40));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);
        await futureCash.addLiquidity(maturities[1], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);
        await futureCash.addLiquidity(maturities[2], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);
        await futureCash.addLiquidity(maturities[3], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);

        // Take futureCash to change the liquidity amounts
        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(10));
        await futureCash.connect(wallet).takeFutureCash(maturities[1], WeiPerEther, 1000, WeiPerEther);
        await futureCash.connect(wallet).takeFutureCash(maturities[2], WeiPerEther, 1000, WeiPerEther);
        await futureCash.connect(wallet).takeFutureCash(maturities[3], WeiPerEther, 1000, WeiPerEther);

        await mineBlocks(provider, 25);
        maturities = await futureCash.getActiveMaturities();
        await futureCash.addLiquidity(maturities[3], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);
    });

    // take dai //
    it("should allow users to take dai for future cash", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        // Deposit ETH as collateral for a loan.
        await futureCash.connect(wallet).depositEth({value: WeiPerEther});
        let freeCollateral = await futureCash.freeCollateral(wallet.address);
        let daiBalance = await futureCash.getFutureCashToDai(maturities[0], WeiPerEther.mul(25));

        const marketBefore = await futureCash.markets(maturities[0]);
        // Deposit 25 dai in future cash, collateralized by an ETH
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(25), 1000, 0);
        expect(await futureCash.daiBalances(wallet.address)).to.equal(daiBalance);

        const marketAfter = await futureCash.markets(maturities[0]);
        expect(marketBefore.totalCollateral.sub(daiBalance)).to.equal(marketAfter.totalCollateral);
        expect(marketBefore.totalFutureCash.add(WeiPerEther.mul(25))).to.equal(marketAfter.totalFutureCash);

        let trades = await futureCash.getAccountTrades(wallet.address);
        expect(trades.length).to.equal(1);
        expect(trades[0].tradeType).to.equal(await futureCash.CASH_PAYER());
        expect(trades[0].maturity).to.equal(maturities[0]);
        expect(trades[0].notional).to.equal(WeiPerEther.mul(25));

        expect(freeCollateral.sub(await futureCash.freeCollateral(wallet.address))).to.be.above(0);
        await futureCash.connect(wallet).withdrawDai(daiBalance);
    });

    it("should not allow users to take dai for future cash if they do not have collateral", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await expect(futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(25), 1000, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));
    });

    it("should not allow users to take dai for future cash on an invalid maturity", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.setNumPeriods(0);

        await futureCash.connect(wallet).depositEth({value: WeiPerEther});
        await expect(futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(25), 1000, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
    });

    it("should not allow users to trade more future cash than the limit", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.setMaxTradeSize(WeiPerEther.mul(100));
        await futureCash.connect(wallet).depositEth({value: WeiPerEther.mul(100)});
        await expect(futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(105), 1000, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_TOO_LARGE));
    });

    // take future cash //
    it("should allow users to take future cash for dai", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(11_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        // Do this first to prevent negative interest rates.
        await futureCash.takeDai(maturities[0], WeiPerEther.mul(1_000), 1000, 0);

        // Wallet needs to deposit Dai balance in order to take future cash
        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(100));
        const daiAmount = await futureCash.getDaiToFutureCash(maturities[0], WeiPerEther.mul(100));

        const marketBefore = await futureCash.markets(maturities[0]);
        expect(daiAmount).to.be.below(WeiPerEther.mul(100));
        let freeCollateral = await futureCash.freeCollateral(wallet.address);
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, WeiPerEther.mul(100));
        expect(await futureCash.daiBalances(wallet.address)).to.equal(WeiPerEther.mul(100).sub(daiAmount));

        const marketAfter = await futureCash.markets(maturities[0]);
        expect(marketBefore.totalCollateral.add(daiAmount)).to.equal(marketAfter.totalCollateral);
        expect(marketBefore.totalFutureCash.sub(WeiPerEther.mul(100))).to.equal(marketAfter.totalFutureCash);

        let trades = await futureCash.getAccountTrades(wallet.address);
        expect(trades.length).to.equal(1);
        expect(trades[0].tradeType).to.equal(await futureCash.CASH_RECEIVER());
        expect(trades[0].maturity).to.equal(maturities[0]);
        expect(trades[0].notional).to.equal(WeiPerEther.mul(100));

        expect(freeCollateral.sub(await futureCash.freeCollateral(wallet.address))).to.be.above(0);
    });

    it("should not allow users to take future cash for dai if they do not have collateral", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await expect(futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(25), 1000, WeiPerEther.mul(25)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UINT128_SUBTRACTION_UNDERFLOW));
    });

    it("should not allow users to take future cash for dai on an invalid maturity", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.setNumPeriods(0);

        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(25));
        await expect(futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(25), 1000, WeiPerEther.mul(25)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
    });

    it("should not allow users to trade more future cash than the limit", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.setMaxTradeSize(WeiPerEther.mul(100));
        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        await expect(futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(105), 1000, WeiPerEther.mul(105)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_TOO_LARGE));
    });

    // settle account //
    it("should settle accounts to cash", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.connect(wallet2).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet2).takeDai(maturities[0], WeiPerEther.mul(500), 1000, 0);

        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(100));
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, WeiPerEther.mul(100));

        await mineBlocks(provider, 20);

        await futureCash.settle(wallet.address);
        await futureCash.settleBatch([wallet2.address, owner.address]);

        expect(await futureCash.getAccountTrades(owner.address)).to.have.lengthOf(0);
        expect(await futureCash.getAccountTrades(wallet.address)).to.have.lengthOf(0);
        expect(await futureCash.getAccountTrades(wallet2.address)).to.have.lengthOf(0);

        // Liquidity provider has earned some interest on liquidity
        expect(
            (await futureCash.daiCashBalances(owner.address)).add(await futureCash.daiBalances(owner.address))
        ).to.be.above(WeiPerEther.mul(10_000));
        expect(await futureCash.ethBalances(owner.address)).to.equal(0);

        // This is the negative balance owed as a fixed rate loan ("takeDai")
        expect(await futureCash.daiCashBalances(wallet2.address)).to.equal(WeiPerEther.mul(-500));
        expect(await futureCash.ethBalances(wallet2.address)).to.equal(WeiPerEther.mul(5));

        // This is the lending amount, should be above what they put in
        expect(await futureCash.daiCashBalances(wallet.address)).to.equal(WeiPerEther.mul(100));
        // There is some residual left in dai balances.
        expect(await futureCash.daiBalances(wallet.address)).to.be.above(0);
        expect(await futureCash.ethBalances(wallet.address)).to.equal(0);

        // All cash balances have to net out to exactly zero
        expect(
            (await futureCash.daiCashBalances(owner.address))
                .add(await futureCash.daiCashBalances(wallet.address))
                .add(await futureCash.daiCashBalances(wallet2.address))
        ).to.equal(0);
    });

    // price methods //
    it("should return a higher rate after someone has purchased dai (borrowed)", async () => {
        const maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        const impliedRateBefore = (await futureCash.markets(maturities[0])).lastImpliedRate;
        const cash = await futureCash.getFutureCashToDai(maturities[0], WeiPerEther.mul(200));
        expect(cash).to.be.below(WeiPerEther.mul(200));

        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(200), 1000, 0);
        const blockNum = await provider.getBlockNumber();

        const impliedRateAfter = (await futureCash.markets(maturities[0])).lastImpliedRate;
        const tradeImpliedRate = (WeiPerEther.mul(200).mul(1e9).div(cash).sub(1e9)).mul(20).div(maturities[0] - blockNum);
        // console.log(`Exchange Rate: ${exchangeRate}`);
        // console.log(`Implied Rate Before: ${impliedRateBefore}`);
        // console.log(`Implied Rate After: ${impliedRateAfter}`);
        // console.log(`Trade Implied Rate: ${tradeImpliedRate.toString()}`);

        // This should be impliedRateBefore < impliedRateAfter < tradeExchangeRate
        expect(impliedRateBefore).to.be.below(impliedRateAfter);
        expect(impliedRateAfter).to.be.below(tradeImpliedRate);
        expect(await futureCash.daiBalances(wallet.address)).to.equal(WeiPerEther.mul(1000).add(cash));
    });

    it("should return a lower rate after someone has purchased future cash (lending)", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        const impliedRateBefore = (await futureCash.markets(maturities[0])).lastImpliedRate;
        const cash = await futureCash.getDaiToFutureCash(maturities[0], WeiPerEther.mul(200));
        expect(cash).to.be.below(WeiPerEther.mul(200));

        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(200), 1000, WeiPerEther.mul(200));
        expect(await futureCash.daiBalances(wallet.address)).to.equal(WeiPerEther.mul(1000).sub(cash));
        const blockNum = await provider.getBlockNumber();

        const impliedRateAfter = (await futureCash.markets(maturities[0])).lastImpliedRate;
        const tradeImpliedRate = (WeiPerEther.mul(200).mul(1e9).div(cash).sub(1e9)).mul(20).div(maturities[0] - blockNum);

        // console.log(`Implied Rate Before: ${impliedRateBefore}`);
        // console.log(`Implied Rate After: ${impliedRateAfter}`);
        // console.log(`Trade Implied Rate: ${tradeImpliedRate.toString()}`);
        // This should be impliedRateBefore > impliedRateAfter > tradeExchangeRate
        expect(impliedRateBefore).to.be.above(impliedRateAfter);
        expect(impliedRateAfter).to.be.above(tradeImpliedRate);
    });

    it("should return the spot exchange rate which converts to the last implied rate", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(100));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(100), WeiPerEther.mul(100), 1000);

        // The rate will be calculated at the next block...
        const blockNum = await provider.getBlockNumber() + 1;
        const rateMantissa = await futureCash.INSTRUMENT_PRECISION();
        const periodSize = await futureCash.G_PERIOD_SIZE();
        const lastImpliedRate = (await futureCash.markets(maturities[0])).lastImpliedRate;
        const spotRate = (await futureCash.getRate(maturities[0]))[0];
        // There's an off by one error here...
        expect(Math.trunc((spotRate - rateMantissa) * periodSize / (maturities[0] - blockNum)) - 1).to.equal(lastImpliedRate);
    })

    it("should revert if too much dai is taken", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(100));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(100), WeiPerEther.mul(100), 1000);

        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        // At 85 future cash the exchange rate explodes and gets too expensive.
        await expect(futureCash.getFutureCashToDai(maturities[0], WeiPerEther.mul(85)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ABDK_UINT256_OVERFLOW));
        await expect(futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(85), 1000, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ABDK_UINT256_OVERFLOW));
    });

    it("should revert if too much future cash is taken", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(100));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(100), WeiPerEther.mul(100), 1000);

        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        await expect(futureCash.getDaiToFutureCash(maturities[0], WeiPerEther.mul(100)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ABDK_NEGATIVE_LOG));
        await expect(futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, WeiPerEther.mul(100)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ABDK_NEGATIVE_LOG));
    });

    // front running and price limits //
    it("should revert if a block limit is hit when taking dai", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        let blockNum = await provider.getBlockNumber();
        await expect(futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(200), blockNum - 1, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_MAX_BLOCK));
    });

    it("should revert if a block limit is hit when taking future cash", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        let blockNum = await provider.getBlockNumber();
        await expect(futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(200), blockNum - 1, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_MAX_BLOCK));
    });

    it("should revert if a price limit is hit when taking dai", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        await expect(
            futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(200), 1000, WeiPerEther.mul(1000))
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_SLIPPAGE));
    });

    it("should revert if a price limit is hit when taking future cash", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        await expect(
            futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(200), 1000, WeiPerEther.mul(100))
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_SLIPPAGE));
    });
});
