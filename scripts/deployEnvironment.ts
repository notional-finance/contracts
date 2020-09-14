import { Ierc1820Registry as IERC1820Registry } from "../typechain/Ierc1820Registry";
import { Iweth as IWETH } from '../typechain/Iweth';
import { Ierc20 as ERC20 } from "../typechain/Ierc20";
import { MockAggregator } from '../mocks/MockAggregator';
import { IAggregator } from '../typechain/IAggregator';

import WETHArtifact from "../mocks/WETH9.json";
import ERC1820RegistryArtifact from "../mocks/ERC1820Registry.json";
import MockDaiArtifact from "../mocks/MockDai.json";
import MockUSDCArtifact from "../mocks/MockUSDC.json";
import MockAggregatorArtfiact from "../mocks/MockAggregator.json";
import Debug from "debug";
import { Wallet, Contract } from 'ethers';
import { Environment, NotionalDeployer } from './NotionalDeployer';
import { parseEther, BigNumber } from 'ethers/utils';

const log = Debug("test:deployEnvironment");

export async function deployTestEnvironment(
    deployWallet: Wallet,
    wethAddress: string,
    registryAddress: string,
    confirmations: number
): Promise<Environment> {
    log("Deploying test environment");

    const dai = (await NotionalDeployer.deployContract(deployWallet, MockDaiArtifact, [])) as ERC20;
    const usdc = (await NotionalDeployer.deployContract(deployWallet, MockUSDCArtifact, [])) as ERC20;

    const daiOracle = (await NotionalDeployer.deployContract(deployWallet, MockAggregatorArtfiact, [])) as MockAggregator;
    await NotionalDeployer.txMined(daiOracle.setAnswer(parseEther("0.01")), confirmations);
    const usdcOracle = (await NotionalDeployer.deployContract(deployWallet, MockAggregatorArtfiact, [])) as MockAggregator;
    await NotionalDeployer.txMined(usdcOracle.setAnswer(new BigNumber(0.01e6)), confirmations);

    return {
        deploymentWallet: deployWallet,
        WETH: new Contract(wethAddress, WETHArtifact.abi, deployWallet) as IWETH,
        ERC1820: new Contract(registryAddress, ERC1820RegistryArtifact.abi, deployWallet) as IERC1820Registry,
        DAI: dai,
        USDC: usdc,
        DAIETHOracle: daiOracle as unknown as IAggregator,
        USDCETHOracle: usdcOracle as unknown as IAggregator
    }

}

export async function deployLocal(deployWallet: Wallet): Promise<Environment> {
    log("Deploying to local environment");
    const weth = (await NotionalDeployer.deployContract(deployWallet, WETHArtifact, [])) as IWETH;
    const registry = (await NotionalDeployer.deployContract(deployWallet, ERC1820RegistryArtifact, [])) as IERC1820Registry;

    return await deployTestEnvironment(deployWallet, weth.address, registry.address, 1);
}