import chai from "chai";
import {ethers, waffle} from "@nomiclabs/buidler";
import {solidity, deployContract, createFixtureLoader} from "ethereum-waffle";
import {Wallet, providers} from "ethers";
import {readFileSync} from "fs";
import path from "path";
import { WeiPerEther } from 'ethers/constants';
import { CoreContracts } from "../scripts/SwapnetDeployer";

import ERC20Artifact from "../build/ERC20.json";
import {ERC20} from "../typechain/ERC20";

import MockAggregatorArtifact from "../build/MockAggregator.json";
import {MockAggregator} from "../typechain/MockAggregator";

import {FutureCash} from "../typechain/FutureCash";
import {Escrow} from "../typechain/Escrow";
import {Portfolios} from "../typechain/Portfolios";
import {Directory} from "../typechain/Directory";
import {RiskFramework} from "../typechain/RiskFramework";
import {ERC1155Token} from "../typechain/ERC1155Token";

import UniswapFactoryArtifact from "../mocks/UniswapFactory.json";
import {UniswapFactoryInterface} from "../typechain/UniswapFactoryInterface";

import UniswapExchangeArtifact from "../mocks/UniswapExchange.json";
import {UniswapExchangeInterface} from "../typechain/UniswapExchangeInterface";
import defaultAccounts from "./defaultAccounts.json";

import ProxyAdminArtifact from "../build/ProxyAdmin.json";
import {ProxyAdmin} from "../typechain/ProxyAdmin";

import AdminUpgradeabilityProxyArtifact from "../build/AdminUpgradeabilityProxy.json";

import ERC1820RegistryArtifact from "../mocks/ERC1820Registry.json";
import {IERC1820Registry} from "../typechain/IERC1820Registry";

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
    /** Deploy Mocks */
    const chainlink = (await deployContract(owner, MockAggregatorArtifact, [])) as MockAggregator;
    expect(chainlink.address).to.properAddress;

    const erc20 = (await deployContract(owner, ERC20Artifact, [])) as ERC20;
    expect(erc20.address).to.properAddress;

    const uniswapTemplate = (await deployContract(owner, UniswapExchangeArtifact, [])) as UniswapExchangeInterface;
    expect(uniswapTemplate.address).to.properAddress;

    const uniswapFactory = (await deployContract(owner, UniswapFactoryArtifact, [])) as UniswapFactoryInterface;
    expect(uniswapFactory.address).to.properAddress;
    await uniswapFactory.initializeFactory(uniswapTemplate.address);

    await uniswapFactory.createExchange(erc20.address, {gasLimit: 5000000});

    const uniswap = new ethers.Contract(
        await uniswapFactory.getExchange(erc20.address),
        UniswapExchangeArtifact.abi,
        owner
    ) as UniswapExchangeInterface;
    expect(uniswap.address).to.properAddress;

    const registry = await deployContract(owner, ERC1820RegistryArtifact, []) as IERC1820Registry;

    /** Setup Mocks */

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

    /** Initialize Proxy Admin */
    const proxyAdmin = await deployContract(owner, ProxyAdminArtifact, []) as ProxyAdmin;
    expect(proxyAdmin.address).to.properAddress;

    /** Deploy Swapnet Logic Contracts */
    let buildDir: string;
    let gasLimit: number;
    if (process.env.COVERAGE == "true") {
        buildDir = ".coverage_artifacts"
        gasLimit = 20_000_000;
    } else {
        buildDir = "build"
        gasLimit = 6_000_000;
    }
    const directory = await deploySwapnetContract<Directory>(owner, buildDir, "Directory", [], '', proxyAdmin, gasLimit);
    const escrow = await deploySwapnetContract<Escrow>(owner, buildDir, "Escrow", [directory.address, registry.address], 'address,address', proxyAdmin, gasLimit);
    const portfolios = await deploySwapnetContract<Portfolios>(owner, buildDir, "Portfolios", [directory.address, 100], 'address,uint256', proxyAdmin, gasLimit);
    const risk = await deploySwapnetContract<RiskFramework>(owner, buildDir, "RiskFramework", [directory.address], 'address', proxyAdmin, gasLimit);
    const erc1155 = await deploySwapnetContract<ERC1155Token>(owner, buildDir, "ERC1155Token", [directory.address], 'address', proxyAdmin, gasLimit);

    // Setup directory
    await directory.setContract(CoreContracts.Escrow, escrow.address);
    await directory.setContract(CoreContracts.Portfolios, portfolios.address);
    await directory.setContract(CoreContracts.RiskFramework, risk.address);
    await directory.setContract(CoreContracts.ERC1155Token, erc1155.address);
    await directory.setDependencies(CoreContracts.Portfolios, [CoreContracts.Escrow, CoreContracts.RiskFramework, CoreContracts.ERC1155Token]);
    await directory.setDependencies(CoreContracts.Escrow, [CoreContracts.Portfolios]);
    await directory.setDependencies(CoreContracts.RiskFramework, [CoreContracts.Portfolios]);
    await directory.setDependencies(CoreContracts.ERC1155Token, [CoreContracts.Portfolios]);

    const futureCash = await deploySwapnetContract<FutureCash>(owner, buildDir, "FutureCash", [directory.address, erc20.address], 'address,address', proxyAdmin, gasLimit);

    /**** Setup Default Contract Parameters *****/

    // Create a currency groups
    // 1
    await escrow.createCurrencyGroup(ethers.constants.AddressZero); // This creates the ETH currency group
    // 2
    await escrow.createCurrencyGroup(erc20.address);
    await escrow.addExchangeRate(2, 1, chainlink.address, uniswap.address, WeiPerEther.div(100).mul(30));
    await chainlink.setAnswer(WeiPerEther.div(100));
    await escrow.setDiscounts(WeiPerEther, WeiPerEther.add(WeiPerEther.div(100).mul(5)));

    // Sets the collateral currency to ETH
    await portfolios.setCollateralCurrency(1);
    await escrow.setCollateralCurrency(1);

    await risk.setHaircut(WeiPerEther.add(WeiPerEther.div(100).mul(5)));

    // Setup instrument group
    await portfolios.createInstrumentGroup(4, 20, 1e9, 2, futureCash.address, ethers.constants.AddressZero);
    // This will set the parameters on the future cash market

    // Setup Future Cash Market
    await futureCash.setMaxTradeSize(WeiPerEther.mul(10_000));
    await futureCash.setFee(0, 0);

    return {erc20, futureCash, escrow, owner, uniswap, chainlink, portfolios, proxyAdmin, erc1155};
}

async function deploySwapnetContract<T>(owner: Wallet, buildDir: string, contract: string, params: any[], initializeSig: string, proxyAdmin: ProxyAdmin, gasLimit: number) {
    const artifact = JSON.parse(readFileSync(path.join(buildDir, `${contract}.json`), "utf8"));
    const logic = (await deployContract(owner, artifact, [], { gasLimit: gasLimit }));
    expect(logic.address).to.properAddress;

    const abi = new ethers.utils.Interface(artifact.abi);
    const data = abi.functions[`initialize(${initializeSig})`].encode(params);
    const proxy = await deployContract(
        owner,
        AdminUpgradeabilityProxyArtifact,
        [logic.address, proxyAdmin.address, data]
    );

    // TODO: set dependencies via config here

    return new ethers.Contract(proxy.address, artifact.abi, owner) as unknown as T;
}

export async function mineBlocks(provider: providers.Web3Provider, numBlocks: number) {
    for (let i = 0; i < numBlocks; i++) {
        await provider.send("evm_mine", []);
    }
}
