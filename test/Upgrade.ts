import chai from "chai";
import {solidity, deployContract} from "ethereum-waffle";
import {fixture, wallets, fixtureLoader, provider, mineBlocks} from "./fixtures";
import {Wallet, ethers} from "ethers";
import {WeiPerEther} from "ethers/constants";

import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import { ProxyAdmin } from '../typechain/ProxyAdmin';
import FutureCashArtifact from '../build/FutureCash.json';
import { Escrow } from '../typechain/Escrow';
import AdminUpgradeabilityProxyArtifact from "../build/AdminUpgradeabilityProxy.json";
import { AdminUpgradeabilityProxy } from '../typechain/AdminUpgradeabilityProxy';

chai.use(solidity);
const {expect} = chai;

describe("Upgradebility", () => {
    let dai: ERC20;
    let futureCash: FutureCash;
    let escrow: Escrow;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let rateAnchor: number;
    let proxyAdmin: ProxyAdmin;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;
        proxyAdmin = objs.proxyAdmin;
        escrow = objs.escrow;

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
    });

    it("allows upgrades to the contracts without losing access to previous storage", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10_000), WeiPerEther.mul(10_000), 1000);
        const futureCashProxy = new ethers.Contract(futureCash.address, AdminUpgradeabilityProxyArtifact.abi, owner) as AdminUpgradeabilityProxy;

        const futureCashUpgrade = (await deployContract(owner, FutureCashArtifact, [], { gasLimit: 6000000 })) as FutureCash;
        await expect(proxyAdmin.upgrade(futureCash.address, futureCashUpgrade.address))
          .to.emit(futureCashProxy, "Upgraded")
          .withArgs(futureCashUpgrade.address);

        const markets = await futureCash.markets(maturities[0]);
        expect(markets.totalCollateral).to.equal(WeiPerEther.mul(10000));
        expect(markets.totalLiquidity).to.equal(WeiPerEther.mul(10000));
        expect(markets.totalFutureCash).to.equal(WeiPerEther.mul(10000));
    });
});