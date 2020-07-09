import chai from "chai";
import {solidity} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, mineBlocks, CURRENCY} from "./fixtures";
import {Wallet} from "ethers";
import {WeiPerEther, AddressZero} from "ethers/constants";

import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import { ErrorDecoder, ErrorCodes } from '../scripts/errorCodes';
import { Escrow } from '../typechain/Escrow';
import { Portfolios } from '../typechain/Portfolios';
import { TestUtils } from './testUtils';

chai.use(solidity);
const {expect} = chai;

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
    let maturities: number[];

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
        t = new TestUtils(escrow, futureCash, portfolios, dai, owner, objs.chainlink, objs.uniswap);
        maturities = await futureCash.getActiveMaturities();
    });

    afterEach(async () => {
        expect(await t.checkEthBalanceIntegrity([owner, wallet, wallet2])).to.be.true;
        expect(await t.checkBalanceIntegrity([owner, wallet, wallet2])).to.be.true;
        expect(await t.checkCashIntegrity([owner, wallet, wallet2])).to.be.true;
        expect(await t.checkMarketIntegrity([owner, wallet, wallet2])).to.be.true;
    });

    it("returns the proper free collateral amount pre and post maturity", async () => {
      await t.setupLiquidity();
      await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
      const fcBefore = await portfolios.freeCollateralView(wallet.address);
      expect(fcBefore[1][CURRENCY.DAI]).to.equal(WeiPerEther.mul(105));


      await mineBlocks(provider, 20);
      const fcAfter = await portfolios.freeCollateralView(wallet.address);
      expect(fcAfter[1][CURRENCY.DAI]).to.equal(WeiPerEther.mul(100));
    });

    it("prevents assets being added past max assets", async () => {
      await portfolios.setMaxAssets(2);
      await escrow.deposit(dai.address, WeiPerEther.mul(200));
      await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000);
      await expect(
          futureCash.addLiquidity(maturities[1], WeiPerEther.mul(10), WeiPerEther.mul(10), 1000)
      ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.PORTFOLIO_TOO_LARGE));
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

    it("allows future cash groups to be updated", async () =>{
      await portfolios.updateFutureCashGroup(1, 0, 1000, 1e8, CURRENCY.DAI, futureCash.address, owner.address);
      expect(await portfolios.getFutureCashGroup(1)).to.eql([0, 1000, 1e8, CURRENCY.DAI, futureCash.address, owner.address]);
    });
});