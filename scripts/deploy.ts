import { Wallet } from "ethers";
import { JsonRpcProvider } from "ethers/providers";
import { SwapnetDeployer } from "./SwapnetDeployer";
import { WeiPerEther } from "ethers/constants";
import { BigNumber, parseEther } from "ethers/utils";
import { config } from "dotenv";
import Debug from "debug";

const log = Debug("swapnet:deploy");
const envPath = `${process.env.DOTENV_CONFIG_PATH}`;
log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
config({ path: envPath });

async function main() {
    const chainId = process.env.DEPLOY_CHAIN_ID as string;
    let prereqs;
    let owner: Wallet;

    switch (chainId) {
        // Local Ganache
        case "1337":
            // This is the local ganache deployment
            log("Deploying to local ganache");
            owner = new Wallet(
                process.env.TESTNET_PRIVATE_KEY as string,
                new JsonRpcProvider(process.env.TESTNET_PROVIDER)
            );
            prereqs = await SwapnetDeployer.deployPrerequisites(owner);
            break;
        case "1":
        default:
            // Mainnet (UNIMPLEMENTED)
            log("Unknown chain id, quitting");
            process.exit(1);
    }
    const swapnet = await SwapnetDeployer.deploy(
        owner,
        prereqs.registry.address,
        prereqs.weth.address,
        prereqs.uniswapRouter.address
    );

    // Deploy mock currencies and markets, don't do this if it is mainnet
    let currencyId = process.env.CURRENCY_ID !== undefined ? parseInt(process.env.CURRENCY_ID) : 0;
    if (process.env.DEPLOY_MOCK === "true") {
        let obj = await swapnet.deployMockCurrency(
            prereqs.uniswapFactory,
            prereqs.uniswapRouter,
            parseEther("0.01"), // ETH/MOCK exchange rate
            parseEther("1.30"), // Haircut
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
    );

    await swapnet.saveAddresses(process.env.CONTRACTS_FILE as string);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
