import chai from "chai";
import { solidity } from "ethereum-waffle";
import { fixture, wallets, fixtureLoader, provider, CURRENCY, fastForwardToMaturity, fastForwardToTime } from "./fixtures";
import { Wallet } from "ethers";
import { WeiPerEther } from "ethers/constants";

import {Ierc20 as ERC20} from "../typechain/Ierc20";
import { CashMarket } from "../typechain/CashMarket";
import { ErrorDecoder, ErrorCodes } from "../scripts/errorCodes";
import { Escrow } from "../typechain/Escrow";
import { Portfolios } from "../typechain/Portfolios";
import { TestUtils, BLOCK_TIME_LIMIT } from "./testUtils";
import { parseEther, BigNumber } from 'ethers/utils';
import { Iweth } from '../typechain/Iweth';

chai.use(solidity);
const { expect } = chai;

describe("Portfolio", () => {
    let dai: ERC20;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let rateAnchor: number;
    let futureCash: CashMarket;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let t: TestUtils;
    let maturities: number[];
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
        weth = objs.weth;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);

        // Set the blockheight to the beginning of the next period
        maturities = await futureCash.getActiveMaturities();
        await fastForwardToMaturity(provider, maturities[1]);
        t = new TestUtils(escrow, futureCash, portfolios, dai, owner, objs.chainlink, objs.weth, CURRENCY.DAI);
        maturities = await futureCash.getActiveMaturities();
    });

    afterEach(async () => {
        expect(await t.checkEthBalanceIntegrity([owner, wallet, wallet2])).to.be.true;
        expect(await t.checkBalanceIntegrity([owner, wallet, wallet2])).to.be.true;
        expect(await t.checkMarketIntegrity([owner, wallet, wallet2], maturities)).to.be.true;
    });

    it("fcash value is capped at 95%", async () => {
        await t.setupLiquidity();
        await t.lendAndWithdraw(wallet, parseEther("100"));
        // When time to maturity is small fCashValue will be capped at 95%
        await fastForwardToTime(provider, maturities[0] - 100);

        const fCashValue = (await portfolios.freeCollateralView(wallet.address))[1][1];
        expect(fCashValue).to.equal(parseEther("95"));
    });

    it("fcash value is scaled relative to timeToMaturity", async () => {
        await t.setupLiquidity(owner, 0.5, parseEther("100000"), [1]);
        await t.lendAndWithdraw(wallet, parseEther("100"), 1);

        const blockTime = (await provider.getBlock("latest")).timestamp;
        const fCashValue = (await portfolios.freeCollateralView(wallet.address))[1][1];

        const expectedValue = parseEther("100").sub(
            parseEther("100")
                .mul(parseEther("0.5"))
                .mul(maturities[1] - blockTime)
                .div(31536000)
                .div(WeiPerEther)
        );
        expect(fCashValue).to.equal(expectedValue);
    });

    it("returns the proper free collateral amount pre and post maturity", async () => {
        await t.setupLiquidity();
        await t.setupLiquidity(wallet, 0.5, parseEther("50"));
        await t.borrowAndWithdraw(wallet, parseEther("100"));
        const fcBefore = await portfolios.freeCollateralView(wallet.address);
        expect(fcBefore[1][CURRENCY.DAI]).to.be.below(parseEther("-50"));

        await fastForwardToMaturity(provider, maturities[1]);
        const fcAfter = await portfolios.freeCollateralView(wallet.address);
        expect(fcAfter[1][CURRENCY.DAI]).to.be.above(parseEther("-50"));
    });

    it("aggregates matching assets", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
        expect(await t.hasCashPayer(wallet, maturities[0], WeiPerEther.mul(200)));
    });

    it("does not allow fCash groups with invalid currencies", async () => {
        await expect(
            portfolios.createCashGroup(2, 40, 1e9, 3, futureCash.address)
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_CURRENCY));
    });

    it("allows fCash groups to be updated", async () => {
        await expect(
            portfolios.updateCashGroup(1, 0, 1000, 1e8, CURRENCY.DAI, futureCash.address)
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_INSTRUMENT_PRECISION));

        await portfolios.updateCashGroup(1, 0, 1000, 1e9, CURRENCY.DAI, futureCash.address);
        expect(await portfolios.getCashGroup(1)).to.eql([
            0,
            1000,
            1e9,
            futureCash.address,
            CURRENCY.DAI
        ]);
    });

    it("prevents assets being added past max assets", async () => {
      await portfolios.setMaxAssets(2);
      await escrow.deposit(dai.address, WeiPerEther.mul(200));
      await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 0, 100_000_000, BLOCK_TIME_LIMIT);
      await expect(
        futureCash.addLiquidity(maturities[1], WeiPerEther.mul(10), WeiPerEther.mul(10), 0, 100_000_000, BLOCK_TIME_LIMIT)
      ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.PORTFOLIO_TOO_LARGE));
    });

    it("allows liquidation to add past max assets", async () => {
        await t.setupLiquidity(owner, 0.5, parseEther("100000"), [0, 1]);

        await escrow.connect(wallet).deposit(dai.address, parseEther("200"));
        await futureCash.connect(wallet).addLiquidity(maturities[1], parseEther("100"), parseEther("100"), 0, 100_000_000, BLOCK_TIME_LIMIT);
        await futureCash.connect(wallet).takefCash(maturities[1], parseEther("100"), BLOCK_TIME_LIMIT, 0);
        await t.borrowAndWithdraw(wallet, parseEther("200"));

        await portfolios.setMaxAssets(2);
        await t.chainlink.setAnswer(parseEther("0.05"));

        await escrow.liquidate(wallet.address, 0, CURRENCY.DAI, CURRENCY.ETH);
        const portfolio = await portfolios.getAssets(wallet.address);
        expect(portfolio).to.have.lengthOf(3);
    });

    describe("free collateral calculation scenarios", async () => {
        const checkFC = async (eth: BigNumber, dai: BigNumber) => {
            const fc = await portfolios.freeCollateralView(wallet.address);
            const ethBalance = await escrow.cashBalances(CURRENCY.ETH, wallet.address);
            expect(fc[0].sub(ethBalance)).to.equal(eth);
            expect(fc[1][CURRENCY.DAI]).to.equal(dai);
        }

        beforeEach(async () => { 
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1, 2]);
            // Setting the haircut so maxfCashValue is always true
            await portfolios.setHaircuts(WeiPerEther, parseEther("0"), parseEther("0.95"));
        })

        it("cash = 0, cashClaim = 0, netfCashValue = -100 | available = -100", async () => {
            await t.borrowAndWithdraw(wallet, parseEther("100"));
            await checkFC(parseEther("-1.3"), parseEther("-100"));
        });

        it("cash = 0, cashClaim = 50, netfCashValue = -100 | available = -50", async () => {
            await t.borrowAndWithdraw(wallet, parseEther("100"));
            await t.setupLiquidity(wallet, 0.5, parseEther("50"), [1]);
            await checkFC(parseEther("-0.65"), parseEther("-50"));
        });

        it("cash = 25, cashClaim = 50, netfCashValue = -100 | available = -25", async () => {
            // This sets up a 25 dai cash balance
            await escrow.connect(wallet).deposit(dai.address, parseEther("25"));

            await t.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 1);
            await t.setupLiquidity(wallet, 0.5, parseEther("50"), [2]);
            expect(await escrow.cashBalances(1, wallet.address)).to.equal(parseEther("25"));
            await checkFC(parseEther("-0.325"), parseEther("-25"));
        });

        it("cash = 125, cashClaim = 0, netfCashValue = -100 | available = 25", async () => {
            await escrow.connect(wallet).deposit(dai.address, parseEther("125"));
            const [ethAmount, ] = await t.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 1);
            await escrow.connect(wallet).withdraw(weth.address, ethAmount);
            await checkFC(parseEther("0.25"), parseEther("25"));
        });

        it("cash = 125, cashClaim = 50, netfCashValue = -100 | available = 75", async () => {
            // This sets up a 100 dai cash balance
            await escrow.connect(wallet).deposit(dai.address, parseEther("125"));
            const [ethAmount, ] = await t.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 1);
            await escrow.connect(wallet).withdraw(weth.address, ethAmount);

            await t.setupLiquidity(wallet, 0.5, parseEther("50"), [2]);
            await checkFC(parseEther("0.75"), parseEther("75"));
        });

        it("cash = 0, cashClaim = 50, netfCashValue = 90 | available = 140", async () => {
            // Tests that borrows and fCash net out
            const [ethAmount, ] = await t.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 1);

            await t.lendAndWithdraw(wallet, parseEther("200"), 0);
            await t.setupLiquidity(wallet, 0.5, parseEther("50"), [2]);
            await escrow.connect(wallet).withdraw(weth.address, ethAmount);

            await checkFC(parseEther("1.4"), parseEther("140"));
        });

        it("liquidity claim that nets to positive fcash is haircut", async () => {
            // no liquidity haircut in here
            await t.setupLiquidity(wallet, 0.5, parseEther("100"));
            await t.lendAndWithdraw(wallet, parseEther("75"));

            const fc = await portfolios.freeCollateralView(wallet.address);
            // fCash claim has some residual due to trading
            expect(fc[1][1].sub(parseEther("171.25"))).to.be.above(0).and.below(WeiPerEther.div(10));
        });
    });
});
