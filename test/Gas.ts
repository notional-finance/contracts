import { fixture, wallets, fixtureLoader, provider, fastForwardToMaturity } from "./fixtures";
import { Wallet } from "ethers";
import { WeiPerEther } from "ethers/constants";

import {Ierc20 as ERC20} from "../typechain/Ierc20";
import {CashMarket} from "../typechain/CashMarket";
import {Escrow} from "../typechain/Escrow";
import { parseEther } from 'ethers/utils';
import { BLOCK_TIME_LIMIT } from './testUtils';

describe("Gas", () => {
    let dai: ERC20;
    let owner: Wallet;
    let wallet: Wallet;
    let futureCash: CashMarket;
    let escrow: Escrow;
    let maturities: number[];

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.cashMarket;
        escrow = objs.escrow;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));

        // Set the blockheight to the beginning of the next period
        maturities = await futureCash.getActiveMaturities();
        await fastForwardToMaturity(provider, maturities[1]);
        maturities = await futureCash.getActiveMaturities();
    });

    it("trading", async () => {
      await escrow.deposit(dai.address, parseEther("4000000"));
      await futureCash.addLiquidity(maturities[0], parseEther("500000"), parseEther("500000"), 0, 100_000_000, BLOCK_TIME_LIMIT);
      await futureCash.addLiquidity(maturities[0], parseEther("500000"), parseEther("500000"), 0, 100_000_000, BLOCK_TIME_LIMIT);
      await futureCash.addLiquidity(maturities[1], parseEther("500000"), parseEther("500000"), 0, 100_000_000, BLOCK_TIME_LIMIT);
      await futureCash.addLiquidity(maturities[1], parseEther("500000"), parseEther("500000"), 0, 100_000_000, BLOCK_TIME_LIMIT);
      await futureCash.addLiquidity(maturities[2], parseEther("500000"), parseEther("500000"), 0, 100_000_000, BLOCK_TIME_LIMIT);
      await futureCash.addLiquidity(maturities[2], parseEther("500000"), parseEther("500000"), 0, 100_000_000, BLOCK_TIME_LIMIT);
      await futureCash.addLiquidity(maturities[3], parseEther("500000"), parseEther("500000"), 0, 100_000_000, BLOCK_TIME_LIMIT);
      await futureCash.addLiquidity(maturities[3], parseEther("500000"), parseEther("500000"), 0, 100_000_000, BLOCK_TIME_LIMIT);

      await futureCash.removeLiquidity(maturities[1], parseEther("500000"), BLOCK_TIME_LIMIT);
      await futureCash.removeLiquidity(maturities[2], parseEther("500000"), BLOCK_TIME_LIMIT);
      await futureCash.removeLiquidity(maturities[3], parseEther("500000"), BLOCK_TIME_LIMIT);

      await escrow.connect(wallet).depositEth({value: parseEther("10000")});
      await futureCash.connect(wallet).takeCurrentCash(maturities[0], parseEther("10000"), BLOCK_TIME_LIMIT, 100_000_000);
      await futureCash.connect(wallet).takeCurrentCash(maturities[1], parseEther("10000"), BLOCK_TIME_LIMIT, 100_000_000);
      await futureCash.connect(wallet).takeCurrentCash(maturities[2], parseEther("10000"), BLOCK_TIME_LIMIT, 100_000_000);

      await futureCash.connect(wallet).takefCash(maturities[1], parseEther("10000"), BLOCK_TIME_LIMIT, 0);
      await futureCash.connect(wallet).takefCash(maturities[2], parseEther("10000"), BLOCK_TIME_LIMIT, 0);
      await futureCash.connect(wallet).takefCash(maturities[3], parseEther("10000"), BLOCK_TIME_LIMIT, 0);
    }).timeout(5_000_000);

}).timeout(5_000_000);

