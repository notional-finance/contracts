import chai from "chai";
import {ethers} from "@nomiclabs/buidler";
import {solidity} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, mineBlocks} from "./fixtures";
import {Wallet} from "ethers";
import {WeiPerEther, AddressZero} from "ethers/constants";

import {UniswapExchangeInterface} from "../typechain/UniswapExchangeInterface";
import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import { ErrorDecoder, ErrorCodes } from '../scripts/errorCodes';
import { Escrow } from '../typechain/Escrow';
import { Portfolios } from '../typechain/Portfolios';
import { MockAggregator } from '../typechain/MockAggregator';
import { BigNumber } from 'ethers/utils';

chai.use(solidity);
const {expect} = chai;

describe("Liquidation", () => {
    let dai: ERC20;
    let futureCash: FutureCash;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let chainlink: MockAggregator;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let uniswap: UniswapExchangeInterface;
    let maturities: number[];
    let rateAnchor: number;

    afterEach(async () => {
        // This method tests invariants that must hold at the end of each test.
        const totalDaiBalance = await dai.balanceOf(escrow.address);
        const marketBalance = await escrow.currencyBalances(dai.address, futureCash.address);
        const ownerBalance = await escrow.currencyBalances(dai.address, owner.address);
        const walletBalance = await escrow.currencyBalances(dai.address, wallet.address);
        const wallet2Balance = await escrow.currencyBalances(dai.address, wallet2.address);

        expect(marketBalance.add(ownerBalance).add(walletBalance).add(wallet2Balance))
            .to.equal(totalDaiBalance, "Dai Balances Do Not Net Out");

        const maturities = await futureCash.getActiveMaturities();
        const markets = await Promise.all(maturities.map((m) => { return futureCash.markets(m) }));
        const aggregateCollateral = markets.reduce((val, market) => {
            return val.add(market.totalCollateral);
        }, new BigNumber(0));

        expect(aggregateCollateral).to.equal(marketBalance, "Market Balance does not equal aggregate collateral");

        const ownerCash = await escrow.cashBalances(2, owner.address);
        const walletCash = await escrow.cashBalances(2, wallet.address);
        const wallet2Cash = await escrow.cashBalances(2, wallet2.address);
        expect(ownerCash.add(walletCash).add(wallet2Cash)).to.equal(0, "Cash balances do not net out");
    });

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;
        uniswap = objs.uniswap;
        escrow = objs.escrow;
        portfolios = objs.portfolios;
        chainlink = objs.chainlink;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));

        await futureCash.setMaxTradeSize(WeiPerEther.mul(10_000));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);
        // The fee is one basis point.
        await futureCash.setFee(10_000_000, 0);

        // Set the blockheight to the beginning of the next period
        let block = await provider.getBlockNumber();
        await mineBlocks(provider, 20 - (block % 20));

        maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(30_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);
        await futureCash.addLiquidity(maturities[1], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);
        await futureCash.addLiquidity(maturities[2], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);
    });

    it("should settle not cash between accounts when there is insufficient cash balance", async () => {
        await escrow.connect(wallet2).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet2).takeCollateral(maturities[0], WeiPerEther.mul(500), 1000, 0);

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet.address, owner.address, wallet2.address]);
        await expect(escrow.connect(wallet2).settleCashBalance(2, owner.address, wallet2.address, WeiPerEther.mul(250), false))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INCORRECT_CASH_BALANCE));
        await expect(escrow.settleCashBalance(2, wallet2.address, owner.address, WeiPerEther.mul(550), false))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INCORRECT_CASH_BALANCE));
    });

    it("should settle cash between accounts when there is enough dai", async () => {
        await escrow.connect(wallet2).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet2).takeCollateral(maturities[0], WeiPerEther.mul(500), 1000, 0);

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet2.address, owner.address]);

        let cashBalance = await escrow.cashBalances(2, owner.address);
        let ownerDaiBalance = await escrow.currencyBalances(dai.address, owner.address);
        let walletDaiBalance = await escrow.currencyBalances(dai.address, wallet2.address);

        await escrow.settleCashBalance(2, wallet2.address, owner.address, WeiPerEther.mul(250), false);
        expect(await escrow.cashBalances(2, wallet2.address)).to.equal(WeiPerEther.mul(-250));
        expect(await escrow.cashBalances(2, owner.address)).to.equal(cashBalance.sub(WeiPerEther.mul(250)));

        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(ownerDaiBalance.add(WeiPerEther.mul(250)));
        expect(await escrow.currencyBalances(dai.address, wallet2.address)).to.equal(walletDaiBalance.sub(WeiPerEther.mul(250)));
    });

    it("should settle cash between accounts when eth must be sold via uniswap", async () => {
        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(100), 1000, 0);
        // Withdraw all the dai so that there is only ETH in the account.
        await escrow.connect(wallet).withdraw(dai.address, await escrow.currencyBalances(dai.address, wallet.address));

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet.address, owner.address]);
        let ownerDaiBalance = await escrow.currencyBalances(dai.address, owner.address);

        await escrow.settleCashBalance(2, wallet.address, owner.address, WeiPerEther.mul(100), false);
        expect(await escrow.cashBalances(2, wallet.address)).to.equal(0);
        expect(await escrow.cashBalances(2, owner.address)).to.equal(0);
        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(ownerDaiBalance.add(WeiPerEther.mul(100)));
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(0);
        expect(await escrow.currencyBalances(AddressZero, wallet.address)).to.be.below(WeiPerEther.mul(5));
    });

    it("should revert when eth must be sold via uniswap and the price is out of line", async () => {
        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(100), 1000, 0);
        // Withdraw all the dai so that there is only ETH in the account.
        await escrow.connect(wallet).withdraw(dai.address, await escrow.currencyBalances(dai.address, wallet.address));

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet.address, owner.address]);
        await chainlink.setAnswer(WeiPerEther.div(90));

        await expect(escrow.settleCashBalance(2, wallet.address, owner.address, WeiPerEther.mul(100), false))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_SETTLE_PRICE_DISCREPENCY));
    });

    it("should revert when eth must be sold via uniswap and the slippage would be too great", async () => {
        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(100), 1000, 0);
        // Withdraw all the dai so that there is only ETH in the account.
        await escrow.connect(wallet).withdraw(dai.address, await escrow.currencyBalances(dai.address, wallet.address));

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet.address, owner.address]);
        // Withdraw all the liquidity from the uniswap market so the slippage is huge.
        const currentBlock = await provider.getBlock(await provider.getBlockNumber());
        await uniswap.removeLiquidity(
            WeiPerEther.mul(9_990),
            WeiPerEther,
            WeiPerEther,
            currentBlock.timestamp + 300
        );

        await expect(escrow.settleCashBalance(2, wallet.address, owner.address, WeiPerEther.mul(100), false))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_SETTLE_PRICE_DISCREPENCY));
    });

    it("should settle cash between accounts when eth must be sold via an account", async () => {
        await escrow.connect(wallet2).deposit(dai.address, WeiPerEther.mul(1000));
        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(100), 1000, 0);
        // Withdraw all the dai so that there is only ETH in the account.
        await escrow.connect(wallet).withdraw(dai.address, await escrow.currencyBalances(dai.address, wallet.address));

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet.address, owner.address]);
        // Wallet2 will settle cash on behalf of owner
        let ownerDaiBalance = await escrow.currencyBalances(dai.address, owner.address);
        await escrow.connect(wallet2).settleCashBalance(2, wallet.address, owner.address, WeiPerEther.mul(100), false);

        expect(await escrow.cashBalances(2, wallet.address)).to.equal(0);
        expect(await escrow.cashBalances(2, owner.address)).to.equal(0);
        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(ownerDaiBalance.add(WeiPerEther.mul(100)));
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(0);

        // Purchased 100 Dai at a price of 1.05 ETH
        expect(await escrow.currencyBalances(AddressZero, wallet.address)).to.equal(WeiPerEther.div(100).mul(395));
        expect(await escrow.currencyBalances(AddressZero, wallet2.address)).to.equal(WeiPerEther.div(100).mul(105));

        // 100 Dai has been transfered to the owner wallet in exchange for ETH.
        expect(await escrow.currencyBalances(dai.address, wallet2.address)).to.equal(WeiPerEther.mul(900));
    });

    it("should partially settle cash when the account is undercollateralized", async () => {
        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(100), 1000, 0);
        // Withdraw half the Dai so there is some left
        const daiLeft = (await escrow.currencyBalances(dai.address, wallet.address)).sub(WeiPerEther.mul(70));
        await escrow.connect(wallet).withdraw(dai.address, WeiPerEther.mul(70));

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet.address, owner.address]);

        // ETH price has moved, portfolio is undercollateralized
        await chainlink.setAnswer(WeiPerEther);
        let ownerDaiBalance = await escrow.currencyBalances(dai.address, owner.address);
        expect((await portfolios.freeCollateralView(wallet.address))[0]).to.be.below(0);

        await escrow.settleCashBalance(2, wallet.address, owner.address, WeiPerEther.mul(100), false);

        expect(await escrow.cashBalances(2, wallet.address)).to.equal(WeiPerEther.mul(100).sub(daiLeft).mul(-1));
        expect(await escrow.cashBalances(2, owner.address)).to.equal(WeiPerEther.mul(100).sub(daiLeft));
        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(ownerDaiBalance.add(daiLeft));
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(0);

        // The account will remain undercollateralized and the ETH has not moved
        expect((await portfolios.freeCollateralView(wallet.address))[0]).to.be.below(0);
        expect(await escrow.currencyBalances(AddressZero, wallet.address)).to.equal(WeiPerEther.mul(5));
    });

    it("should sell future cash to settle cash", async () => {
        // The account needs to have a negative cash balance and positive future cash. It also needs to
        // have zero ETH in the account, so it must have been liquidated ahead of time.
        await escrow.setReserveAccount(wallet2.address);
        await escrow.connect(wallet2).deposit(dai.address, WeiPerEther.mul(1000));

        await escrow.deposit(dai.address, WeiPerEther.mul(1000));
        await escrow.addExchangeRate(2, 1, chainlink.address, uniswap.address, WeiPerEther.div(100).mul(90));

        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(2)});
        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(100));

        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(120), 1000, 0);
        await futureCash.connect(wallet).takeFutureCash(maturities[1], WeiPerEther.mul(100), 1000, WeiPerEther.mul(1000));
        // Withdraw all the dai so that there is only ETH in the account.
        await escrow.connect(wallet).withdraw(dai.address, await escrow.currencyBalances(dai.address, wallet.address));

        await chainlink.setAnswer(WeiPerEther);
        await escrow.liquidate(wallet.address, 2);
        // We should have cleaned out the ETH currency balance.
        expect(await escrow.currencyBalances(AddressZero, wallet.address)).to.equal(0);
        // This account is still undercollateralized
        expect((await portfolios.freeCollateralView(wallet.address))[0]).to.be.below(0);

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet.address, owner.address]);

        const walletCashBalance = await escrow.cashBalances(2, wallet.address);
        const ownerCashBalance = await escrow.cashBalances(2, owner.address);
        const ownerDaiBalance = await escrow.currencyBalances(dai.address, owner.address);
        const walletDaiBalance = await escrow.currencyBalances(dai.address, wallet.address);
        expect(walletCashBalance.add(ownerCashBalance)).to.equal(0);

        const blockNum = await provider.getBlockNumber();
        const futureCashPrice = await futureCash.getFutureCashToCollateralBlock(maturities[1], WeiPerEther.mul(100), blockNum + 1);
        await escrow.settleCashBalance(2, wallet.address, owner.address, ownerCashBalance, false);
        expect(await escrow.cashBalances(2, owner.address)).to.equal(0)
        expect(await escrow.cashBalances(2, wallet.address)).to.equal(0)
        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(ownerDaiBalance.add(ownerCashBalance));

        // Expect future cash to be sold and part of the reserve to be reduced
        expect(await portfolios.getTrades(wallet.address)).to.have.lengthOf(0);
        const reserveBalance = await escrow.currencyBalances(dai.address, wallet2.address);
        // The difference from what the wallet has and the cash balance will come from the reserve fund
        expect(ownerCashBalance.sub(futureCashPrice).sub(walletDaiBalance)).to.equal(WeiPerEther.mul(1000).sub(reserveBalance));
    });

    it("should settle cash between accounts when eth and liquidty tokens must be sold", async () => {
        await escrow.addExchangeRate(2, 1, chainlink.address, uniswap.address, WeiPerEther.div(100).mul(90));

        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(2)});
        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(100));
        await futureCash.connect(wallet).addLiquidity(maturities[1], WeiPerEther.mul(50), WeiPerEther.mul(50), 1000);
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(100), 1000, 0);
        // Withdraw all the dai so that there is only ETH in the account.
        await escrow.connect(wallet).withdraw(dai.address, await escrow.currencyBalances(dai.address, wallet.address));

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet.address, owner.address]);
        let ownerDaiBalance = await escrow.currencyBalances(dai.address, owner.address);

        await uniswap.ethToTokenSwapInput(WeiPerEther, ethers.constants.MaxUint256, {value: WeiPerEther.mul(4500)});
        const ethToSell = await uniswap.getEthToTokenOutputPrice(WeiPerEther.mul(50));
        const rate = WeiPerEther.mul(WeiPerEther).div(await uniswap.getEthToTokenInputPrice(WeiPerEther));
        await chainlink.setAnswer(rate);
        expect((await portfolios.freeCollateralView(wallet.address))[0]).to.be.above(0);

        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(0);
        await escrow.settleCashBalance(2, wallet.address, owner.address, WeiPerEther.mul(100), false);
        expect(await escrow.cashBalances(2, wallet.address)).to.equal(0);
        expect(await escrow.cashBalances(2, owner.address)).to.equal(0);
        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(ownerDaiBalance.add(WeiPerEther.mul(100)));
        // Here we should have removed all the liquidity tokens to raise 50 dai to pay off half of the debt and sold the equivalent
        // of 50 Dai of ETH to cover the rest.
        const portfolioAfter = await portfolios.getTrades(wallet.address);
        expect(portfolioAfter).to.have.length(0);
        expect(await escrow.currencyBalances(AddressZero, wallet.address)).to.equal(WeiPerEther.mul(2).sub(ethToSell));
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(0);
    });

    it("should settle cash with the dai portion of the liquidity token", async () => {
        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(200), 1000, 0);
        await futureCash.connect(wallet).addLiquidity(maturities[1], WeiPerEther.mul(500), WeiPerEther.mul(500), 1000);
        const daiBalance = await escrow.currencyBalances(dai.address, wallet.address);
        // At this point the dai claim in the liquidity tokens is collateralizing the payer. Leave 100 dai in just to
        // test that we will settle both properly.
        await escrow.connect(wallet).withdraw(dai.address, daiBalance.sub(WeiPerEther.mul(100)));

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet.address, owner.address]);

        // These are all the variables to do before and after comparisons
        const marketBefore = await futureCash.markets(maturities[1]);
        const ownerDaiBalance = await escrow.currencyBalances(dai.address, owner.address);

        const cashBalance = await escrow.cashBalances(2, owner.address);
        expect((await escrow.cashBalances(2, wallet.address)).add(cashBalance)).to.equal(0);

        // SETTLE CASH: 200 Dai
        await escrow.settleCashBalance(2, wallet.address, owner.address, cashBalance, false);

        // Assert that balances have transferred.
        expect(await escrow.cashBalances(2, wallet.address)).to.equal(0);
        expect(await escrow.cashBalances(2, owner.address)).to.equal(0);
        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(ownerDaiBalance.add(cashBalance));
        // This is 100 from liquidity tokens + 100 from dai - 200 cash payout.
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(0);

        // Portfolio: we should have sold part of the tokens and the cash payer has updated
        const portfolioAfter = await portfolios.getTrades(wallet.address);
        expect(portfolioAfter.length).to.equal(2);
        expect(portfolioAfter[0].notional).to.equal(WeiPerEther.mul(400));
        expect(portfolioAfter[1].notional).to.equal(WeiPerEther.mul(400));

        // Check market differences
        const marketsAfter = await futureCash.markets(maturities[1]);
        // Should have taken out all the dai and future cash the token represents
        expect(marketBefore.totalCollateral.sub(marketsAfter.totalCollateral)).to.equal(WeiPerEther.mul(100));
        expect(marketBefore.totalLiquidity.sub(marketsAfter.totalLiquidity)).to.equal(WeiPerEther.mul(100));
        expect(marketBefore.totalFutureCash.sub(marketsAfter.totalFutureCash)).to.equal(WeiPerEther.mul(100));
    });

    it("should settle cash with the entire liquidity token", async () => {
        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(200), 1000, 0);
        await futureCash.connect(wallet).addLiquidity(maturities[1], WeiPerEther.mul(200), WeiPerEther.mul(200), 1000);
        await futureCash.connect(wallet).addLiquidity(maturities[2], WeiPerEther.mul(200), WeiPerEther.mul(200), 1000);
        const daiBalance = await escrow.currencyBalances(dai.address, wallet.address);
        // At this point the dai claim in the liquidity tokens is collateralizing the payer.
        await escrow.connect(wallet).withdraw(dai.address, daiBalance);

        await mineBlocks(provider, 20);
        await portfolios.settleAccountBatch([wallet.address, owner.address]);

        // These are all the variables to do before and after comparisons
        const marketBefore = await futureCash.markets(maturities[1]);
        const ownerDaiBalance = await escrow.currencyBalances(dai.address, owner.address);

        const cashBalance = await escrow.cashBalances(2, owner.address);
        expect((await escrow.cashBalances(2, wallet.address)).add(cashBalance)).to.equal(0);

        // SETTLE CASH: 200 Dai
        await escrow.settleCashBalance(2, wallet.address, owner.address, cashBalance, false);

        // Assert that balances have transferred.
        expect(await escrow.cashBalances(2, wallet.address)).to.equal(0);
        expect(await escrow.cashBalances(2, owner.address)).to.equal(0);
        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(ownerDaiBalance.add(cashBalance));
        // This is 200 from liquidity tokens + 0 from dai - 200 cash payout.
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(0);

        // Portfolio: we should have sold all of the tokens and the cash payer has been removed.
        const portfolioAfter = await portfolios.getTrades(wallet.address);
        expect(portfolioAfter.length).to.equal(2);
        expect(portfolioAfter[0].startBlock + portfolioAfter[0].duration).to.equal(maturities[2]);
        expect(portfolioAfter[1].startBlock + portfolioAfter[1].duration).to.equal(maturities[2]);

        // Check market differences
        const marketsAfter = await futureCash.markets(maturities[1]);
        // Should have taken out all the dai and future cash the token represents
        expect(marketBefore.totalCollateral.sub(marketsAfter.totalCollateral)).to.equal(WeiPerEther.mul(200));
        expect(marketBefore.totalLiquidity.sub(marketsAfter.totalLiquidity)).to.equal(WeiPerEther.mul(200));
        expect(marketBefore.totalFutureCash.sub(marketsAfter.totalFutureCash)).to.equal(WeiPerEther.mul(200));
    });

    // liquidate //
    it("should not liquidate an account that is properly collateralized", async () => {
        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(100), 1000, 0);
        expect((await portfolios.freeCollateralView(wallet.address))[0]).to.be.above(0);
        await expect(escrow.liquidate(wallet.address, 2))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL))
    });

    it("should liquidate an account when it is under collateralized by eth", async () => {
        await escrow.deposit(dai.address, WeiPerEther.mul(1000));
        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(5)});
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(100), 1000, 0);

        await escrow.connect(wallet).withdraw(dai.address, await escrow.currencyBalances(dai.address, wallet.address));
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(0);
        expect(await escrow.cashBalances(2, wallet.address)).to.equal(0);

        // Change this via chainlink
        await chainlink.setAnswer(WeiPerEther.div(50));
        expect((await portfolios.freeCollateralView(wallet.address))[0]).to.be.below(0);

        let ethBalanceBefore = await escrow.currencyBalances(AddressZero, wallet.address);
        // let portfolioBefore = await portfolios.getTrades(wallet.address);
        // console.log(`ETH Balance Before: ${ethBalanceBefore.toString()}`)
        // console.log(`ETH Value: ${await uniswap.getEthToTokenInputPrice(ethBalanceBefore)}`)
        // console.log(`Free Collateral: ${await (portfolios.freeCollateralView(wallet.address))[0]}`)
        const blockNum = await provider.getBlockNumber();
        const closeOutCost = await futureCash.getCollateralToFutureCashBlock(maturities[0], WeiPerEther.mul(100), blockNum + 1);
        await escrow.liquidate(wallet.address, 2);
        let ethBalanceAfter = await escrow.currencyBalances(AddressZero, wallet.address);

        // Liquidator Purchased 2.1 ETH for 105 Dai
        expect(ethBalanceBefore.sub(ethBalanceAfter)).to.equal(WeiPerEther.div(10).mul(21));
        expect((await escrow.currencyBalances(AddressZero, owner.address))).to.equal(WeiPerEther.div(10).mul(21));
        expect((await escrow.currencyBalances(dai.address, owner.address))).to.equal(WeiPerEther.mul(895));
        // TODO: Remaining Dai should be in the portfolio
        const remainingDai = await escrow.currencyBalances(dai.address, wallet.address);
        expect(closeOutCost.add(remainingDai)).to.equal(WeiPerEther.mul(105));

        const portfolioAfter = await portfolios.getTrades(wallet.address);
        expect(portfolioAfter.length).to.equal(0);

        // console.log(`Dai Balance: ${(await escrow.currencyBalances(dai.address, wallet.address)).toString()}`)
        // console.log(`ETH Balance After: ${ethBalanceAfter.toString()}`)
        // console.log(`ETH Value: ${await uniswap.getEthToTokenInputPrice(ethBalanceAfter)}`)
        // console.log(`ETH Sold: ${ethBalanceBefore.sub(ethBalanceAfter).toString()}`)
        // console.log(`Future Cash Sold: ${portfolioBefore[0].notional.sub(portfolioAfter[0].notional).toString()}`)
        // console.log(`Dai Raised: ${await uniswap.getEthToTokenInputPrice(ethBalanceBefore.sub(ethBalanceAfter))}`)
        // console.log(`Free Collateral: ${await (portfolios.freeCollateralView(wallet.address))[0]}`)
        expect((await portfolios.freeCollateralView(wallet.address))[0]).to.be.above(0);
    });

    it("should liquidate an account when it is under collateralized by eth and dai", async () => {
        await escrow.deposit(dai.address, WeiPerEther.mul(1000));
        await escrow.connect(wallet).depositEth({value: WeiPerEther.mul(2)});
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(100), 1000, 0);

        // Withdraw half the Dai so there is some left
        const daiLeft = (await escrow.currencyBalances(dai.address, wallet.address)).sub(WeiPerEther.mul(50));
        await escrow.connect(wallet).withdraw(dai.address, WeiPerEther.mul(50));
        expect(await escrow.cashBalances(2, wallet.address)).to.equal(0);

        // Change this via chainlink
        await chainlink.setAnswer(WeiPerEther.div(50));
        // const freeCollateral = (await portfolios.freeCollateralView(wallet.address))[0];
        expect((await portfolios.freeCollateralView(wallet.address))[0]).to.be.below(0);

        let ethBalanceBefore = await escrow.currencyBalances(AddressZero, wallet.address);
        let portfolioBefore = await portfolios.getTrades(wallet.address);
        const blockNum = await provider.getBlockNumber();
        // This is hardcoded since it's a bit tricky to get this calculation
        const closeOutCost = await futureCash.getCollateralToFutureCashBlock(maturities[0], "0x033429c60d1a8a958d", blockNum + 1);

        await escrow.liquidate(wallet.address, 2);
        let ethBalanceAfter = await escrow.currencyBalances(AddressZero, wallet.address);
        const portfolioAfter = await portfolios.getTrades(wallet.address);

        // Liquidator Purchased 2.1 ETH for 105 Dai
        const liquidationBonus = await escrow.G_LIQUIDATION_DISCOUNT();
        const portfolioHaircut = WeiPerEther.add(WeiPerEther.div(100).mul(5));
        const daiShortfall = WeiPerEther.mul(100).mul(portfolioHaircut).div(WeiPerEther)
        const ethPurchased = daiShortfall.sub(daiLeft).div(50).mul(liquidationBonus).div(WeiPerEther);

        expect(ethBalanceBefore.sub(ethBalanceAfter)).to.equal(ethPurchased);
        expect((await escrow.currencyBalances(AddressZero, owner.address))).to.equal(ethPurchased);
        expect((await escrow.currencyBalances(dai.address, owner.address))).to.equal(WeiPerEther.mul(1000).sub(daiShortfall.sub(daiLeft)));

        // TODO: Remaining Dai should be in the portfolio
        const remainingDai = await escrow.currencyBalances(dai.address, wallet.address);
        expect(closeOutCost.add(remainingDai)).to.equal(daiShortfall);

        expect(portfolioAfter.length).to.equal(1);
        expect(portfolioAfter[0].notional).to.be.below(portfolioBefore[0].notional);

        // console.log(`Dai Balance: ${(await escrow.currencyBalances(dai.address, wallet.address)).toString()}`)
        // console.log(`ETH Balance After: ${ethBalanceAfter.toString()}`)
        // console.log(`ETH Value: ${await uniswap.getEthToTokenInputPrice(ethBalanceAfter)}`)
        // console.log(`ETH Sold: ${ethBalanceBefore.sub(ethBalanceAfter).toString()}`)
        // console.log(`Future Cash Sold: ${portfolioBefore[0].notional.sub(portfolioAfter[0].notional).toString()}`)
        // console.log(`Dai Raised: ${await uniswap.getEthToTokenInputPrice(ethBalanceBefore.sub(ethBalanceAfter))}`)
        // console.log(`Free Collateral: ${await (portfolios.freeCollateralView(wallet.address))[0]}`)
        expect((await portfolios.freeCollateralView(wallet.address))[0]).to.be.above(0);
    })
});
