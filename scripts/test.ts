import {SwapnetLite} from "../scripts/SwapnetLite";
import {JsonRpcProvider, Web3Provider} from "ethers/providers";
import {Wallet, ethers, providers} from "ethers";
import Debug from "debug";

const log = Debug("setup-swapnet");

async function setupDemoSwapnet() {
    const provider = new JsonRpcProvider("http://localhost:8545");
    let swapnet = SwapnetLite.restoreFromFile("contracts.json", provider);

    let portfolio = await swapnet.futureCash.getAccountTrades(swapnet.owner.address);
    console.log(portfolio);
}

setupDemoSwapnet()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });

async function mineBlocks(provider: providers.Web3Provider, numBlocks: number) {
    for (let i = 0; i < numBlocks; i++) {
        await provider.send("evm_mine", [Math.floor(new Date().getTime() / 1000)]);
    }
}