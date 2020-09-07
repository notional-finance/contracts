import { Wallet } from "ethers";
import { JsonRpcProvider } from "ethers/providers";
import { SwapnetDeployer } from "./SwapnetDeployer";
import { BigNumber, parseEther } from "ethers/utils";
import { config } from "dotenv";
import Debug from "debug";

const log = Debug("swapnet:deploy");
const envPath = `${process.env.DOTENV_CONFIG_PATH}`;
const ONE_MONTH = 2592000;
const BASIS_POINT = 1e5;
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
        parseEther("1.06"),
        parseEther("1.02"),
        parseEther("0.80"),
        parseEther("1.01"),
    );

    // Deploy mock currencies and markets, don't do this if it is mainnet
    let currencyId = process.env.CURRENCY_ID !== undefined ? parseInt(process.env.CURRENCY_ID) : 0;
    if (process.env.DEPLOY_MOCK === "true") {
        let obj = await swapnet.deployMockCurrency(
            parseEther("0.01"), // ETH/MOCK exchange rate
            parseEther("1.40")  // Haircut
        );
        currencyId = obj.currencyId;
    }

    await swapnet.deployFutureCashMarket(
        currencyId,
        1,
        ONE_MONTH,
        parseEther("1000"),
        new BigNumber(2.5 * BASIS_POINT),
        new BigNumber(0),
        1e9,
        1_100_000_000,
        85
    );

    await swapnet.deployFutureCashMarket(
        currencyId,
        2,
        ONE_MONTH * 3 + 3600,
        parseEther("1000"),
        new BigNumber(2.5 * BASIS_POINT * 3),
        new BigNumber(0),
        1e9,
        1_100_000_000,
        85
    );

    await swapnet.saveAddresses(process.env.CONTRACTS_FILE as string);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
