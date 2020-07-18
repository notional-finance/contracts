import {waffle, ethers} from "@nomiclabs/buidler";
import {createFixtureLoader} from "ethereum-waffle";
import {Wallet, providers} from "ethers";
import {SwapnetDeployer} from "../scripts/SwapnetDeployer";
import defaultAccounts from "./defaultAccounts.json";
import {parseEther, BigNumber} from "ethers/utils";

// Silences multiple initialize signature errors
ethers.errors.setLogLevel("error");
export const provider = waffle.provider;
export const wallets = defaultAccounts.map(acc => {
    return new Wallet(acc.secretKey, provider);
});
export const fixtureLoader = createFixtureLoader(provider, [wallets[0]]);
export const CURRENCY = {
    ETH: 0,
    DAI: 1
};

/**
 * Deploys and configures a base set of contracts for unit testing.
 * @param provider the provider that will be used for the fixture
 * @param Wallet[] only the first wallet is used, will be the owner for all contracts
 */
export async function fixture(provider: providers.Provider, [owner]: Wallet[]) {
    const prereqs = await SwapnetDeployer.deployPrerequisites(owner);
    const swapnet = await SwapnetDeployer.deploy(
        owner,
        prereqs.registry.address,
        prereqs.weth.address,
        prereqs.uniswapRouter.address,
        parseEther("1.10"),
        parseEther("1.05"),
        parseEther("1.05")
    );

    const {currencyId, erc20, chainlink, uniswapPair} = await swapnet.deployMockCurrency(
        prereqs.uniswapFactory,
        prereqs.uniswapRouter,
        parseEther("0.01"),
        parseEther("1.30"),
        true,
        parseEther("10000")
    );

    // We will do 60 second blocks for testing
    const futureCash = await swapnet.deployFutureCashMarket(
        currencyId,
        4,
        60,
        parseEther("10000"),
        new BigNumber(0),
        new BigNumber(0),
        1e9
    );

    return {
        erc20,
        futureCash,
        escrow: swapnet.escrow,
        owner,
        uniswap: uniswapPair,
        chainlink,
        portfolios: swapnet.portfolios,
        proxyAdmin: swapnet.proxyAdmin,
        erc1155: swapnet.erc1155,
        registry: prereqs.registry,
        directory: swapnet.directory,
        swapnet: swapnet,
        uniswapFactory: prereqs.uniswapFactory,
        uniswapRouter: prereqs.uniswapRouter,
        weth: prereqs.weth
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
