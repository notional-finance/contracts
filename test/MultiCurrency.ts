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

chai.use(solidity);
// const {expect} = chai;

describe("Multi Currency", () => {
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let swapnet: SwapnetDeployer;

    let token: ERC20[] = [];
    let uniswap: UniswapExchangeInterface[] = [];
    let chainlink: MockAggregator[] = [];
    let futureCash: FutureCash[] = [];

    let t1: TestUtils;
    let t2: TestUtils;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        escrow = objs.escrow;
        portfolios = objs.portfolios;
        swapnet = objs.swapnet;

        token[0] = objs.erc20;
        futureCash[0] = objs.futureCash;
        chainlink[0] = objs.chainlink;
        uniswap[0] = objs.uniswap;

        const newCurrency = await swapnet.deployMockCurrency(objs.uniswapFactory, parseEther("0.01"), parseEther("0.30"), true);
        const newFutureCash = await swapnet.deployFutureCashMarket(
          newCurrency.currencyId,
          2, 60, parseEther("10000"), new BigNumber(0), new BigNumber(0), 1e9, 1_020_000_000, 100
        );

        token[1] = newCurrency.erc20;
        futureCash[1] = newFutureCash;
        chainlink[1] = newCurrency.chainlink;
        uniswap[1] = newCurrency.uniswapExchange;

        for (let c of token) {
          await c.transfer(wallet.address, WeiPerEther.mul(10_000));
          await c.transfer(wallet2.address, WeiPerEther.mul(10_000));

          await c.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
          await c.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
          await c.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));
        }

        t1 = new TestUtils(escrow, futureCash[0], portfolios, token[0], owner, chainlink[0], uniswap[0]);
        t2 = new TestUtils(escrow, futureCash[1], portfolios, token[1], owner, chainlink[1], uniswap[1]);

        // Set the blockheight to the beginning of the next period
        let block = await provider.getBlockNumber();
        await mineBlocks(provider, 20 - (block % 20));
    });

    afterEach(async () => {
      // TODO
    });

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

    it("settles cash in a currency with designated collateral");
    it("liquidates accounts in a currency with designated collateral");
  });