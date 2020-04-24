import chai from "chai";
import {solidity, deployContract} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, mineBlocks} from "./fixtures";
import {Wallet} from "ethers";
import {WeiPerEther} from "ethers/constants";

import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import { ProxyAdmin } from '../typechain/ProxyAdmin';
import { AdminUpgradeabilityProxy } from '../typechain/AdminUpgradeabilityProxy';
import FutureCashArtifact from '../build/FutureCash.json';

chai.use(solidity);
const {expect} = chai;

describe("Upgradebility", () => {
    let dai: ERC20;
    let futureCash: FutureCash;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let rateAnchor: number;
    let proxy: AdminUpgradeabilityProxy;
    let proxyAdmin: ProxyAdmin;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;
        proxy = objs.proxy;
        proxyAdmin = objs.proxyAdmin;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(futureCash.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(futureCash.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(futureCash.address, WeiPerEther.mul(100_000_000));

        await futureCash.setMaxTradeSize(WeiPerEther.mul(10_000));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);
        await futureCash.setHaircutSize(WeiPerEther.div(100).mul(30), WeiPerEther.add(WeiPerEther.div(100).mul(2)));
        await futureCash.setNumPeriods(4);
        await futureCash.setFee(0);

        // Set the blockheight to the beginning of the next period
        let block = await provider.getBlockNumber();
        await mineBlocks(provider, 20 - (block % 20));
    });

    it("allows upgrades to the contracts without losing access to previous storage", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await futureCash.depositDai(WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);

        const futureCashUpgrade = (await deployContract(owner, FutureCashArtifact, [], { gasLimit: 6000000 })) as FutureCash;
        await expect(proxyAdmin.upgrade(proxy.address, futureCashUpgrade.address))
          .to.emit(proxy, "Upgraded")
          .withArgs(futureCashUpgrade.address);

        const markets = await futureCash.markets(maturities[0]);
        expect(markets.totalCollateral).to.equal(WeiPerEther.mul(10000));
        expect(markets.totalLiquidity).to.equal(WeiPerEther.mul(10000));
        expect(markets.totalFutureCash).to.equal(WeiPerEther.mul(10000));
    });
});