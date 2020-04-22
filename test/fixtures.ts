import chai from "chai";
import {ethers, waffle} from "@nomiclabs/buidler";
import {solidity, deployContract, createFixtureLoader} from "ethereum-waffle";
import {Wallet, providers} from "ethers";
import {readFileSync} from "fs";

import ERC20Artifact from "../build/ERC20.json";
import {ERC20} from "../typechain/ERC20";

import {FutureCash} from "../typechain/FutureCash";

import UniswapFactoryArtifact from "../uniswap/UniswapFactory.json";
import {UniswapFactoryInterface} from "../typechain/UniswapFactoryInterface";

import UniswapExchangeArtifact from "../uniswap/UniswapExchange.json";
import {UniswapExchangeInterface} from "../typechain/UniswapExchangeInterface";
import defaultAccounts from "./defaultAccounts.json";

chai.use(solidity);
const {expect} = chai;

export const provider = waffle.provider;
export const wallets = defaultAccounts.map(acc => {
    return new Wallet(acc.secretKey, provider);
});
export const fixtureLoader = createFixtureLoader(provider, [wallets[0]]);

/**
 * Deploys and configures a base set of contracts for unit testing.
 * @param provider the provider that will be used for the fixture
 * @param Wallet[] only the first wallet is used, will be the owner for all contracts
 */
export async function fixture(provider: providers.Provider, [owner]: Wallet[]) {
    let erc20 = (await deployContract(owner, ERC20Artifact, [])) as ERC20;
    expect(erc20.address).to.properAddress;

    let uniswapTemplate = (await deployContract(owner, UniswapExchangeArtifact, [])) as UniswapExchangeInterface;
    expect(uniswapTemplate.address).to.properAddress;

    let uniswapFactory = (await deployContract(owner, UniswapFactoryArtifact, [])) as UniswapFactoryInterface;
    expect(uniswapFactory.address).to.properAddress;
    await uniswapFactory.initializeFactory(uniswapTemplate.address);

    await uniswapFactory.createExchange(erc20.address, {gasLimit: 5000000});

    let uniswap = new ethers.Contract(
        await uniswapFactory.getExchange(erc20.address),
        UniswapExchangeArtifact.abi,
        owner
    ) as UniswapExchangeInterface;
    expect(uniswap.address).to.properAddress;

    await erc20.approve(uniswap.address, ethers.constants.WeiPerEther.mul(100_000_000));
    expect(await erc20.balanceOf(owner.address)).to.be.at.least(ethers.constants.WeiPerEther.mul(10_000_000));
    const current_block = await provider.getBlock(await provider.getBlockNumber());

    // This sets a $100 DAI/ETH exchange rate
    await uniswap.addLiquidity(
        ethers.constants.WeiPerEther.mul(10_000),
        ethers.constants.WeiPerEther.mul(1_000_000),
        current_block.timestamp + 300,
        {value: ethers.constants.WeiPerEther.mul(10_000)}
    );

    let futureCashArtifact: any;
    let futureCash: FutureCash;
    if (process.env.COVERAGE == "true") {
        futureCashArtifact = JSON.parse(readFileSync(".coverage_artifacts/FutureCash.json", "utf8"));
        futureCash = (await deployContract(owner, futureCashArtifact, [20, erc20.address, uniswap.address], {
            gasLimit: 20000000
        })) as FutureCash;
        expect(futureCash.address).to.properAddress;
    } else {
        futureCashArtifact = JSON.parse(readFileSync("build/FutureCash.json", "utf8"));
        futureCash = (await deployContract(owner, futureCashArtifact, [20, erc20.address, uniswap.address], {
            gasLimit: 6000000
        })) as FutureCash;
        expect(futureCash.address).to.properAddress;
    }

    return {erc20, futureCash, owner, uniswap};
}

export async function mineBlocks(provider: providers.Web3Provider, numBlocks: number) {
    for (let i = 0; i < numBlocks; i++) {
        await provider.send("evm_mine", []);
    }
}
