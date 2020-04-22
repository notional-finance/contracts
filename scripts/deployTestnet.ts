import {Wallet, ContractFactory, constants, utils} from "ethers";
import {JsonRpcProvider} from "ethers/providers";
import {SwapnetLite} from "./SwapnetLite";
import {config} from "dotenv";
import Debug from "debug";

import FutureCashArtifact from "../build/FutureCash.json";
import {FutureCash} from "../typechain/FutureCash";

const log = Debug("swapnet-testnet");
config();

async function main() {
    const account = process.env.RINKEBY_ACCOUNT as string;
    const url = process.env.RINKEBY_HOSTNAME as string;
    const periodSize = parseInt(process.env.PERIOD_SIZE as string);
    const uniswapFactoryAddress = process.env.UNISWAP_FACTORY as string;

    let provider = new JsonRpcProvider(url);
    let owner = new Wallet(account, provider);
    let swapnet = SwapnetLite.restoreFromFile("rinkeby.json", provider);
    let deployFutureCash = true;

    if (deployFutureCash) {
        const factory = new ContractFactory(FutureCashArtifact.abi, FutureCashArtifact.bytecode, owner);
        let contract = (await factory.deploy(periodSize, swapnet.dai.address, swapnet.uniswap.address)) as FutureCash;
        await contract.deployed();
        swapnet.futureCash = contract;
        swapnet.saveAddresses("rinkeby.json");

        // Setup Future Cash
        let rateAnchor = 1_050_000_000;
        await swapnet.futureCash.setRateFactors(rateAnchor, 100);
        await swapnet.futureCash.setCollateralCaps(
            constants.WeiPerEther.mul(10_000),
            constants.WeiPerEther.mul(10_000_000)
        );
        await swapnet.futureCash.setHaircutSize(constants.WeiPerEther.div(100).mul(70),
            constants.WeiPerEther.add(constants.WeiPerEther.div(100).mul(2)));
        await swapnet.futureCash.setNumPeriods(4);
        await swapnet.futureCash.setFee(constants.WeiPerEther.div(100).mul(3));
        log("Setup swapnet future cash configuration");
    }

    // Ensure that there is a token price set for DAI/ETH
    try {
        let value = await swapnet.uniswap.getEthToTokenInputPrice(constants.WeiPerEther);
        log(`DAI/ETH Price: ${utils.formatEther(value)}`);
    } catch {
        let allowance = await swapnet.dai.allowance(owner.address, swapnet.uniswap.address);
        if (allowance.eq(0)) {
            await swapnet.dai.approve(swapnet.uniswap.address, constants.WeiPerEther.mul(100_000_000));
        }

        const current_block = await swapnet.provider.getBlock(await swapnet.provider.getBlockNumber());
        log(`Current Time: ${new Date().getTime()}, Block Time: ${current_block.timestamp}`);
        await swapnet.uniswap.addLiquidity(
            constants.WeiPerEther.mul(1),
            constants.WeiPerEther.mul(100),
            current_block.timestamp + 10000,
            {value: constants.WeiPerEther.mul(1), gasLimit: 500000}
        );
    }
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
