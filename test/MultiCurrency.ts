import chai from "chai";
import {solidity} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, mineBlocks, CURRENCY} from "./fixtures";
import {Wallet} from "ethers";
import {WeiPerEther} from "ethers/constants";

import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import { Escrow } from '../typechain/Escrow';
import { Portfolios } from '../typechain/Portfolios';
import { TestUtils } from './testUtils';
import { UniswapExchangeInterface } from '../typechain/UniswapExchangeInterface';
import { MockAggregator } from '../typechain/MockAggregator';
import { SwapnetDeployer } from '../scripts/SwapnetDeployer';
import { parseEther, BigNumber } from 'ethers/utils';
import { UniswapFactoryInterface } from '../typechain/UniswapFactoryInterface';
import { ErrorDecoder, ErrorCodes } from '../scripts/errorCodes';

chai.use(solidity);
const {expect} = chai;

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

        const newCurrency = await swapnet.deployMockCurrency(objs.uniswapFactory, parseEther("0.01"), parseEther("1.20"), true);
        const newFutureCash = await swapnet.deployFutureCashMarket(
          newCurrency.currencyId,
          2, 60, parseEther("10000"), new BigNumber(0), new BigNumber(0), 1e9, 1_020_000_000, 100
        );

        token[1] = newCurrency.erc20;
        futureCash[1] = newFutureCash;
        chainlink[1] = newCurrency.chainlink;
        uniswap[1] = newCurrency.uniswapExchange;

        await escrow.setReserveAccount(reserve.address);
        for (let c of token) {
          await c.transfer(wallet.address, WeiPerEther.mul(10_000));
          await c.transfer(wallet2.address, WeiPerEther.mul(10_000));
          await c.transfer(reserve.address, WeiPerEther.mul(10_000));

          await c.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
          await c.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
          await c.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));
          await c.connect(reserve).approve(escrow.address, WeiPerEther.mul(100_000_000));

          await escrow.connect(reserve).deposit(c.address, parseEther("1000"));
        }

        t1 = new TestUtils(escrow, futureCash[0], portfolios, token[0], owner, chainlink[0], uniswap[0]);
        t2 = new TestUtils(escrow, futureCash[1], portfolios, token[1], owner, chainlink[1], uniswap[1]);
        wbtc = await swapnet.deployMockCurrency(uniswapFactory, parseEther("10"), parseEther("1.5"), false);
        await wbtc.erc20.transfer(wallet.address, parseEther("100000"));

        // Set the blockheight to the beginning of the next period
        let block = await provider.getBlockNumber();
        await mineBlocks(provider, 20 - (block % 20));
    });

    afterEach(async () => {
      // TODO
    });

    const setupTest = async () => {
      // This is equivalent to 25 ETH or 2500 Dai
      await wbtc.erc20.connect(wallet).approve(escrow.address, parseEther("100000"));
      await escrow.connect(wallet).deposit(wbtc.erc20.address, parseEther("0.5"));
      await escrow.connect(wallet2).deposit(t1.dai.address, parseEther("1000"));

      await t1.setupLiquidity();
      const maturities = await t1.futureCash.getActiveMaturities();
      await t1.futureCash.connect(wallet).takeCollateral(
        maturities[0],
        parseEther("100"),
        1000,
        80_000_000
      );

      await escrow.connect(wallet).withdraw(t1.dai.address,
        await escrow.currencyBalances(t1.dai.address, wallet.address)
      );

      await mineBlocks(provider, 20);
    }

    it("allows an account to trade on two different instrument groups in the same currency", async () => {
      const futureCashNew = await swapnet.deployFutureCashMarket(
        CURRENCY.DAI,
        2, 60, parseEther("10000"), new BigNumber(0), new BigNumber(0), 1e9, 1_020_000_000, 100
      );
      const tNew = new TestUtils(escrow, futureCashNew, portfolios, token[0], owner, chainlink[0], uniswap[0]);

      await t1.setupLiquidity();
      await tNew.setupLiquidity();
      await t1.borrowAndWithdraw(wallet, WeiPerEther.mul(100), 1.5, 0, 100_000_000);
      await tNew.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
    });

    it("allows an account to trade on two currencies", async () => {
      await t1.setupLiquidity();
      await t2.setupLiquidity();
      await t1.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
      await t2.borrowAndWithdraw(wallet, WeiPerEther.mul(100));
    });

    it("converts deposit currencies to ETH", async () => {
      expect(wbtc.currencyId).to.equal(3);
      const converted = await escrow.convertBalancesToETH([
          new BigNumber(0), new BigNumber(0), new BigNumber(0), parseEther("0.3")
      ]);

      expect(converted[0]).to.equal(new BigNumber(0));
      expect(converted[1]).to.equal(new BigNumber(0));
      expect(converted[2]).to.equal(new BigNumber(0));
      expect(converted[3]).to.equal(new BigNumber(parseEther("4.5")));
    });

    it("[5] reverts if there is no exchange for a deposit currency", async () => {
      await setupTest();
      await expect(escrow.settleCashBalance(
        CURRENCY.DAI,
        wbtc.currencyId,
        wallet.address,
        owner.address,
        parseEther("100")
      )).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.NO_EXCHANGE_LISTED_FOR_PAIR));
    });

    it("[6] settles cash with a secondary deposit currency", async () => {
      await setupTest();
      await escrow.connect(wallet2).settleCashBalance(
        CURRENCY.DAI,
        wbtc.currencyId,
        wallet.address,
        owner.address,
        parseEther("100")
      );
    });

    it("[4] does not settle cash with the reserve account if the account has collateral", async () => {
      await setupTest();
      await wbtc.chainlink.setAnswer(parseEther("1"));
      await escrow.connect(wallet2).settleCashBalance(
        CURRENCY.DAI,
        wbtc.currencyId,
        wallet.address,
        owner.address,
        parseEther("100")
      );
      expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(parseEther("-100"));
    });

    it("[4] does not settle cash with the reserve account if the account has future cash", async () => {
      await setupTest();

      await t2.setupLiquidity(owner, 0.5, parseEther("10000"), [1]);
      await escrow.connect(wallet).deposit(t2.dai.address, parseEther("100"));
      const maturities = await t2.futureCash.getActiveMaturities();
      await t2.futureCash.connect(wallet).takeFutureCash(maturities[1], parseEther("100"), 1000, 0);

      await wbtc.chainlink.setAnswer(parseEther("1.5"));

      // liquidate to clear out the BTC
      await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, wbtc.currencyId);

      const currencyBalance = await escrow.currencyBalances(t1.dai.address, wallet.address);
      await escrow.connect(wallet2).settleCashBalance(
        CURRENCY.DAI,
        wbtc.currencyId,
        wallet.address,
        owner.address,
        parseEther("100")
      );
      expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(parseEther("-100").add(currencyBalance));
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
      await escrow.connect(wallet2).settleCashBalance(
        CURRENCY.DAI,
        wbtc.currencyId,
        wallet.address,
        owner.address,
        parseEther("100")
      );

      expect(await escrow.currencyBalances(t1.dai.address, reserve.address)).to.equal(reserveBalance.sub(shortfall));
    });

    it("liquidates accounts in a currency with designated collateral", async () => {
      await setupTest();
      await wbtc.chainlink.setAnswer(parseEther("1"));
      await escrow.connect(wallet2).liquidate(wallet.address, CURRENCY.DAI, wbtc.currencyId);
    });
  });