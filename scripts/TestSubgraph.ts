import chai from "chai";
import {solidity} from "ethereum-waffle";
import {SwapnetLite} from "../scripts/SwapnetLite";
import {JsonRpcProvider, Provider, Web3Provider} from "ethers/providers";
import {Wallet, ethers, providers} from "ethers";
import Debug from "debug";

chai.use(solidity);
const {expect} = chai;
const SUBGRAPH_URL = "http://localhost:8000/subgraphs/name/swapnet-protocol/swapnet";
const log = Debug("subgraph-test");

function initWallets(provider: Provider) {
    return [
        new Wallet("0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1", provider),
        new Wallet("0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c", provider),
        new Wallet("0x646f1ce2fdad0e6deeeb5c7e8e5543bdde65e86029e2fd9fc169899c440a7913", provider),
        new Wallet("0xadd53f9a7e588d003326d1cbf9e4a43c061aadd9bc938c843a79e7b4fd2ad743", provider),
        new Wallet("0x395df67f0c2d2d9fe1ad08d1bc8b6627011959b79c53d7dd6a3536a33ab8a4fd", provider),
        new Wallet("0xe485d098507f54e7733a205420dfddbe58db035fa577fc294ebd14db90767a52", provider),
        new Wallet("0xa453611d9419d0e56f499079478fd72c37b251a94bfde4d19872c44cf65386e3", provider),
        new Wallet("0x829e924fdf021ba3dbbc4225edfece9aca04b929d6e75613329ca6f1d31c0bb4", provider),
        new Wallet("0xb0057716d5917badaf911b193b12b910811c1497b5bada8d7711f758981c3773", provider)
    ];
}

async function testSubgraph() {
    let swapnet = SwapnetLite.restoreFromFile("contracts.json", new JsonRpcProvider("http://localhost:8545"));
    const wallets = initWallets(swapnet.provider);

    /** Setup **/
    // Sets the Uniswap Price, $100 DAI/ETH
    const current_block = await swapnet.provider.getBlock(await swapnet.provider.getBlockNumber());
    await swapnet.dai.approve(swapnet.uniswap.address, ethers.constants.WeiPerEther.mul(100_000_000));
    await swapnet.uniswap.addLiquidity(
        ethers.constants.WeiPerEther.mul(10_000),
        ethers.constants.WeiPerEther.mul(1_000_000),
        current_block.timestamp + 10000,
        {value: ethers.constants.WeiPerEther.mul(10_000), gasLimit: 5000000}
    );
    log("Set uniswap price $100 DAI/ETH");

    await swapnet.futureCash.setCollateralCaps(
        ethers.constants.WeiPerEther.mul(10_000),
        ethers.constants.WeiPerEther.mul(10_000_000)
    );
    await swapnet.futureCash.setCollateralRatio(ethers.constants.WeiPerEther.mul(2));
    await swapnet.futureCash.setNumPeriods(4);
    await swapnet.futureCash.setFee(ethers.constants.WeiPerEther.div(100).mul(3));
    log("Setup swapnet future cash configuration");

    await swapnet.dai.approve(swapnet.futureCash.address, ethers.constants.WeiPerEther.mul(100_000_000));
    await swapnet.futureCash.depositDai(ethers.constants.WeiPerEther.mul(1_000_000));
    let maturities = await swapnet.futureCash.getActiveMaturities();
    for (let maturity of maturities) {
        log(`Adding liquidity to ${maturity}`);
        await swapnet.futureCash.addLiquidity(
            maturity,
            ethers.constants.WeiPerEther.mul(250_000),
            ethers.constants.WeiPerEther.mul(250_000)
        );
    }
    log("Added some liquidity to all maturities");

    /** Mint Some Trades **/
    await swapnet.futureCash.connect(wallets[0]).depositEth({value: ethers.constants.WeiPerEther.mul(500)});
    await swapnet.futureCash.connect(wallets[0]).takeDai(maturities[3], ethers.constants.WeiPerEther.mul(500));
    // await swapnet.futureCash.connect(wallets[0]).takeFutureCash(maturities[3], ethers.constants.WeiPerEther.mul(1_000));
    log(`Minted some trades in wallet ${wallets[0].address}`);

    /** Settle Some Trades **/
    log("Fast forwarding 20 blocks");
    await mineBlocks(swapnet.provider as Web3Provider, 20);
    await swapnet.futureCash.settle(swapnet.owner.address);
    log("Settling owner address");
}

async function mineBlocks(provider: providers.Web3Provider, numBlocks: number) {
    for (let i = 0; i < numBlocks; i++) {
        await provider.send("evm_mine", []);
    }
}

testSubgraph()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
