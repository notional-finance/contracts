import chai from "chai";
import {solidity} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, mineBlocks} from "./fixtures";
import {Wallet} from "ethers";
import {WeiPerEther, AddressZero} from "ethers/constants";

import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import { ErrorDecoder, ErrorCodes } from '../scripts/errorCodes';
import { Escrow } from '../typechain/Escrow';
import { Portfolios } from '../typechain/Portfolios';

chai.use(solidity);
const {expect} = chai;

enum SwapType {
    LIQUIDITY_TOKEN = "0xac",
    CASH_PAYER = "0x98",
    CASH_RECEIVER = "0xa8"
}

describe("Future Cash", () => {
    let dai: ERC20;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let rateAnchor: number;
    let futureCash: FutureCash;
    let escrow: Escrow;
    let portfolios: Portfolios;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;
        escrow = objs.escrow;
        portfolios = objs.portfolios;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);

        // Set the blockheight to the beginning of the next period
        let block = await provider.getBlockNumber();
        await mineBlocks(provider, 20 - (block % 20));
    });

    // maturities //
    it("should not allow add liquidity on invalid maturities", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(30));
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
        await escrow.depositEth({value: WeiPerEther.mul(200)});
        expect(await escrow.currencyBalances(AddressZero, owner.address)).to.equal(WeiPerEther.mul(200));
    });

    it("allows users to deposit dai", async () => {
        await dai.approve(escrow.address, WeiPerEther);
        await escrow.deposit(dai.address, WeiPerEther);
        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(WeiPerEther);
    });

    // withdraws //
    it("allows users to withdraw eth", async () => {
        const balance = await owner.getBalance();
        await escrow.depositEth({value: WeiPerEther});
        await escrow.withdrawEth(WeiPerEther.div(2));
        expect(await escrow.currencyBalances(AddressZero, owner.address)).to.equal(WeiPerEther.div(2));
        expect(balance.sub(await owner.getBalance())).to.be.at.least(WeiPerEther.div(2));
    });

    it("allows users to withdraw dai", async () => {
        const balance = await dai.balanceOf(owner.address);
        await dai.approve(futureCash.address, WeiPerEther);
        await escrow.deposit(dai.address, WeiPerEther);
        await escrow.withdraw(dai.address, WeiPerEther.div(2));
        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(WeiPerEther.div(2));
        expect(balance.sub(await dai.balanceOf(owner.address))).to.be.at.least(WeiPerEther.div(2));
    });

    it("prevents users from withdrawing more eth than they own", async () => {
        await escrow.depositEth({value: WeiPerEther});
        await expect(escrow.withdrawEth(WeiPerEther.mul(2)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
    });

    it("prevents users from withdrawing more dai than they own", async () => {
        await dai.approve(futureCash.address, WeiPerEther);
        await escrow.deposit(dai.address, WeiPerEther);
        await expect(escrow.withdraw(dai.address, WeiPerEther.mul(2)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
    });

    it("prevents users from withdrawing eth if they do not have enough collateral", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await escrow.connect(wallet).depositEth({value: WeiPerEther.div(10).mul(71)});
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(200), 1000, 0);
        // Remove the dai so only the ETH is collateralizing the CASH_PAYER
        await escrow.connect(wallet).withdraw(dai.address, await escrow.currencyBalances(dai.address, wallet.address));

        // We need 7 ETH to collateralize the account.
        await expect(escrow.connect(wallet).withdrawEth(WeiPerEther.div(10).mul(5)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));

        const beforeBalance = await wallet.getBalance();
        await expect(escrow.connect(wallet).withdrawEth(WeiPerEther.div(10).mul(1)))
            .to.not.be.reverted;
        // Not exact because of gas costs
        const afterBalance = await wallet.getBalance();
        expect(afterBalance).to.be.above(beforeBalance.add(WeiPerEther.div(100).mul(9)));
        expect(await escrow.currencyBalances(AddressZero, wallet.address)).to.equal(
            WeiPerEther.mul(7)
        );
    });

    it("prevents users from withdrawing dai if they do not have enough collateral", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(7)});
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(200), 1000, 0);
        // Remove most the ETH so only the dai is collateralizing the CASH_PAYER
        await escrow.connect(wallet).withdrawEth(WeiPerEther.mul(6));

        // We need about 200 Dai to collateralize the cash payer
        let balance = await dai.balanceOf(wallet.address);
        let daiBalance = await escrow.currencyBalances(dai.address, wallet.address);
        await expect(escrow.connect(wallet).withdraw(dai.address, WeiPerEther.mul(30)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));
        await expect(escrow.connect(wallet).withdraw(dai.address, WeiPerEther.mul(10))).to.not.be.reverted;
        expect(await dai.balanceOf(wallet.address)).to.equal(balance.add(WeiPerEther.mul(10)));
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(daiBalance.sub(WeiPerEther.mul(10)));
    });

    // liquidity tokens //
    it("should allow add liquidity", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(30));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);

        // Free collateral should not have changed
        expect((await portfolios.freeCollateralView(owner.address))[0]).to.equal(0);

        let trades = await portfolios.getTrades(owner.address);
        expect(trades.length).to.equal(2);
        expect(trades[0].swapType).to.equal(SwapType.LIQUIDITY_TOKEN);
        expect(trades[0].startBlock + trades[0].duration).to.equal(maturities[0]);
        expect(trades[0].notional).to.equal(WeiPerEther.mul(10));

        expect(trades[1].swapType).to.equal(SwapType.CASH_PAYER);
        expect(trades[1].startBlock + trades[1].duration).to.equal(maturities[0]);
        expect(trades[1].notional).to.equal(WeiPerEther.mul(10));
    });

    it("should not allow add liquidity if there is insufficient balance", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(5));
        await expect(futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UINT256_SUBTRACTION_UNDERFLOW));
    });

    it("should allow remove liquidity", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(30));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);

        await futureCash.removeLiquidity(maturities[0], WeiPerEther.mul(5), 1000);
        expect((await portfolios.freeCollateralView(owner.address))[0]).to.equal(WeiPerEther.mul(0));

        let trades = await portfolios.getTrades(owner.address);
        expect(trades.length).to.equal(2);
        expect(trades[0].swapType).to.equal(SwapType.LIQUIDITY_TOKEN);
        expect(trades[0].startBlock + trades[0].duration).to.equal(maturities[0]);
        expect(trades[0].notional).to.equal(WeiPerEther.mul(5));

        expect(trades[1].swapType).to.equal(SwapType.CASH_PAYER);
        expect(trades[0].startBlock + trades[0].duration).to.equal(maturities[0]);
        expect(trades[1].notional).to.equal(WeiPerEther.mul(5));
    });

    it("should allow not allow remove liquidity if the account does not have liquidty tokens", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(30));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);

        await expect(futureCash.removeLiquidity(maturities[0], WeiPerEther.mul(15), 1000))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UINT128_SUBTRACTION_UNDERFLOW));

        // This wallet does not have any liquidity tokens
        await expect(futureCash.connect(wallet).removeLiquidity(maturities[0], WeiPerEther.mul(15), 1000))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UINT128_SUBTRACTION_UNDERFLOW));
    });

    it("should not allow users to add liquidity to invalid periods", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await portfolios.updateInstrumentGroup(1, 0, 20, 1e9, 2, futureCash.address, AddressZero);
        await escrow.deposit(dai.address, WeiPerEther.mul(30));
        await expect(futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
    });

    it("should allow liquidity to roll", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(40));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);
        await futureCash.addLiquidity(maturities[1], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);
        await futureCash.addLiquidity(maturities[2], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);
        await futureCash.addLiquidity(maturities[3], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);

        // Take futureCash to change the liquidity amounts
        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(10));
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
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        // Deposit ETH as collateral for a loan.
        await escrow.connect(wallet).depositEth({value: WeiPerEther});
        let freeCollateral = (await portfolios.freeCollateralView(wallet.address))[0];
        const blockNum = await provider.getBlockNumber();
        let daiBalance = await futureCash.getFutureCashToCollateralBlock(maturities[0], WeiPerEther.mul(25), blockNum + 1);

        const marketBefore = await futureCash.markets(maturities[0]);
        // Deposit 25 dai in future cash, collateralized by an ETH
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(25), 1000, 0);
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(daiBalance);

        const marketAfter = await futureCash.markets(maturities[0]);
        expect(marketBefore.totalCollateral.sub(daiBalance)).to.equal(marketAfter.totalCollateral);
        expect(marketBefore.totalFutureCash.add(WeiPerEther.mul(25))).to.equal(marketAfter.totalFutureCash);

        let trades = await portfolios.getTrades(wallet.address);
        expect(trades.length).to.equal(1);
        expect(trades[0].swapType).to.equal(SwapType.CASH_PAYER);
        expect(trades[0].startBlock + trades[0].duration).to.equal(maturities[0]);
        expect(trades[0].notional).to.equal(WeiPerEther.mul(25));

        const freeCollateralAfter = (await portfolios.freeCollateralView(wallet.address))[0];
        expect(freeCollateral.sub(freeCollateralAfter)).to.be.above(0);
        await escrow.connect(wallet).withdraw(dai.address, daiBalance);
    });

    it("should not allow users to take dai for future cash if they do not have collateral", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await expect(futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(25), 1000, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));
    });

    it("should not allow users to take dai for future cash on an invalid maturity", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await portfolios.updateInstrumentGroup(1, 0, 20, 1e9, 2, futureCash.address, AddressZero);

        await escrow.connect(wallet).depositEth({value: WeiPerEther});
        await expect(futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(25), 1000, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
    });

    it("should not allow users to trade more future cash than the limit", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.setMaxTradeSize(WeiPerEther.mul(100));
        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(100)});
        await expect(futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(105), 1000, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_TOO_LARGE));
    });

    // take future cash //
    it("should allow users to take future cash for dai", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(11_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        // Do this first to prevent negative interest rates.
        await futureCash.takeCollateral(maturities[0], WeiPerEther.mul(1_000), 1000, 0);

        // Wallet needs to deposit Dai balance in order to take future cash
        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(100));
        const blockNum = await provider.getBlockNumber();
        const daiAmount = await futureCash.getCollateralToFutureCashBlock(maturities[0], WeiPerEther.mul(100), blockNum + 1);

        const marketBefore = await futureCash.markets(maturities[0]);
        expect(daiAmount).to.be.below(WeiPerEther.mul(100));
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, WeiPerEther.mul(100));
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(WeiPerEther.mul(100).sub(daiAmount));

        const marketAfter = await futureCash.markets(maturities[0]);
        expect(marketBefore.totalCollateral.add(daiAmount)).to.equal(marketAfter.totalCollateral);
        expect(marketBefore.totalFutureCash.sub(WeiPerEther.mul(100))).to.equal(marketAfter.totalFutureCash);

        let trades = await portfolios.getTrades(wallet.address);
        expect(trades.length).to.equal(1);
        expect(trades[0].swapType).to.equal(SwapType.CASH_RECEIVER);
        expect(trades[0].startBlock + trades[0].duration).to.equal(maturities[0]);
        expect(trades[0].notional).to.equal(WeiPerEther.mul(100));

        expect((await portfolios.freeCollateralView(wallet.address))[0]).to.equal(0);
    });

    it("should not allow users to take future cash for dai if they do not have collateral", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await expect(futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(25), 1000, WeiPerEther.mul(25)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UINT256_SUBTRACTION_UNDERFLOW));
    });

    it("should not allow users to take future cash for dai on an invalid maturity", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await portfolios.updateInstrumentGroup(1, 0, 20, 1e9, 2, futureCash.address, AddressZero);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(25));
        await expect(futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(25), 1000, WeiPerEther.mul(25)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
    });

    it("should not allow users to trade more future cash than the limit", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await futureCash.setMaxTradeSize(WeiPerEther.mul(100));
        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        await expect(futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(105), 1000, WeiPerEther.mul(105)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_TOO_LARGE));
    });

    // settle account //
    it("should settle accounts to cash", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await escrow.connect(wallet2).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet2).takeCollateral(maturities[0], WeiPerEther.mul(500), 1000, 0);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(100));
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, WeiPerEther.mul(100));

        await mineBlocks(provider, 20);

        await portfolios.settleAccount(wallet.address);
        await portfolios.settleAccountBatch([wallet2.address, owner.address]);

        expect(await portfolios.getTrades(owner.address)).to.have.lengthOf(0);
        expect(await portfolios.getTrades(wallet.address)).to.have.lengthOf(0);
        expect(await portfolios.getTrades(wallet2.address)).to.have.lengthOf(0);

        // Liquidity provider has earned some interest on liquidity
        expect(
            (await escrow.cashBalances(2, owner.address)).add(await escrow.currencyBalances(dai.address, owner.address))
        ).to.be.above(WeiPerEther.mul(10_000));
        expect(await escrow.currencyBalances(AddressZero, owner.address)).to.equal(0);

        // This is the negative balance owed as a fixed rate loan ("takeCollateral")
        expect(await escrow.cashBalances(2, wallet2.address)).to.equal(WeiPerEther.mul(-500));
        expect(await escrow.currencyBalances(AddressZero, wallet2.address)).to.equal(WeiPerEther.mul(5));

        // This is the lending amount, should be above what they put in
        expect(await escrow.cashBalances(2, wallet.address)).to.equal(WeiPerEther.mul(100));
        // There is some residual left in dai balances.
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.be.above(0);
        expect(await escrow.currencyBalances(AddressZero, wallet.address)).to.equal(0);

        // All cash balances have to net out to exactly zero
        expect(
            (await escrow.cashBalances(2, owner.address))
                .add(await escrow.cashBalances(2, wallet.address))
                .add(await escrow.cashBalances(2, wallet2.address))
        ).to.equal(0);
    });

    // price methods //
    it("should return a higher rate after someone has purchased dai (borrowed)", async () => {
        const maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        const impliedRateBefore = (await futureCash.markets(maturities[0])).lastImpliedRate;
        const blockNum1 = await provider.getBlockNumber();
        const cash = await futureCash.getFutureCashToCollateralBlock(maturities[0], WeiPerEther.mul(200), blockNum1 + 1);
        expect(cash).to.be.below(WeiPerEther.mul(200));

        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(200), 1000, 0);
        const blockNum2 = await provider.getBlockNumber();

        const impliedRateAfter = (await futureCash.markets(maturities[0])).lastImpliedRate;
        const tradeImpliedRate = (WeiPerEther.mul(200).mul(1e9).div(cash).sub(1e9)).mul(20).div(maturities[0] - blockNum2);
        // console.log(`Exchange Rate: ${exchangeRate}`);
        // console.log(`Implied Rate Before: ${impliedRateBefore}`);
        // console.log(`Implied Rate After: ${impliedRateAfter}`);
        // console.log(`Trade Implied Rate: ${tradeImpliedRate.toString()}`);

        // This should be impliedRateBefore < impliedRateAfter < tradeExchangeRate
        expect(impliedRateBefore).to.be.below(impliedRateAfter);
        expect(impliedRateAfter).to.be.below(tradeImpliedRate);
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(WeiPerEther.mul(1000).add(cash));
    });

    it("should return a lower rate after someone has purchased future cash (lending)", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        const impliedRateBefore = (await futureCash.markets(maturities[0])).lastImpliedRate;
        const blockNum1 = await provider.getBlockNumber();
        const cash = await futureCash.getCollateralToFutureCashBlock(maturities[0], WeiPerEther.mul(200), blockNum1 + 1);
        expect(cash).to.be.below(WeiPerEther.mul(200));

        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(200), 1000, WeiPerEther.mul(200));
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(WeiPerEther.mul(1000).sub(cash));
        const blockNum2 = await provider.getBlockNumber();

        const impliedRateAfter = (await futureCash.markets(maturities[0])).lastImpliedRate;
        const tradeImpliedRate = (WeiPerEther.mul(200).mul(1e9).div(cash).sub(1e9)).mul(20).div(maturities[0] - blockNum2);

        // console.log(`Implied Rate Before: ${impliedRateBefore}`);
        // console.log(`Implied Rate After: ${impliedRateAfter}`);
        // console.log(`Trade Implied Rate: ${tradeImpliedRate.toString()}`);
        // This should be impliedRateBefore > impliedRateAfter > tradeExchangeRate
        expect(impliedRateBefore).to.be.above(impliedRateAfter);
        expect(impliedRateAfter).to.be.above(tradeImpliedRate);
    });

    it("should return the spot exchange rate which converts to the last implied rate", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(100));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(100), WeiPerEther.mul(100), 1000);

        // The rate will be calculated at the next block...
        const blockNum = await provider.getBlockNumber();
        const rateMantissa = await futureCash.INSTRUMENT_PRECISION();
        const periodSize = await futureCash.G_PERIOD_SIZE();
        const lastImpliedRate = (await futureCash.markets(maturities[0])).lastImpliedRate;
        const spotRate = (await futureCash.getRate(maturities[0]))[0];
        expect(Math.trunc((spotRate - rateMantissa) * periodSize / (maturities[0] - blockNum))).to.equal(lastImpliedRate);
    });

    it("should revert if too much dai is taken", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(100));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(100), WeiPerEther.mul(100), 1000);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        // At 85 future cash the exchange rate explodes and gets too expensive.
        await expect(futureCash.getFutureCashToCollateral(maturities[0], WeiPerEther.mul(85)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ABDK_UINT256_OVERFLOW));
        await expect(futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(85), 1000, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ABDK_UINT256_OVERFLOW));
    });

    it("should revert if too much future cash is taken", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(100));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(100), WeiPerEther.mul(100), 1000);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        await expect(futureCash.getCollateralToFutureCash(maturities[0], WeiPerEther.mul(100)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ABDK_NEGATIVE_LOG));
        await expect(futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, WeiPerEther.mul(100)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ABDK_NEGATIVE_LOG));
    });

    // front running and price limits //
    it("should revert if a block limit is hit when taking dai", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        let blockNum = await provider.getBlockNumber();
        await expect(futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(200), blockNum - 1, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_MAX_BLOCK));
    });

    it("should revert if a block limit is hit when taking future cash", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        let blockNum = await provider.getBlockNumber();
        await expect(futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(200), blockNum - 1, 0))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_MAX_BLOCK));
    });

    it("should revert if a price limit is hit when taking dai", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        await expect(
            futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(200), 1000, WeiPerEther.mul(1000))
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_SLIPPAGE));
    });

    it("should revert if a price limit is hit when taking future cash", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        await expect(
            futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(200), 1000, WeiPerEther.mul(100))
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_SLIPPAGE));
    });
});
