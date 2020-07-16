import chai from "chai";
import { solidity } from "ethereum-waffle";
import { fixture, wallets, fixtureLoader, provider, CURRENCY, fastForwardToMaturity } from "./fixtures";
import { Wallet } from "ethers";

import { Erc20 as ERC20 } from "../typechain/Erc20";
import { FutureCash } from "../typechain/FutureCash";
import { Escrow } from "../typechain/Escrow";
import { Portfolios } from "../typechain/Portfolios";
import { TestUtils, BLOCK_TIME_LIMIT } from "./testUtils";
import { UniswapExchangeInterface } from "../typechain/UniswapExchangeInterface";
import { MockAggregator } from "../typechain/MockAggregator";
import { SwapnetDeployer } from "../scripts/SwapnetDeployer";
import { parseEther, BigNumber } from "ethers/utils";
import { UniswapFactoryInterface } from "../typechain/UniswapFactoryInterface";
import { ErrorDecoder, ErrorCodes } from "../scripts/errorCodes";
import { AddressZero } from "ethers/constants";

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
    let uniswapFactory: UniswapFactoryInterface;

    let token: ERC20[] = [];
    let uniswap: UniswapExchangeInterface[] = [];
    let chainlink: MockAggregator[] = [];
    let futureCash: FutureCash[] = [];
    let wbtc: {
        currencyId: number;
        erc20: ERC20;
        chainlink: MockAggregator;
        uniswapExchange: UniswapExchangeInterface;
    };

    let t1: TestUtils;
    let t2: TestUtils;
    let tNew: TestUtils;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        reserve = wallets[3];
        let objs = await fixtureLoader(fixture);

        escrow = objs.escrow;
        portfolios = objs.portfolios;
        swapnet = objs.swapnet;
        uniswapFactory = objs.uniswapFactory;

        token[0] = objs.erc20;
        futureCash[0] = objs.futureCash;
        chainlink[0] = objs.chainlink;
        uniswap[0] = objs.uniswap;

        const newCurrency = await swapnet.deployMockCurrency(
            objs.uniswapFactory,
            parseEther("0.01"),
            parseEther("1.20"),
            true
        );
        const newFutureCash = await swapnet.deployFutureCashMarket(
            newCurrency.currencyId,
            2,
            90,
            parseEther("10000"),
            new BigNumber(0),
            new BigNumber(0),
            1e9,
            1_020_000_000,
            100
        );

        token[1] = newCurrency.erc20;
        futureCash[1] = newFutureCash;
        chainlink[1] = newCurrency.chainlink;
        uniswap[1] = newCurrency.uniswapExchange;

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

        t1 = new TestUtils(escrow, futureCash[0], portfolios, token[0], owner, chainlink[0], uniswap[0]);
        t2 = new TestUtils(escrow, futureCash[1], portfolios, token[1], owner, chainlink[1], uniswap[1]);
        wbtc = await swapnet.deployMockCurrency(uniswapFactory, parseEther("10"), parseEther("0.7"), false);
        await wbtc.erc20.transfer(wallet.address, parseEther("100000"));

        const futureCashNew = await swapnet.deployFutureCashMarket(
            CURRENCY.DAI,
            2,
            60,
            parseEther("10000"),
            new BigNumber(0),
            new BigNumber(0),
            1e9,
            1_020_000_000,
            100
        );
        tNew = new TestUtils(escrow, futureCashNew, portfolios, token[0], owner, chainlink[0], uniswap[0]);

        // Set the blockheight to the beginning of the next period
        const maturities = await futureCash[0].getActiveMaturities();
        await fastForwardToMaturity(provider, maturities[1]);
    });

    afterEach(async () => {
        expect(await t1.checkEthBalanceIntegrity([owner, wallet, wallet2])).to.be.true;

        expect(await t1.checkBalanceIntegrity([owner, wallet, wallet2, reserve], tNew.futureCash.address)).to.be.true;
        expect(await t2.checkBalanceIntegrity([owner, wallet, wallet2, reserve])).to.be.true;

        expect(await t1.checkCashIntegrity([owner, wallet, wallet2, reserve])).to.be.true;
        expect(await t2.checkCashIntegrity([owner, wallet, wallet2, reserve], 2)).to.be.true;

        expect(await t1.checkMarketIntegrity([owner, wallet, wallet2, reserve])).to.be.true;
        expect(await t2.checkMarketIntegrity([owner, wallet, wallet2, reserve])).to.be.true;
        expect(await tNew.checkMarketIntegrity([owner, wallet, wallet2, reserve])).to.be.true;
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
            .withdraw(t1.dai.address, await escrow.currencyBalances(t1.dai.address, wallet.address));

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

        it("converts deposit currencies to ETH", async () => {
            expect(wbtc.currencyId).to.equal(3);
            const converted = await escrow.convertBalancesToETH([
                new BigNumber(0),
                new BigNumber(0),
                new BigNumber(0),
                parseEther("0.3")
            ]);

            expect(converted[0]).to.equal(new BigNumber(0));
            expect(converted[1]).to.equal(new BigNumber(0));
            expect(converted[2]).to.equal(new BigNumber(0));
            expect(converted[3]).to.equal(new BigNumber(parseEther("2.1")));
        });

        it("liquidates accounts in a currency with designated collateral", async () => {
            await setupTest();
            await wbtc.chainlink.setAnswer(parseEther("1"));
            await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, wbtc.currencyId);
        });

        it("liquidates accounts and repays borrow across two future cash groups", async () => {
            await escrow.connect(wallet2).deposit(token[0].address, parseEther("1000"));

            await t1.setupLiquidity();
            await tNew.setupLiquidity();
            await t1.borrowAndWithdraw(wallet, parseEther("5"), 1.05, 0, 100_000_000);
            await tNew.borrowAndWithdraw(wallet, parseEther("50"), 1.05, 0, 100_000_000);

            await chainlink[0].setAnswer(parseEther("0.015"));
            await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, 0);
            expect(await portfolios.getAssets(wallet.address)).to.have.lengthOf(1);
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
                .settleCashBalance(CURRENCY.DAI, CURRENCY.ETH, wallet.address, owner.address, parseEther("100"));

            // Expect ETH to be cleaned out
            expect(await escrow.currencyBalances(AddressZero, wallet.address)).to.equal(0);
            // This was a partial settlement
            expect(await escrow.cashBalances(CURRENCY.DAI, owner.address)).to.be.above(0);
        });

        it("partially settles cash using collateral when there are two deposit currencies via uniswap", async () => {
            await t1.setupLiquidity();
            await t1.borrowAndWithdraw(wallet, parseEther("100"), 1.05, 0, 100_000_000);
            await wbtc.erc20.connect(wallet).approve(escrow.address, parseEther("100000"));
            await escrow.connect(wallet).deposit(wbtc.erc20.address, parseEther("0.5"));
            await escrow.connect(wallet).withdrawEth(parseEther("1"));

            const maturities = await futureCash[0].getActiveMaturities();
            await fastForwardToMaturity(provider, maturities[1]);

            await escrow.settleCashBalance(
                CURRENCY.DAI,
                CURRENCY.ETH,
                wallet.address,
                owner.address,
                parseEther("100")
            );

            // Expect ETH to be cleaned out
            expect(await escrow.currencyBalances(AddressZero, wallet.address)).to.equal(0);
            // This was a partial settlement
            expect(await escrow.cashBalances(CURRENCY.DAI, owner.address)).to.be.above(0);
        });
    });

    // See flow chart at ../docs/SettleCash.png
    describe("settle cash situations [4-8]", async () => {
        it("[4] does not settle cash with the reserve account if the account has collateral", async () => {
            await setupTest();
            await wbtc.chainlink.setAnswer(parseEther("1"));
            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, wbtc.currencyId, wallet.address, owner.address, parseEther("100"));
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(parseEther("-100"));
        });

        it("[5] reverts if there is no exchange for a deposit currency", async () => {
            await setupTest();
            // We will probably not list exchanges for secondary deposit currencies since there will be a
            // lack of liquidity.
            await expect(
                escrow.settleCashBalance(
                    CURRENCY.DAI,
                    wbtc.currencyId,
                    wallet.address,
                    owner.address,
                    parseEther("100")
                )
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.NO_EXCHANGE_LISTED_FOR_PAIR));
        });

        it("[6] settles cash with a secondary deposit currency", async () => {
            await setupTest();
            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, wbtc.currencyId, wallet.address, owner.address, parseEther("100"));
        });

        it("[7] settles cash with the reserve account when the account is insolvent", async () => {
            await setupTest();
            await wbtc.chainlink.setAnswer(parseEther("1"));
            // liquidate to clear out the BTC
            await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, wbtc.currencyId);

            // deposit eth
            expect(await escrow.currencyBalances(wbtc.erc20.address, wallet.address)).to.equal(0);
            const shortfall = parseEther("100").sub(await escrow.currencyBalances(t1.dai.address, wallet.address));
            const reserveBalance = await escrow.currencyBalances(t1.dai.address, reserve.address);

            // This will settle via the reserve account
            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, wbtc.currencyId, wallet.address, owner.address, parseEther("100"));

            expect(await escrow.currencyBalances(t1.dai.address, reserve.address)).to.equal(
                reserveBalance.sub(shortfall)
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

            const currencyBalance = await escrow.currencyBalances(t1.dai.address, wallet.address);
            await escrow
                .connect(wallet2)
                .settleCashBalance(CURRENCY.DAI, wbtc.currencyId, wallet.address, owner.address, parseEther("100"));
            expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(
                parseEther("-100").add(currencyBalance)
            );
        });
    });
});
