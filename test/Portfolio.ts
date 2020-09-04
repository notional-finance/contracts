import chai from "chai";
import { solidity } from "ethereum-waffle";
import { fixture, wallets, fixtureLoader, provider, CURRENCY, fastForwardToMaturity } from "./fixtures";
import { Wallet } from "ethers";
import { WeiPerEther, AddressZero } from "ethers/constants";

import { Erc20 as ERC20 } from "../typechain/Erc20";
import { FutureCash } from "../typechain/FutureCash";
import { ErrorDecoder, ErrorCodes } from "../scripts/errorCodes";
import { Escrow } from "../typechain/Escrow";
import { Portfolios } from "../typechain/Portfolios";
import { TestUtils, BLOCK_TIME_LIMIT } from "./testUtils";
import { parseEther, BigNumber } from 'ethers/utils';
import { RiskFramework } from '../typechain/RiskFramework';
import { Iweth } from '../typechain/Iweth';

chai.use(solidity);
const { expect } = chai;

describe("Portfolio", () => {
    let dai: ERC20;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let rateAnchor: number;
    let futureCash: FutureCash;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let t: TestUtils;
    let risk: RiskFramework;
    let maturities: number[];
    let weth: Iweth;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;
        escrow = objs.escrow;
        portfolios = objs.portfolios;
        risk = objs.swapnet.risk;
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

    it("does not allow future cash groups with invalid currencies", async () => {
        await expect(
            portfolios.createFutureCashGroup(2, 40, 1e9, 3, futureCash.address, AddressZero)
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_CURRENCY));
    });

    it("allows future cash groups to be updated", async () => {
        await expect(
            portfolios.updateFutureCashGroup(1, 0, 1000, 1e8, CURRENCY.DAI, futureCash.address, owner.address)
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_INSTRUMENT_PRECISION));

        await portfolios.updateFutureCashGroup(1, 0, 1000, 1e9, CURRENCY.DAI, futureCash.address, owner.address);
        expect(await portfolios.getFutureCashGroup(1)).to.eql([
            0,
            1000,
            1e9,
            futureCash.address,
            CURRENCY.DAI,
            owner.address
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

    describe("free collateral calculation scenarios", async () => {
        const checkFC = async (eth: BigNumber, dai: BigNumber) => {
            const fc = await portfolios.freeCollateralView(wallet.address);
            const ethBalance = await escrow.cashBalances(CURRENCY.ETH, wallet.address);
            expect(fc[0].sub(ethBalance)).to.equal(eth);
            expect(fc[1][CURRENCY.DAI]).to.equal(dai);
        }

        beforeEach(async () => { 
            await t.setupLiquidity(owner, 0.5, parseEther("10000"), [0, 1, 2]);
            await risk.setHaircut(WeiPerEther);
        })

        it("cash = 0, npv = 0, requirement = 100 | available = -100", async () => {
            await t.borrowAndWithdraw(wallet, parseEther("100"));
            await checkFC(parseEther("-1.3"), parseEther("-100"));
        });

        it("cash = 0, npv = 50, requirement = 100 | available = -50", async () => {
            await t.borrowAndWithdraw(wallet, parseEther("100"));
            await t.setupLiquidity(wallet, 0.5, parseEther("50"), [1]);
            await checkFC(parseEther("-0.65"), parseEther("-50"));
        });

        it("cash = 25, npv = 50, requirement = 100 | available = -25", async () => {
            // This sets up a 25 dai cash balance
            await escrow.connect(wallet).deposit(dai.address, parseEther("25"));

            await t.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 1);
            await t.setupLiquidity(wallet, 0.5, parseEther("50"), [2]);
            expect(await escrow.cashBalances(1, wallet.address)).to.equal(parseEther("25"));
            await checkFC(parseEther("-0.325"), parseEther("-25"));
        });

        it("cash = 125, npv = 0, requirement = 100 | available = 25", async () => {
            await escrow.connect(wallet).deposit(dai.address, parseEther("125"));
            const [ethAmount, ] = await t.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 1);
            await escrow.connect(wallet).withdraw(weth.address, ethAmount);
            await checkFC(parseEther("0.25"), parseEther("25"));
        });

        it("cash = 125, npv = 50, requirement = 100 | available = 75", async () => {
            // This sets up a 100 dai cash balance
            await escrow.connect(wallet).deposit(dai.address, parseEther("125"));
            const [ethAmount, ] = await t.borrowAndWithdraw(wallet, parseEther("100"), 1.5, 1);
            await escrow.connect(wallet).withdraw(weth.address, ethAmount);

            await t.setupLiquidity(wallet, 0.5, parseEther("50"), [2]);
            await checkFC(parseEther("0.75"), parseEther("75"));
        });
    });
});
