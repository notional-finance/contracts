import {Wallet, Contract} from "ethers";
import {JsonRpcProvider} from "ethers/providers";
import {SwapnetDeployer} from "./SwapnetDeployer";
import { WeiPerEther } from 'ethers/constants';
import { BigNumber } from 'ethers/utils';
import {config} from "dotenv";
import Debug from "debug";

import ERC1820RegistryArtifact from "../mocks/ERC1820Registry.json";
import UniswapFactoryArtifact from "../mocks/UniswapFactory.json";
import { UniswapFactoryInterface } from '../typechain/UniswapFactoryInterface';
import { IERC1820Registry } from '../typechain/IERC1820Registry';

const log = Debug("swapnet:deploy");
const envPath = `${process.env.DOTENV_CONFIG_PATH}`
log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
config({path: envPath});

async function main() {
    const chainId = process.env.DEPLOY_CHAIN_ID as string;
    let prereqs;
    let owner: Wallet;

    switch (chainId) {
        case "1337":
            // This is the local ganache deployment
            log("Deploying to local ganache")
            owner = new Wallet(
                process.env.TESTNET_PRIVATE_KEY as string,
                new JsonRpcProvider(process.env.TESTNET_PROVIDER)
            );
            prereqs = await SwapnetDeployer.deployPrerequisites(owner);
            break;
        // Ropsten (PoW)
        case "3":
        // Rinkeby (PoA Geth)
        case "4":
        // Kovan (PoA Parity)
        case "42":
            log(`Deploying to remote testnet using ${process.env.TESTNET_PROVIDER}`);
            owner = new Wallet(
                process.env.TESTNET_PRIVATE_KEY as string,
                new JsonRpcProvider(process.env.TESTNET_PROVIDER)
            );
            prereqs = {
                registry: new Contract(
                    process.env.ERC1820_REGISTRY_ADDRESS as string,
                    ERC1820RegistryArtifact.abi,
                    owner
                ) as IERC1820Registry,
                uniswapFactory: new Contract(
                    process.env.UNISWAP_FACTORY_ADDRESS as string,
                    UniswapFactoryArtifact.abi,
                    owner
                ) as UniswapFactoryInterface
            }
            // TODO: this should upgrade the existing contracts rather than deploy new ones
            break;
        case "1":
        default:
            // Mainnet (UNIMPLEMENTED)
            log("Unknown chain id, quitting");
            process.exit(1);
    }
    const swapnet = await SwapnetDeployer.deploy(owner, prereqs.registry.address);

    // Deploy mock currencies and markets, don't do this if it is mainnet
    let currencyId = process.env.CURRENCY_ID !== undefined ? parseInt(process.env.CURRENCY_ID) : 0;
    if (process.env.DEPLOY_MOCK === "true") {
        let obj = await swapnet.deployMockCurrency(
            prereqs.uniswapFactory,
            WeiPerEther.div(100),               // ETH/MOCK exchange rate
            WeiPerEther.div(100).mul(30),       // Haircut
            true
        );
        currencyId = obj.currencyId;
    }

    const numPeriods = process.env.NUM_PERIODS !== undefined ? parseInt(process.env.NUM_PERIODS) : 4;
    const periodSize = process.env.PERIOD_SIZE !== undefined ? parseInt(process.env.PERIOD_SIZE) : 40;
    const maxTradeSize = WeiPerEther.mul(
        process.env.MAX_TRADE_SIZE !== undefined ? parseInt(process.env.MAX_TRADE_SIZE) : 10_000
    );
    const liquidityFee = new BigNumber(
        process.env.LIQUIDITY_FEE !== undefined ? parseInt(process.env.LIQUIDITY_FEE) : 0
    );
    const transactionFee = new BigNumber(
        process.env.TRANSACTION_FEE !== undefined ? parseInt(process.env.TRANSACTION_FEE) : 0
    );
    await swapnet.deployFutureCashMarket(
        currencyId,
        numPeriods,
        periodSize,
        maxTradeSize,
        liquidityFee,
        transactionFee
    )

    await swapnet.saveAddresses(process.env.CONTRACTS_FILE as string);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
