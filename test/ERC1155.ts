import chai from "chai";
import {solidity, deployContract} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, mineBlocks} from "./fixtures";
import {Wallet} from "ethers";
import {WeiPerEther, AddressZero} from "ethers/constants";

import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import { ErrorDecoder, ErrorCodes } from '../scripts/errorCodes';
import { Escrow } from '../typechain/Escrow';
import { Portfolios } from '../typechain/Portfolios';
import { ERC1155Token } from '../typechain/ERC1155Token';
import { TestUtils } from './testUtils';
import { BigNumber } from 'ethers/utils';

import ERC1155MockReceiverArtifact from '../mocks/ERC1155MockReceiver.json';

chai.use(solidity);
const {expect} = chai;

describe("ERC1155 Token", () => {
    let dai: ERC20;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let rateAnchor: number;
    let futureCash: FutureCash;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let erc1155: ERC1155Token;
    let t: TestUtils;
    let maturities: number[];
    let erc1155Receiver: any;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;
        escrow = objs.escrow;
        portfolios = objs.portfolios;
        erc1155 = objs.erc1155;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);
        erc1155Receiver = await deployContract(owner, ERC1155MockReceiverArtifact);

        // Set the blockheight to the beginning of the next period
        let block = await provider.getBlockNumber();
        await mineBlocks(provider, 20 - (block % 20));

        t = new TestUtils(escrow, futureCash, portfolios, dai, owner, objs.chainlink, objs.uniswap);
        maturities = await futureCash.getActiveMaturities();
        await t.setupLiquidity();
        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
    });

    afterEach(async () => {
        expect(await t.checkBalanceIntegrity([owner, wallet, wallet2, erc1155Receiver])).to.be.true;
        expect(await t.checkCashIntegrity([owner, wallet, wallet2, erc1155Receiver])).to.be.true;
        expect(await t.checkMarketIntegrity([owner, wallet, wallet2, erc1155Receiver])).to.be.true;
    });

    it("cannot send tokens to the zero address", async () => {
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(owner.address, 0));

        await expect(erc1155.connect(owner).safeTransferFrom(
            owner.address,
            AddressZero,
            id,
            WeiPerEther.mul(900),
            "0x0"
        )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INVALID_ADDRESS));
    });

    it("cannot transfer matured trades", async () => {
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, 0);
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 0));

        await mineBlocks(provider, 20);
        await expect(erc1155.connect(wallet).safeTransferFrom(
            wallet.address,
            owner.address,
            id,
            WeiPerEther.mul(100),
            "0x0"
        )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_TRANSFER_MATURED_TRADE));
    });

    it("cannot overflow uint128 in value", async () => {
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(owner.address, 0));

        await expect(erc1155.connect(owner).safeTransferFrom(
            owner.address,
            wallet.address,
            id,
            "0xffffffffffffffffffffffffffffffffffffffff",
            "0x0"
        )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INTEGER_OVERFLOW));
    });

    it("only the sender can call transfer", async () => {
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, 40_000_000);
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 0));

        await expect(erc1155.connect(owner).safeTransferFrom(
            wallet.address,
            owner.address,
            id,
            WeiPerEther.mul(100),
            "0x0"
        )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UNAUTHORIZED_CALLER));
    });

    it("cannot call transfer with too much balance", async () => {
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, 40_000_000);
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 0));

        await expect(erc1155.connect(wallet).safeTransferFrom(
            wallet.address,
            owner.address,
            id,
            WeiPerEther.mul(105),
            "0x0"
        )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
    });

    it("can transfer cash receiver", async () => {
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, 40_000_000);
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 0));

        await expect(erc1155.connect(wallet).safeTransferFrom(
            wallet.address,
            owner.address,
            id,
            WeiPerEther.mul(100),
            "0x0"
        )).to.emit(erc1155, "TransferSingle");

        expect(await portfolios.getTrades(wallet.address)).to.have.lengthOf(0);
        expect(await erc1155.balanceOf(wallet.address, id)).to.equal(0);
        expect(await t.hasCashPayer(owner, maturities[0], WeiPerEther.mul(9900))).to.be.true;
    });

    it("can transfer liquidity tokens between accounts", async () => {
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(owner.address, 0));

        await expect(erc1155.connect(owner).safeTransferFrom(
            owner.address,
            wallet.address,
            id,
            WeiPerEther.mul(900),
            "0x0"
        )).to.emit(erc1155, "TransferSingle");

        expect(await t.hasLiquidityToken(owner, maturities[0], WeiPerEther.mul(9100), WeiPerEther.mul(10_000))).to.be.true;
        expect(await t.hasLiquidityToken(wallet, maturities[0], WeiPerEther.mul(900), new BigNumber(0))).to.be.true;
    });

    it("cannot transfer future cash payer between accounts", async () => {
        await futureCash.connect(wallet).takeCollateral(maturities[0], WeiPerEther.mul(100), 1000, 60_000_000);
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 0));

        await expect(erc1155.connect(wallet).safeTransferFrom(
            wallet.address,
            owner.address,
            id,
            WeiPerEther.mul(100),
            "0x0"
        )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_TRANSFER_PAYER));
    });

    it("can transfer trades in batch", async () => {
        await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10_000), [1]);
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, 40_000_000);
        await futureCash.connect(wallet).takeFutureCash(maturities[1], WeiPerEther.mul(100), 1000, 20_000_000);

        const id1 = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 0));
        const id2 = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 1));

        await expect(erc1155.connect(wallet).safeBatchTransferFrom(
            wallet.address,
            owner.address,
            [id1, id2],
            [WeiPerEther.mul(50), WeiPerEther.mul(75)],
            "0x0"
        )).to.emit(erc1155, "TransferBatch");

        const balances = await erc1155.balanceOfBatch([wallet.address, wallet.address], [id1, id2]);
        expect(balances[0]).to.equal(WeiPerEther.mul(50));
        expect(balances[1]).to.equal(WeiPerEther.mul(25));
        expect(await t.hasCashPayer(owner, maturities[0], WeiPerEther.mul(9950))).to.be.true;
        expect(await t.hasCashPayer(owner, maturities[1], WeiPerEther.mul(9925))).to.be.true;
    });

    it("can decode trade ids", async() => {
        const trade = await portfolios.getTrade(owner.address, 0);
        const id = await erc1155.encodeTradeId(trade);
        const vals = await erc1155.decodeTradeId(id);

        expect(vals[0]).to.equal(trade.instrumentGroupId);
        expect(vals[1]).to.equal(trade.instrumentId);
        expect(vals[2]).to.equal(trade.startBlock);
        expect(vals[3]).to.equal(trade.duration);
        expect(vals[4]).to.equal(trade.swapType);
    });

    it("can approve and use operators", async () => {
        await erc1155.connect(owner).setApprovalForAll(wallet2.address, true);
        expect(await erc1155.isApprovedForAll(owner.address, wallet2.address));
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(owner.address, 0));

        await expect(erc1155.connect(wallet2).safeTransferFrom(
            owner.address,
            wallet.address,
            id,
            WeiPerEther.mul(900),
            "0x0"
        )).to.emit(erc1155, "TransferSingle");
    });

    it("supports erc1155 token receivers on success", async () => {
        await erc1155Receiver.setShouldReject(false);
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(owner.address, 0));

        await expect(erc1155.connect(owner).safeTransferFrom(
            owner.address,
            erc1155Receiver.address,
            id,
            WeiPerEther.mul(900),
            "0x0"
        )).to.emit(erc1155, "TransferSingle");
    });

    it("supports erc1155 token receivers on failure", async () => {
        await erc1155Receiver.setShouldReject(true);
        const id = await erc1155.encodeTradeId(await portfolios.getTrade(owner.address, 0));

        await expect(erc1155.connect(owner).safeTransferFrom(
            owner.address,
            erc1155Receiver.address,
            id,
            WeiPerEther.mul(900),
            "0x0"
        )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ERC1155_NOT_ACCEPTED));
    });

    it("supports erc1155 token receivers on batch success", async () => {
        await erc1155Receiver.setShouldReject(false);
        await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10_000), [1]);
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, 40_000_000);
        await futureCash.connect(wallet).takeFutureCash(maturities[1], WeiPerEther.mul(100), 1000, 20_000_000);

        const id1 = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 0));
        const id2 = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 1));

        await expect(erc1155.connect(wallet).safeBatchTransferFrom(
            wallet.address,
            erc1155Receiver.address,
            [id1, id2],
            [WeiPerEther.mul(50), WeiPerEther.mul(75)],
            "0x0"
        )).to.emit(erc1155, "TransferBatch");
    });

    it("supports erc1155 token receivers on batch failure", async () => {
        await erc1155Receiver.setShouldReject(true);
        await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10_000), [1]);
        await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, 40_000_000);
        await futureCash.connect(wallet).takeFutureCash(maturities[1], WeiPerEther.mul(100), 1000, 20_000_000);

        const id1 = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 0));
        const id2 = await erc1155.encodeTradeId(await portfolios.getTrade(wallet.address, 1));

        await expect(erc1155.connect(wallet).safeBatchTransferFrom(
            wallet.address,
            erc1155Receiver.address,
            [id1, id2],
            [WeiPerEther.mul(50), WeiPerEther.mul(75)],
            "0x0"
        )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.ERC1155_NOT_ACCEPTED));
    });

    it("supports erc165 interface lookup", async () => {
        expect(await erc1155.supportsInterface("0xd9b67a26")).to.be.true;
        expect(await erc1155.supportsInterface("0xffffffff")).to.be.false;
    });
});