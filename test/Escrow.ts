import chai from "chai";
import {solidity, deployContract} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, mineBlocks, CURRENCY} from "./fixtures";
import {Wallet} from "ethers";
import {WeiPerEther, AddressZero} from "ethers/constants";

import ERC777Artifact from "../mocks/ERC777.json";
import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import { ErrorDecoder, ErrorCodes } from '../scripts/errorCodes';
import { Escrow } from '../typechain/Escrow';
import { Portfolios } from '../typechain/Portfolios';
import { TestUtils } from './testUtils';
import { parseEther } from 'ethers/utils';
import { IERC1820Registry } from '../typechain/IERC1820Registry';
import { MockAggregator } from '../typechain/MockAggregator';

chai.use(solidity);
const {expect} = chai;

describe("Deposits and Withdraws", () => {
    let dai: ERC20;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let wallet3: Wallet;
    let rateAnchor: number;
    let futureCash: FutureCash;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let chainlink: MockAggregator;
    let t: TestUtils;
    let registry: IERC1820Registry;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        wallet3 = wallets[3];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;
        escrow = objs.escrow;
        portfolios = objs.portfolios;
        registry = objs.registry;
        chainlink = objs.chainlink;

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
        let block = await provider.getBlockNumber();
        await mineBlocks(provider, 20 - (block % 20));
        t = new TestUtils(escrow, futureCash, portfolios, dai, owner, objs.chainlink, objs.uniswap);
    });

    afterEach(async () => {
        expect(await t.checkEthBalanceIntegrity([owner, wallet, wallet2, wallet3])).to.be.true;
        expect(await t.checkBalanceIntegrity([owner, wallet, wallet2, wallet3])).to.be.true;
        expect(await t.checkCashIntegrity([owner, wallet, wallet2, wallet3])).to.be.true;
        expect(await t.checkMarketIntegrity([owner, wallet, wallet2, wallet3])).to.be.true;
    });

    // deposits //
    it("allows users to deposit eth", async () => {
        await escrow.depositEth({value: WeiPerEther.mul(200)});
        expect(await escrow.currencyBalances(AddressZero, owner.address)).to.equal(WeiPerEther.mul(200));
    });

    it("fails if users deposit more than unt128 max eth", async () => {
        await expect(
          escrow.depositEth({value: "0xfffffffffffffffffffffffffffffffffff"})
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.OVER_MAX_ETH_BALANCE));
    });

    it("allows users to deposit dai", async () => {
        await dai.approve(escrow.address, WeiPerEther);
        await escrow.deposit(dai.address, WeiPerEther);
        expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(WeiPerEther);
    });

    it("does not allow users to deposit invalid currencies", async () => {
        await expect(
          escrow.deposit(owner.address, WeiPerEther)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY));
    });

    it("does not allow users to deposit using zero address", async () => {
        await expect(
          escrow.deposit(AddressZero, WeiPerEther)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY));
    });

    it("does not allow users to mint tokens using tokensReceived", async () => {
        await expect(
          escrow.tokensReceived(owner.address, owner.address, AddressZero, WeiPerEther, "0x", "0x")
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY));
    });

    it("does not allow invalid currencies to be listed in future cash markets", async () => {
        await expect(
          portfolios.createFutureCashGroup(2, 100, 1e9, 2, AddressZero, AddressZero)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY));
    });

    it("does not allow deposit currencies to be listed in future cash markets", async () => {
        const erc777 = (await deployContract(owner, ERC777Artifact, [registry.address]));
        await escrow.listDepositCurrency(erc777.address);

        await expect(
          portfolios.createFutureCashGroup(2, 100, 1e9, 2, AddressZero, AddressZero)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY));
    });

    it("does not allow invalid currencies as deposit currencies", async () => {
        expect(await escrow.isDepositCurrency(3)).to.be.false;
    });

    it("supports erc777 token transfers", async () => {
        const erc777 = (await deployContract(owner, ERC777Artifact, [registry.address]));
        await escrow.listDepositCurrency(erc777.address);

        await expect(erc777.send(escrow.address, 100, []))
            .to.emit(erc777, "Sent")
            .withArgs(owner.address, owner.address, escrow.address, 100, "0x", "0x");

        // Check balances
        expect(await escrow.currencyBalances(erc777.address, owner.address)).to.equal(100);
        expect(await erc777.balanceOf(owner.address)).to.equal(99999999999900);
        expect(await erc777.balanceOf(escrow.address)).to.equal(100);
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

    it("prevents users from withdrawing from address zero currency ", async () => {
        await escrow.depositEth({value: WeiPerEther});
        await expect(
          escrow.withdraw(AddressZero, WeiPerEther)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INVALID_CURRENCY));
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
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(200));

        await expect(escrow.connect(wallet).withdrawEth(WeiPerEther.div(10).mul(5)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));
    });

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

        await expect(escrow.connect(wallet).withdraw(dai.address, WeiPerEther.mul(30)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));
    });

    it("converts balances to ETH", async () => {
        const converted = await escrow.convertBalancesToETH([
            WeiPerEther, parseEther("100")
        ]);

        expect(converted[0]).to.equal(WeiPerEther);
        expect(converted[1]).to.equal(parseEther("1.3"));
    });

    // settle cash //
    it("does not allow settling accounts against yourself", async () => {
        await expect(escrow.settleCashBalance(CURRENCY.DAI, CURRENCY.ETH, wallet.address, wallet.address, WeiPerEther.mul(100)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.COUNTERPARTY_CANNOT_BE_SELF));
    });

    it("does not allow settling with an invalid currency", async () => {
        await expect(escrow.settleCashBalance(3, CURRENCY.ETH, wallet.address, owner.address, WeiPerEther.mul(100)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_TRADABLE_CURRENCY));
        await expect(escrow.settleCashBalanceBatch(3, CURRENCY.ETH, [wallet.address], [owner.address], [WeiPerEther.mul(100)]))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_TRADABLE_CURRENCY));
    });

    it("does not allow settling with an invalid deposit currency", async () => {
        await expect(escrow.settleCashBalance(CURRENCY.DAI, CURRENCY.DAI, wallet.address, owner.address, WeiPerEther.mul(100)))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_DEPOSIT_CURRENCY));
        await expect(escrow.settleCashBalanceBatch(CURRENCY.DAI, CURRENCY.DAI, [wallet.address], [owner.address], [WeiPerEther.mul(100)]))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_DEPOSIT_CURRENCY));
    });

    it("settles cash in batch", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
        await t.borrowAndWithdraw(wallet2, WeiPerEther.mul(250));

        await mineBlocks(provider, 20);

        await escrow.connect(wallet3).deposit(dai.address, WeiPerEther.mul(1000));
        await expect(escrow.connect(wallet3).settleCashBalanceBatch(
            CURRENCY.DAI,
            CURRENCY.ETH,
            [wallet.address, wallet2.address],
            [owner.address, owner.address],
            [parseEther("100"), parseEther("250")]
        )).to.not.be.reverted;
    });

    it("does not allow an undercollateralized account to settle", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, parseEther("1"));
        await t.borrowAndWithdraw(wallet2, parseEther("250"));
        await escrow.connect(wallet2).deposit(dai.address, parseEther("5"));

        await mineBlocks(provider, 20);
        await chainlink.setAnswer(parseEther("0.02"));

        expect(await t.isCollateralized(wallet2)).to.be.false;
        await expect(escrow.connect(wallet2).settleCashBalance(
            CURRENCY.DAI,
            CURRENCY.ETH,
            wallet.address,
            owner.address,
            parseEther("1")
        )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL_FOR_SETTLER));
        await expect(escrow.connect(wallet2).settleCashBalanceBatch(
            CURRENCY.DAI,
            CURRENCY.ETH,
            [wallet.address],
            [owner.address],
            [parseEther("1")]
        )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL_FOR_SETTLER));

    });

    it("should not allow someone to liquidate themselves", async () => {
        await expect(escrow.liquidate(owner.address, CURRENCY.DAI, CURRENCY.ETH))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_LIQUIDATE_SELF));
        await expect(escrow.liquidateBatch([owner.address], CURRENCY.DAI, CURRENCY.ETH))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_LIQUIDATE_SELF));
    });

    it("does not allow an undercollateralized account to liquidate", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, parseEther("1"));
        await t.borrowAndWithdraw(wallet2, parseEther("250"));
        await escrow.connect(wallet2).deposit(dai.address, parseEther("5"));

        await chainlink.setAnswer(parseEther("0.02"));

        expect(await t.isCollateralized(wallet2)).to.be.false;
        await expect(escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, CURRENCY.ETH))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL_FOR_LIQUIDATOR));
        await expect(escrow.connect(wallet2).liquidateBatch([wallet.address], CURRENCY.DAI, CURRENCY.ETH))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL_FOR_LIQUIDATOR));
    });

    it("does not allow liquidating with an invalid deposit currency", async () => {
        await expect(escrow.liquidate(wallet.address, CURRENCY.DAI, CURRENCY.DAI))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_DEPOSIT_CURRENCY));
        await expect(escrow.liquidateBatch([wallet.address], CURRENCY.DAI, CURRENCY.DAI))
            .to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_DEPOSIT_CURRENCY));
    });

    it("liquidates in batch", async () => {
        await t.setupLiquidity();
        await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
        await t.borrowAndWithdraw(wallet2, WeiPerEther.mul(250));

        await chainlink.setAnswer(WeiPerEther.div(50));

        await escrow.deposit(dai.address, WeiPerEther.mul(1000));
        await expect(escrow.liquidateBatch([wallet.address, wallet2.address], CURRENCY.DAI, CURRENCY.ETH))
            .to.not.be.reverted;
    });
  });
