import chai from "chai";
import {ethers} from "@nomiclabs/buidler";
import {solidity} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, mineBlocks} from "./fixtures";
import {Wallet} from "ethers";
import {WeiPerEther} from "ethers/constants";

import {UniswapExchangeInterface} from "../typechain/UniswapExchangeInterface";
import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import { ErrorDecoder, ErrorCodes } from '../scripts/errorCodes';

chai.use(solidity);
const {expect} = chai;

describe("Liquidation", () => {
    let dai: ERC20;
    let futureCash: FutureCash;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let uniswap: UniswapExchangeInterface;
    let maturities: number[];
    let rateAnchor: number;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;
        uniswap = objs.uniswap;

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
        // The fee is one basis point.
        await futureCash.setFee(10_000_000);

        // Set the blockheight to the beginning of the next period
        let block = await provider.getBlockNumber();
        await mineBlocks(provider, 20 - (block % 20));

        maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(30_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);
        await futureCash.addLiquidity(maturities[1], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);
        await futureCash.addLiquidity(maturities[2], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);
    });

    it("should settle not cash between accounts when there is insufficient cash balance", async () => {
        await futureCash.connect(wallet2).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet2).takeDai(maturities[0], WeiPerEther.mul(500), 1000, 0);

        await mineBlocks(provider, 20);
        await futureCash.settleBatch([wallet.address, owner.address]);
        await expect(futureCash.connect(wallet2).settleCash(owner.address, WeiPerEther.mul(250)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_CASH_BALANCE));
        await expect(futureCash.connect(wallet2).settleCash(owner.address, WeiPerEther.mul(-550)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_CASH_BALANCE));
        await expect(futureCash.settleCash(wallet2.address, WeiPerEther.mul(550)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_CASH_BALANCE));
    });

    it("should settle cash between accounts when there is enough dai", async () => {
        await futureCash.connect(wallet2).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet2).takeDai(maturities[0], WeiPerEther.mul(500), 1000, 0);

        await mineBlocks(provider, 20);
        await futureCash.settleBatch([wallet.address, owner.address]);

        let cashBalance = await futureCash.daiCashBalances(owner.address);
        let ownerDaiBalance = await futureCash.daiBalances(owner.address);
        let walletDaiBalance = await futureCash.daiBalances(wallet2.address);

        await futureCash.settleCash(wallet2.address, WeiPerEther.mul(250));
        expect(await futureCash.daiCashBalances(wallet2.address)).to.equal(WeiPerEther.mul(-250));
        expect(await futureCash.daiCashBalances(owner.address)).to.equal(cashBalance.sub(WeiPerEther.mul(250)));

        expect(await futureCash.daiBalances(owner.address)).to.equal(ownerDaiBalance.add(WeiPerEther.mul(250)));
        expect(await futureCash.daiBalances(wallet2.address)).to.equal(walletDaiBalance.sub(WeiPerEther.mul(250)));
    });

    it("should settle cash between accounts when eth must be sold", async () => {
        await futureCash.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(100), 1000, 0);
        // Withdraw all the dai so that there is only ETH in the account.
        await futureCash.connect(wallet).withdrawDai(await futureCash.daiBalances(wallet.address));

        await mineBlocks(provider, 20);
        await futureCash.settleBatch([wallet.address, owner.address]);
        let ownerDaiBalance = await futureCash.daiBalances(owner.address);

        await futureCash.settleCash(wallet.address, WeiPerEther.mul(100));
        expect(await futureCash.daiCashBalances(wallet.address)).to.equal(0);
        expect(await futureCash.daiCashBalances(owner.address)).to.equal(0);
        expect(await futureCash.daiBalances(owner.address)).to.equal(ownerDaiBalance.add(WeiPerEther.mul(100)));
        expect(await futureCash.daiBalances(wallet.address)).to.equal(0);
        expect(await futureCash.ethBalances(wallet.address)).to.be.below(WeiPerEther.mul(5));
    });

    it("should settle cash between accounts when eth and liquidty tokens must be sold", async () => {
        await futureCash.setHaircutSize(WeiPerEther.div(100).mul(90), WeiPerEther.add(WeiPerEther.div(100).mul(2)));

        await futureCash.connect(wallet).depositEth({value: WeiPerEther.mul(2)});
        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(100));
        await futureCash.connect(wallet).addLiquidity(maturities[1], WeiPerEther.mul(50), WeiPerEther.mul(50), 1000);
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(100), 1000, 0);
        // Withdraw all the dai so that there is only ETH in the account.
        await futureCash.connect(wallet).withdrawDai(await futureCash.daiBalances(wallet.address));

        await mineBlocks(provider, 20);
        await futureCash.settleBatch([wallet.address, owner.address]);
        let ownerDaiBalance = await futureCash.daiBalances(owner.address);

        await uniswap.ethToTokenSwapInput(WeiPerEther, ethers.constants.MaxUint256, {value: WeiPerEther.mul(4500)});
        let endingDaiBalance = WeiPerEther.mul(50).sub(
            WeiPerEther.mul(100).sub(await uniswap.getEthToTokenInputPrice(WeiPerEther.mul(2)))
        );
        expect(await futureCash.freeCollateral(wallet.address)).to.be.above(0);

        await futureCash.settleCash(wallet.address, WeiPerEther.mul(100));
        expect(await futureCash.daiCashBalances(wallet.address)).to.equal(0);
        expect(await futureCash.daiCashBalances(owner.address)).to.equal(0);
        expect(await futureCash.daiBalances(owner.address)).to.equal(ownerDaiBalance.add(WeiPerEther.mul(100)));
        expect(await futureCash.ethBalances(wallet.address)).to.equal(0);
        expect(await futureCash.daiBalances(wallet.address)).to.equal(endingDaiBalance);
        expect(await futureCash.getAccountTrades(wallet.address)).to.have.length(0);
    });

    // liquidate //
    it("should not liquidate an account that is properly collateralized", async () => {
        await futureCash.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(100), 1000, 0);
        expect(await futureCash.freeCollateral(wallet.address)).to.be.above(0);
        await expect(futureCash.liquidate(wallet.address))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL))
    });

    it("should liquidate an account when it is under collateralized by eth", async () => {
        await futureCash.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(100), 1000, 0);
        // Withdraw all the dai so that there is only ETH in the account.
        await futureCash.connect(wallet).withdrawDai(await futureCash.daiBalances(wallet.address));
        expect(await futureCash.daiBalances(wallet.address)).to.equal(0);
        expect(await futureCash.daiCashBalances(wallet.address)).to.equal(0);

        await uniswap.ethToTokenSwapInput(WeiPerEther, ethers.constants.MaxUint256, {value: WeiPerEther.mul(4500)});
        expect(await futureCash.freeCollateral(wallet.address)).to.be.below(0);

        let ethBalanceBefore = await futureCash.ethBalances(wallet.address);
        let portfolioBefore = await futureCash.getAccountTrades(wallet.address);
        // console.log(`ETH Balance Before: ${ethBalanceBefore.toString()}`)
        // console.log(`ETH Value: ${await uniswap.getEthToTokenInputPrice(ethBalanceBefore)}`)
        // console.log(`Free Collateral: ${await futureCash.freeCollateral(wallet.address)}`)
        await futureCash.liquidate(wallet.address);
        let ethBalanceAfter = await futureCash.ethBalances(wallet.address);
        let portfolioAfter = await futureCash.getAccountTrades(wallet.address);
        expect(ethBalanceAfter).to.be.below(ethBalanceBefore);
        expect(portfolioBefore[0].notional.sub(portfolioAfter[0].notional)).to.be.above(0);

        // console.log(`Dai Balance: ${(await futureCash.daiBalances(wallet.address)).toString()}`)
        // console.log(`ETH Balance After: ${ethBalanceAfter.toString()}`)
        // console.log(`ETH Value: ${await uniswap.getEthToTokenInputPrice(ethBalanceAfter)}`)
        // console.log(`ETH Sold: ${ethBalanceBefore.sub(ethBalanceAfter).toString()}`)
        // console.log(`Future Cash Sold: ${portfolioBefore[0].notional.sub(portfolioAfter[0].notional).toString()}`)
        // console.log(`Dai Raised: ${await uniswap.getEthToTokenInputPrice(ethBalanceBefore.sub(ethBalanceAfter))}`)
        // console.log(`Free Collateral: ${await futureCash.freeCollateral(wallet.address)}`)
        expect(await futureCash.freeCollateral(wallet.address)).to.be.above(0);
    });

    it.skip("should settle cash between accounts when cash_receiver must be partially sold", async () => {
        // There must be an initial cash_payer at maturity 0 to initiate a negative cash
        // balance and then a larger cash_receiver at maturity 1 to collateralize the negative
        // cash at maturity 0.
        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1200));
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(200), 1000, 0);
        await futureCash.connect(wallet).takeFutureCash(maturities[1], WeiPerEther.mul(500), 1000, 0);
        // Withdraw all the freeCollateral so that the CASH_RECEIVER is collateralizing the PAYER
        await futureCash.connect(wallet).withdrawDai(WeiPerEther.mul(1200));

        await mineBlocks(provider, 20);
        await futureCash.settleBatch([wallet.address, owner.address]);

        // These are all the variables to do before and after comparisons
        let marketBefore = await futureCash.markets(maturities[1]);
        let portfolioBefore = await futureCash.getAccountTrades(wallet.address);
        let ownerDaiBalance = await futureCash.daiBalances(owner.address);
        let walletDaiBalance = await futureCash.daiBalances(wallet.address);
        let requiredFutureCash = await futureCash.getFutureCashToDaiOutput(
            maturities[1],
            WeiPerEther.mul(200).sub(walletDaiBalance)
        );

        let cashBalance = await futureCash.daiCashBalances(owner.address);
        expect((await futureCash.daiCashBalances(wallet.address)).add(cashBalance)).to.equal(0);

        // SETTLE CASH: 200 Dai
        await futureCash.settleCash(wallet.address, cashBalance);

        // Assert that balances have transferred.
        expect(await futureCash.daiCashBalances(wallet.address)).to.equal(0);
        expect(await futureCash.daiBalances(wallet.address)).to.equal(0);
        expect(await futureCash.daiCashBalances(owner.address)).to.equal(0);
        expect(await futureCash.daiBalances(owner.address)).to.equal(ownerDaiBalance.add(cashBalance));

        // Portfolio
        // We should have sold part of the cash receiver tokens.
        let portfolioAfter = await futureCash.getAccountTrades(wallet.address);
        expect(portfolioAfter.length).to.equal(1);
        expect(portfolioAfter[0].tradeType).to.equal(2);
        expect(portfolioAfter[0].maturity).to.equal(60);
        expect(portfolioBefore[0].notional.sub(requiredFutureCash)).to.equal(portfolioAfter[0].notional);

        // Markets
        let marketAfter = await futureCash.markets(maturities[1]);
        expect(marketBefore.totalCollateral.sub(WeiPerEther.mul(200).sub(walletDaiBalance))).to.equal(
            marketAfter.totalCollateral
        );
        expect(marketBefore.totalLiquidity).to.equal(marketAfter.totalLiquidity);
        expect(marketBefore.totalFutureCash.add(requiredFutureCash)).to.equal(marketAfter.totalFutureCash);
    });

    it.skip("should settle cash between accounts when cash_receiver must be fully sold", async () => {
        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(2000));
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(200), 1000, 0);
        await futureCash.connect(wallet).takeFutureCash(maturities[2], WeiPerEther.mul(600), 1000, 0);
        await futureCash.connect(wallet).takeFutureCash(maturities[1], WeiPerEther.mul(10), 1000, 0);
        // Withdraw all the freeCollateral so that the CASH_RECEIVER is collateralizing the PAYER
        await futureCash.connect(wallet).withdrawDai(await futureCash.freeCollateral(wallet.address));
        /*
        console.log(await futureCash.freeCollateral(wallet.address));
        console.log(await futureCash.daiBalances(wallet.address));

        // These are all the variables to do before and after comparisons
        let marketBefore = await futureCash.markets(maturities[1]);
        let portfolioBefore = await futureCash.getAccountTrades(wallet.address);
        console.log(portfolioBefore);

        await mineBlocks(provider, 20);
        await futureCash.settleBatch([wallet.address, owner.address]);

        let cashBalance = await futureCash.daiCashBalances(owner.address);
        console.log(cashBalance);
        expect((await futureCash.daiCashBalances(wallet.address)).add(cashBalance)).to.equal(0);

        // SETTLE CASH: 200 Dai
        await futureCash.settleCash(wallet.address, cashBalance);

        let portfolioAfter = await futureCash.getAccountTrades(wallet.address);
        console.log(portfolioAfter);
        */
    });

    it.skip("should settle cash with the dai portion of the liquidity token", async () => {
        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(200), 1000, 0);
        await futureCash.connect(wallet).addLiquidity(maturities[1], WeiPerEther.mul(500), WeiPerEther.mul(500), 1000);
        // Withdraw all the dai so that the LIQUIDITY_TOKEN is collateralizing the PAYER
        await futureCash.connect(wallet).withdrawDai(await futureCash.freeCollateral(wallet.address));

        await mineBlocks(provider, 20);
        await futureCash.settleBatch([wallet.address, owner.address]);

        // These are all the variables to do before and after comparisons
        let marketBefore = await futureCash.markets(maturities[1]);
        let ownerDaiBalance = await futureCash.daiBalances(owner.address);
        let walletDaiBalance = await futureCash.daiBalances(wallet.address);
        let valueBefore = await futureCash.getTokenValue(maturities[1], WeiPerEther.mul(500));

        // This is the Dai part of the token that we will give back.
        let daiRequiredToRaise = WeiPerEther.mul(200).sub(walletDaiBalance);
        let daiBalanceAfter = valueBefore[0].sub(daiRequiredToRaise);

        let cashBalance = await futureCash.daiCashBalances(owner.address);
        expect((await futureCash.daiCashBalances(wallet.address)).add(cashBalance)).to.equal(0);

        // SETTLE CASH: 200 Dai
        await futureCash.settleCash(wallet.address, cashBalance);

        // Assert that balances have transferred.
        expect(await futureCash.daiBalances(wallet.address)).to.equal(daiBalanceAfter);
        expect(await futureCash.daiCashBalances(wallet.address)).to.equal(0);
        expect(await futureCash.daiCashBalances(owner.address)).to.equal(0);
        expect(await futureCash.daiBalances(owner.address)).to.equal(ownerDaiBalance.add(cashBalance));

        // Portfolio
        // We should have sold all of the tokens and the cash payer has been removed.
        let portfolioAfter = await futureCash.getAccountTrades(wallet.address);
        expect(portfolioAfter.length).to.equal(0);

        // Check market differences
        let marketsAfter = await futureCash.markets(maturities[1]);
        // Should have taken out all the dai and future cash the token represents
        expect(marketBefore.totalCollateral.sub(marketsAfter.totalCollateral)).to.equal(valueBefore[0]);
        expect(marketBefore.totalLiquidity.sub(marketsAfter.totalLiquidity)).to.equal(WeiPerEther.mul(500));
        // In this scenario we started with + 500 liquidity tokens, -500 cash payer => + 500 Dai, + 500 cash receiver
        // The net change in future cash is 0
        expect(marketBefore.totalFutureCash.sub(marketsAfter.totalFutureCash)).to.equal(0);
    });

    it.skip("should settle cash with the dai and future cash portion of the liquidity token", async () => {
        await futureCash.connect(wallet).depositDai(WeiPerEther.mul(1000));
        await futureCash.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeDai(maturities[0], WeiPerEther.mul(200), 1000, 0);
        await futureCash.connect(wallet).addLiquidity(maturities[1], WeiPerEther.mul(150), WeiPerEther.mul(150), 100);
        // Nets out CASH_PAYER, also test: cash receiver
        await futureCash.connect(wallet).takeFutureCash(maturities[1], WeiPerEther.mul(150), 1000, 0);
        await futureCash.connect(wallet).withdrawDai(await futureCash.daiBalances(wallet.address));

        await mineBlocks(provider, 20);
        await futureCash.settleBatch([wallet.address, owner.address]);
        /*
        console.log(await futureCash.freeCollateral(wallet.address));

        // These are all the variables to do before and after comparisons
        let marketBefore = await futureCash.markets(maturities[1]);
        let ownerDaiBalance = await futureCash.daiBalances(owner.address);
        let walletDaiBalance = await futureCash.daiBalances(wallet.address);
        let valueBefore = await futureCash.getTokenValue(maturities[1], WeiPerEther.mul(150));

        // This is the Dai part of the token that we will give back.
        let daiRequiredToRaise = WeiPerEther.mul(150).sub(walletDaiBalance);
        let daiBalanceAfter = valueBefore[0].sub(daiRequiredToRaise);

        // SETTLE CASH: 200 Dai
        let cashBalance = await futureCash.daiCashBalances(owner.address);
        await futureCash.settleCash(wallet.address, cashBalance);

        // Assert that balances have transferred.
        // expect(await futureCash.daiBalances(wallet.address)).to.equal(daiBalanceAfter);
        expect(await futureCash.daiCashBalances(wallet.address)).to.equal(0);
        expect(await futureCash.daiCashBalances(owner.address)).to.equal(0);
        expect(await futureCash.daiBalances(owner.address)).to.equal(ownerDaiBalance.add(cashBalance));
        */
    });
    it.skip("should settle cash with both cash_receiver and liquidity tokens", async () => {});
});
