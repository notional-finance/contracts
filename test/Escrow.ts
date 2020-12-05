import chai from "chai";
import { solidity, deployContract } from "ethereum-waffle";
import { fixture, wallets, fixtureLoader, provider, fastForwardToMaturity, CURRENCY } from "./fixtures";
import { Wallet } from "ethers";
import { WeiPerEther, AddressZero } from "ethers/constants";

import ERC777Artifact from "../mocks/ERC777.json";
import MockUSDC from "../mocks/MockUSDC.json";
import MockAggregatorArtifact from "../mocks/MockAggregator.json";
import {Ierc20 as ERC20} from "../typechain/Ierc20";
import {Iweth as IWETH} from "../typechain/Iweth";
import {CashMarket} from "../typechain/CashMarket";
import {ErrorDecoder, ErrorCodes} from "../scripts/errorCodes";
import {Escrow} from "../typechain/Escrow";
import {Portfolios} from "../typechain/Portfolios";
import {TestUtils} from "./testUtils";
import {parseEther, BigNumber} from "ethers/utils";
import {Ierc1820Registry as IERC1820Registry} from "../typechain/Ierc1820Registry";
import {Ierc777 as IERC777} from "../typechain/Ierc777";
import {MockAggregator} from "../mocks/MockAggregator";

chai.use(solidity);
const { expect } = chai;

