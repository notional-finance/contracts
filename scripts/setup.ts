import {SwapnetLite} from "../scripts/SwapnetLite";
import {JsonRpcProvider, Web3Provider} from "ethers/providers";
import {Wallet, providers} from "ethers";
import {WeiPerEther} from "ethers/constants";
import Debug from "debug";

const log = Debug("setup-swapnet");

async function setupDemoSwapnet() {
    const provider = new JsonRpcProvider("http://localhost:8545");
    let swapnet = SwapnetLite.restoreFromFile("contracts.json", provider);

    await swapnet.dai.approve(swapnet.uniswap.address, WeiPerEther.mul(100_000_000));
    // Mine a block and set the current time to make sure that the uniswap liquidity call works
    await provider.send("evm_mine", [Math.floor(new Date().getTime() / 1000)]);
    const current_block = await swapnet.provider.getBlock(await swapnet.provider.getBlockNumber());
    log(`Current Time: ${new Date().getTime()}, Block Time: ${current_block.timestamp}`);
    await swapnet.uniswap.addLiquidity(
        WeiPerEther.mul(10_000),
        WeiPerEther.mul(1_000_000),
        current_block.timestamp + 10000,
        {value: WeiPerEther.mul(10_000), gasLimit: 500000}
    );
    log("Set uniswap price $100 DAI/ETH");

    await swapnet.futureCash.setCollateralCaps(WeiPerEther.mul(10_000), WeiPerEther.mul(10_000_000));
    let rateAnchor = 1_005_000_000;
    await swapnet.futureCash.setRateFactors(rateAnchor, 1000);
    await swapnet.futureCash.setHaircutSize(WeiPerEther.div(100).mul(70), WeiPerEther.add(WeiPerEther.div(100).mul(2)));
    await swapnet.futureCash.setNumPeriods(4);
    await swapnet.futureCash.setFee(100_000);
    log("Setup swapnet future cash configuration");

    const demoWallet = new Wallet("0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1", provider);
    await setupWallet(swapnet, demoWallet);
    log("Setup the demo wallet");

    const otherWallets = [
        new Wallet("0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c", provider),
        new Wallet("0x646f1ce2fdad0e6deeeb5c7e8e5543bdde65e86029e2fd9fc169899c440a7913", provider),
        new Wallet("0xadd53f9a7e588d003326d1cbf9e4a43c061aadd9bc938c843a79e7b4fd2ad743", provider),
    ];
    for (let w of otherWallets) {
        await setupWallet(swapnet, w);
    }
    log("Setup all the other wallets");

    // This sets up the liquidity
    await swapnet.dai.approve(swapnet.futureCash.address, WeiPerEther.mul(100_000_000));
    await swapnet.futureCash.depositDai(WeiPerEther.mul(1_000_000));
    await swapnet.futureCash.depositEth({value: WeiPerEther.mul(1_000)});
    // Set the blockheight to the beginning of the next period
    let block = await provider.getBlockNumber();
    await mineBlocks(provider as Web3Provider, 40 - (block % 40));

    let maturities = await swapnet.futureCash.getActiveMaturities();
    let maxDai = WeiPerEther.mul(225_000);
    for (let maturity of maturities) {
        log(`Adding liquidity to ${maturity}`);
        await swapnet.futureCash.addLiquidity(maturity, WeiPerEther.mul(250_000), maxDai, 1000);
        maxDai.sub(25_000);
    }
    await swapnet.futureCash.takeDai(maturities[3], WeiPerEther.mul(5000), 1000, 0);
    log("Added some liquidity to all maturities");

    maturities = await swapnet.futureCash.getActiveMaturities();
    await swapnet.futureCash.connect(demoWallet).takeDai(maturities[0], WeiPerEther.mul(500), 1000, 0);
    await swapnet.futureCash.connect(otherWallets[0]).takeFutureCash(maturities[0], WeiPerEther.mul(100), 1000, WeiPerEther.mul(100));
    await swapnet.futureCash.connect(otherWallets[1]).takeFutureCash(maturities[0], WeiPerEther.mul(1000), 1000, WeiPerEther.mul(1000));
    await swapnet.futureCash.connect(otherWallets[2]).takeDai(maturities[0], WeiPerEther.mul(100), 1000, 0);

    await swapnet.futureCash.connect(demoWallet).takeFutureCash(maturities[1], WeiPerEther.mul(100), 1000, WeiPerEther.mul(100));
    await swapnet.futureCash.connect(demoWallet).takeDai(maturities[2], WeiPerEther.mul(100), 1000, 0);
    await swapnet.futureCash.connect(demoWallet).takeFutureCash(maturities[3], WeiPerEther.mul(50), 1000, WeiPerEther.mul(50));
    log(`Adding some trades to ${demoWallet.address}`);

    await mineBlocks(provider as Web3Provider, 40);
    let snapshot = await provider.send("evm_snapshot", []);
    log(`Created EVM snapshot at ${snapshot}`);
}

// Deposits balances into the wallet
async function setupWallet(swapnet: SwapnetLite, wallet: Wallet) {
    await swapnet.dai.transfer(wallet.address, WeiPerEther.mul(100_000));
    await swapnet.dai.connect(wallet).approve(swapnet.futureCash.address, WeiPerEther.mul(100_000_000));
    await swapnet.futureCash.connect(wallet).depositDai(WeiPerEther.mul(100_000));
    await swapnet.futureCash.connect(wallet).depositEth({value: WeiPerEther.mul(1_000)});
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
