import {waffle} from "@nomiclabs/buidler";
import { createFixtureLoader} from "ethereum-waffle";
import {Wallet, providers} from "ethers";
import { WeiPerEther } from 'ethers/constants';
import { SwapnetDeployer } from "../scripts/SwapnetDeployer";
import defaultAccounts from "./defaultAccounts.json";
import { parseEther, BigNumber } from 'ethers/utils';

export const provider = waffle.provider;
export const wallets = defaultAccounts.map(acc => {
    return new Wallet(acc.secretKey, provider);
});
export const fixtureLoader = createFixtureLoader(provider, [wallets[0]]);
export const CURRENCY = {
    ETH: 0,
    DAI: 1,
    BTC: 2
}

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
        WeiPerEther,
        parseEther("1.05"),
        parseEther("1.05")
    );

    const {currencyId, erc20, chainlink, uniswapExchange} = await swapnet.deployMockCurrency(
        prereqs.uniswapFactory,
        parseEther("0.01"), 
        parseEther("0.30"),
        true,
        parseEther("10000")
    );

    const futureCash = await swapnet.deployFutureCashMarket(currencyId,
        4,
        20,
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
        uniswap: uniswapExchange,
        chainlink,
        portfolios: swapnet.portfolios,
        proxyAdmin: swapnet.proxyAdmin,
        erc1155: swapnet.erc1155,
        registry: prereqs.registry,
        directory: swapnet.directory,
        swapnet: swapnet,
        uniswapFactory: prereqs.uniswapFactory
    };
}

export async function mineBlocks(provider: providers.Web3Provider, numBlocks: number) {
    for (let i = 0; i < numBlocks; i++) {
        await provider.send("evm_mine", []);
    }
}