describe("Deposits and Withdraws", () => {
    let dai: ERC20;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let wallet3: Wallet;
    let rateAnchor: number;
    let futureCash: CashMarket;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let chainlink: MockAggregator;
    let t: TestUtils;
    let registry: IERC1820Registry;
    let weth: IWETH;
    let maturities: number[];

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        wallet3 = wallets[3];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.cashMarket;
        escrow = objs.escrow;
        portfolios = objs.portfolios;
        registry = objs.registry;
        chainlink = objs.chainlink;
        weth = objs.weth;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet3.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet3).approve(escrow.address, WeiPerEther.mul(100_000_000));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);

        // Set the blockheight to the beginning of the next period
        maturities = await futureCash.getActiveMaturities();
        await fastForwardToMaturity(provider, maturities[1]);
        maturities = await futureCash.getActiveMaturities();
        t = new TestUtils(escrow, futureCash, portfolios, dai, owner, objs.chainlink, objs.weth, CURRENCY.DAI);
    });

    afterEach(async () => {
        expect(await t.checkEthBalanceIntegrity([owner, wallet, wallet2, wallet3])).to.be.true;
        expect(await t.checkBalanceIntegrity([owner, wallet, wallet2, wallet3])).to.be.true;
        expect(await t.checkMarketIntegrity([owner, wallet, wallet2, wallet3], maturities)).to.be.true;
    });

    // deposits //
    it("allows users to deposit eth", async () => {
        await escrow.depositEth({value: WeiPerEther.mul(200)});
        expect(await escrow.cashBalances(CURRENCY.ETH, owner.address)).to.equal(WeiPerEther.mul(200));
    });

    it("allows users to deposit weth", async () => {
        await weth.deposit({value: parseEther("200")});
        await weth.approve(escrow.address, parseEther("10000"));
        await escrow.deposit(weth.address, parseEther("200"));
        expect(await escrow.cashBalances(CURRENCY.ETH, owner.address)).to.equal(WeiPerEther.mul(200));
        expect(await weth.balanceOf(owner.address)).to.equal(0);
    });

    it("fails if users deposit more than unt128 max eth", async () => {
        await expect(escrow.depositEth({value: "0xfffffffffffffffffffffffffffffffffff"})).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.OVER_MAX_ETH_BALANCE)
        );
    });

    it("allows users to deposit dai", async () => {
        await dai.approve(escrow.address, WeiPerEther);
        await escrow.deposit(dai.address, WeiPerEther);
        expect(await escrow.cashBalances(CURRENCY.DAI, owner.address)).to.equal(WeiPerEther);
    });

    it("does not allow users to deposit invalid currencies", async () => {
        await expect(escrow.deposit(owner.address, WeiPerEther)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY)
        );
    });

    it("does not allow users to deposit using zero address", async () => {
        await expect(escrow.deposit(AddressZero, WeiPerEther)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY)
        );
    });

    it("does not allow users to mint tokens using tokensReceived", async () => {
        await expect(
            escrow.tokensReceived(owner.address, owner.address, AddressZero, WeiPerEther, "0x", "0x")
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY));
    });

    it("does not allow invalid currencies to be listed in fCash markets", async () => {
        await expect(portfolios.createCashGroup(2, 100, 1e9, 2, AddressZero)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY)
        );
    });

    it("does not allow currencies to be listed twice", async () => {
        await expect(
            escrow.listCurrency(dai.address, { isERC777: true, hasTransferFee: false })
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY));
    });

    it("erc777 token deposits are not double counted", async () => {
        const erc777 = await deployContract(owner, ERC777Artifact, [registry.address]) as IERC777;
        await escrow.listCurrency(erc777.address, { isERC777: true, hasTransferFee: false });
        await erc777.authorizeOperator(escrow.address);

        await escrow.deposit(erc777.address, parseEther("0.000001"))
        expect(await escrow.cashBalances(2, owner.address)).to.equal(parseEther("0.000001"));
    })

    it("supports erc777 token transfers", async () => {
        const erc777 = await deployContract(owner, ERC777Artifact, [registry.address]);
        await escrow.listCurrency(erc777.address, { isERC777: true, hasTransferFee: false });

        await expect(erc777.send(escrow.address, 100, []))
            .to.emit(erc777, "Sent")
            .withArgs(owner.address, owner.address, escrow.address, 100, "0x", "0x");

        // Check balances
        expect(await escrow.cashBalances(2, owner.address)).to.equal(100);
        expect(await erc777.balanceOf(owner.address)).to.equal(99999999999900);
        expect(await erc777.balanceOf(escrow.address)).to.equal(100);
    });

    // withdraws //
    it("allows users to withdraw eth", async () => {
        const balance = await owner.getBalance();
        await escrow.depositEth({ value: WeiPerEther });
        await escrow.withdrawEth(WeiPerEther.div(2));
        expect(await escrow.cashBalances(CURRENCY.ETH, owner.address)).to.equal(WeiPerEther.div(2));
        expect(balance.sub(await owner.getBalance())).to.be.at.least(WeiPerEther.div(2));
    });

    it("allows users to withdraw dai", async () => {
        const balance = await dai.balanceOf(owner.address);
        await dai.approve(futureCash.address, WeiPerEther);
        await escrow.deposit(dai.address, WeiPerEther);
        await escrow.withdraw(dai.address, WeiPerEther.div(2));
        expect(await escrow.cashBalances(CURRENCY.DAI, owner.address)).to.equal(WeiPerEther.div(2));
        expect(balance.sub(await dai.balanceOf(owner.address))).to.be.at.least(WeiPerEther.div(2));
    });

    it("prevents users from withdrawing from address zero currency ", async () => {
        await escrow.depositEth({value: WeiPerEther});
        await expect(escrow.withdraw(AddressZero, WeiPerEther)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY)
        );
    });

    it("prevents users from withdrawing more eth than they own", async () => {
        await escrow.depositEth({value: WeiPerEther});
        await expect(escrow.withdrawEth(WeiPerEther.mul(2))).to.be.revertedWith(
            ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE)
        );
    });

    it("prevents users from withdrawing more dai than they own", async () => {
        await escrow.deposit(dai.address, WeiPerEther);

        const daiBalanceBefore = await dai.balanceOf(owner.address);
        // Escrow cuts off the withdraw at 0, so this will only withdraw 1 DAI
        await escrow.withdraw(dai.address, WeiPerEther.mul(2))
        const daiBalanceAfter = await dai.balanceOf(owner.address);

        expect(await escrow.cashBalances(CURRENCY.DAI, owner.address)).to.equal(0)
        expect(daiBalanceAfter.sub(daiBalanceBefore)).to.equal(WeiPerEther)
    });

    it("prevents users from withdrawing eth if they do not have enough collateral", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(200));

        await expect(escrow.connect(wallet).withdrawEth(WeiPerEther.div(10).mul(5))).to.be.revertedWith(
            ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL)
        );
    });

    it("reverts if a withdraw occurs on a negative cash balance", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(200));
        await fastForwardToMaturity(provider, maturities[0])

        await portfolios.settleMaturedAssets(wallet.address)
        await expect(escrow.connect(wallet).withdraw(dai.address, WeiPerEther.mul(2))).to.be.revertedWith(
            ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE)
        );
    })

    it("allows users to withdraw excess eth from their collateral", async () => {
        await t.setupLiquidity();
        const [ethAmount] = await t.borrowAndWithdraw(wallet, WeiPerEther.mul(200), 1.1);
        const excessEth = ethAmount.mul(parseEther("0.04")).div(WeiPerEther);

        await expect(escrow.connect(wallet).withdrawEth(excessEth)).to.not.be.reverted;
    });

    it("prevents users from withdrawing dai if they do not have enough collateral", async () => {
        await t.setupLiquidity();
        const [ethAmount, collateralAmount] = await t.borrowAndWithdraw(wallet, WeiPerEther.mul(200));
        // Deposit the collateral amount back in.
        await escrow.connect(wallet).deposit(dai.address, collateralAmount);

        // Remove most the ETH so only the dai is collateralizing the CASH_PAYER
        const withdrawAmount = ethAmount.mul(parseEther("0.9")).div(WeiPerEther);
        await escrow.connect(wallet).withdrawEth(withdrawAmount);

        await expect(escrow.connect(wallet).withdraw(dai.address, WeiPerEther.mul(30))).to.be.revertedWith(
            ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL)
        );
    });

    it("converts balances to ETH", async () => {
        await escrow.addExchangeRate(0, 0, AddressZero, parseEther("1.3"), WeiPerEther, false);
        let converted = await escrow.convertBalancesToETH([WeiPerEther, parseEther("-100")]);

        expect(converted[0]).to.equal(WeiPerEther);
        expect(converted[1]).to.equal(parseEther("-1.3"));

        converted = await escrow.convertBalancesToETH([parseEther("-1"), parseEther("-100")]);

        expect(converted[0]).to.equal(parseEther("-1.3"));
        expect(converted[1]).to.equal(parseEther("-1.3"));
    });

    it("converts balances that are not denominated with 18 decimals to ETH", async () => {
        const mockUSDC = await deployContract(owner, MockUSDC, []) as ERC20;
        const mockChainlink = await deployContract(owner, MockAggregatorArtifact, []) as MockAggregator;
        // Here we assume an exchange rate w/ 18 decimal places
        await mockChainlink.setAnswer(parseEther("0.01"));
        await escrow.listCurrency(mockUSDC.address, { isERC777: false, hasTransferFee: false });
        await escrow.addExchangeRate(2, 0, mockChainlink.address, parseEther("1.2"), WeiPerEther, false);

        let converted = await escrow.convertBalancesToETH([0, 0, new BigNumber(100 * 1e6)]);
        expect(converted[2]).to.equal(parseEther("1"));

        converted = await escrow.convertBalancesToETH([0, 0, new BigNumber(-100 * 1e6)]);
        expect(converted[2]).to.equal(parseEther("1.2").mul(-1));
    })

    it("converts balances that are not denominated with 18 decimals to ETH where the exchange rate must be inverted", async () => {
        const mockUSDC = await deployContract(owner, MockUSDC, []) as ERC20;
        const mockChainlink = await deployContract(owner, MockAggregatorArtifact, []) as MockAggregator;
        await mockChainlink.setAnswer(100e6);
        await escrow.listCurrency(mockUSDC.address, { isERC777: false, hasTransferFee: false });
        // Here the exchange rate has 6 decimal place precision
        await escrow.addExchangeRate(2, 0, mockChainlink.address, parseEther("1.2"), new BigNumber(1e6), true);

        let converted = await escrow.convertBalancesToETH([0, 0, new BigNumber(100 * 1e6)]);
        expect(converted[2]).to.equal(parseEther("1"));

        converted = await escrow.convertBalancesToETH([0, 0, new BigNumber(-100 * 1e6)]);
        expect(converted[2]).to.equal(parseEther("1.2").mul(-1));
    })


    // settle cash //
    it("does not allow settling with an invalid currency", async () => {
        await expect(
            escrow.settleCashBalance(3, CURRENCY.ETH, wallet.address, WeiPerEther.mul(100))
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_CURRENCY));
        await expect(
            escrow.settleCashBalanceBatch(3, CURRENCY.ETH, [wallet.address], [WeiPerEther.mul(100)])
        ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_CURRENCY));
    });

    it("settles cash in batch", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
        await t.borrowAndWithdraw(wallet2, WeiPerEther.mul(250));

        await fastForwardToMaturity(provider, maturities[1]);

        await expect(
            escrow
                .connect(wallet3)
                .settleCashBalanceBatch(
                    CURRENCY.DAI,
                    CURRENCY.ETH,
                    [wallet.address, wallet2.address],
                    [parseEther("100"), parseEther("250")]
                )
        ).to.not.be.reverted;
    });

    it("should not allow settlement if wallet has no balance", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
        await t.borrowAndWithdraw(wallet2, WeiPerEther.mul(250));

        await fastForwardToMaturity(provider, maturities[1]);
        await expect(
            escrow
                .connect(wallets[4])
                .settleCashBalanceBatch(
                    CURRENCY.DAI,
                    CURRENCY.ETH,
                    [wallet.address, wallet2.address],
                    [parseEther("100"), parseEther("250")]
                )
        ).to.be.reverted;
    });

    it("should not allow someone to liquidate themselves", async () => {
        await expect(escrow.liquidate(owner.address, 0, CURRENCY.DAI, CURRENCY.ETH)).to.be.revertedWith(
            ErrorDecoder.encodeError(ErrorCodes.CANNOT_LIQUIDATE_SELF)
        );
        await expect(escrow.liquidateBatch([owner.address], CURRENCY.DAI, CURRENCY.ETH)).to.be.revertedWith(
            ErrorDecoder.encodeError(ErrorCodes.CANNOT_LIQUIDATE_SELF)
        );
    });

    it("does not allow liquidating with an invalid currency", async () => {
        await expect(escrow.liquidate(wallet.address, 0, CURRENCY.DAI, 3)).to.be.revertedWith(
            ErrorDecoder.encodeError(ErrorCodes.INVALID_CURRENCY)
        );
        await expect(escrow.liquidateBatch([wallet.address], CURRENCY.DAI, 3)).to.be.revertedWith(
            ErrorDecoder.encodeError(ErrorCodes.INVALID_CURRENCY)
        );
        await expect(escrow.liquidateBatch([wallet.address], CURRENCY.DAI, CURRENCY.DAI)).to.be.revertedWith(
            ErrorDecoder.encodeError(ErrorCodes.INVALID_CURRENCY)
        );
    });

    it("liquidates in batch", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
        await t.borrowAndWithdraw(wallet2, WeiPerEther.mul(250));

        await chainlink.setAnswer(WeiPerEther.div(50));

        await escrow.deposit(dai.address, WeiPerEther.mul(1000));
        await expect(escrow.liquidateBatch([wallet.address, wallet2.address], CURRENCY.DAI, CURRENCY.ETH)).to.not.be
            .reverted;
    });

    it("should not allow liquidation if wallet has no balance", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
        await t.borrowAndWithdraw(wallet2, WeiPerEther.mul(250));

        await chainlink.setAnswer(WeiPerEther.div(50));

        await escrow.deposit(dai.address, WeiPerEther.mul(1000));
        await expect(
            escrow.connect(wallets[4]).liquidateBatch([wallet.address, wallet2.address], CURRENCY.DAI, CURRENCY.ETH)
        ).to.be.reverted;
    });

});
