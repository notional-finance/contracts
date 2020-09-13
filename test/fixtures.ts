import {waffle, ethers} from "@nomiclabs/buidler";
import {createFixtureLoader} from "ethereum-waffle";
import {Wallet, providers} from "ethers";
import {SwapnetDeployer} from "../scripts/SwapnetDeployer";
import defaultAccounts from "./defaultAccounts.json";
import {parseEther, BigNumber} from "ethers/utils";
import { deployLocal } from '../scripts/deployEnvironment';
import { WeiPerEther } from 'ethers/constants';
import { MockAggregator } from '../mocks/MockAggregator';
import { debug } from 'debug';

const log = debug("test:fixtures");

// Silences multiple initialize signature errors
ethers.errors.setLogLevel("error");
export const provider = waffle.provider;
export const wallets = defaultAccounts.map(acc => {
    return new Wallet(acc.secretKey, provider);
});
export const fixtureLoader = createFixtureLoader(provider, [wallets[0]]);
export const CURRENCY = {
    ETH: 0,
    DAI: 1,
    USDC: 2,
    WBTC: 3
};

/**
 * Deploys and configures a base set of contracts for unit testing.
 * @param provider the provider that will be used for the fixture
 * @param Wallet[] only the first wallet is used, will be the owner for all contracts
 */
export async function fixture(provider: providers.Provider, [owner]: Wallet[]) {
    log("Starting to load fixtures");
    const environment = await deployLocal(owner);
    const swapnet = await SwapnetDeployer.deploy(
        environment.deploymentWallet,
        environment,
        new BigNumber(8),
        parseEther("1.30"), // TODO: what do we set this as?
        parseEther("1.06"),
        parseEther("1.02"),
        parseEther("0.80"),
        parseEther("1.10"),
        1
    );

    // List DAI currency
    log("Listing dai fixture");
    const currencyId = await swapnet.listCurrency(
        environment.DAI.address,
        environment.DAIETHOracle,
        parseEther("1.3"),
        false,
        false,
        WeiPerEther, // TODO: check this
        false 
    )

    log("Deploying test future cash market");
    const futureCash = await swapnet.deployFutureCashMarket(
        currencyId,
        4,
        2592000,
        parseEther("10000"),
        new BigNumber(0),
        new BigNumber(0),
        1_100_000_000,
        85
    );

    return {
        erc20: environment.DAI,
        futureCash,
        escrow: swapnet.escrow,
        owner,
        chainlink: environment.DAIETHOracle as unknown as MockAggregator,
        portfolios: swapnet.portfolios,
        proxyAdmin: swapnet.proxyAdmin,
        erc1155: swapnet.erc1155,
        registry: environment.ERC1820,
        directory: swapnet.directory,
        swapnet: swapnet,
        weth: environment.WETH,
        environment: environment
    };
}

export async function fastForwardToMaturity(provider: providers.Web3Provider, maturity: number) {
    await provider.send("evm_mine", [maturity]);
}

export async function fastForwardToTime(provider: providers.Web3Provider, timestamp?: number) {
    if (timestamp == undefined) {
        timestamp = (await provider.getBlock("latest")).timestamp + 1;
    }
    await provider.send("evm_setNextBlockTimestamp", [timestamp]);

    return timestamp;
}
