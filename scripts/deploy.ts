import { Wallet } from "ethers";
import { JsonRpcProvider } from "ethers/providers";
import { NotionalDeployer, Environment } from "./NotionalDeployer";
import { BigNumber, parseEther } from "ethers/utils";
import { config } from "dotenv";
import { WeiPerEther } from 'ethers/constants';
import Debug from "debug";
import { deployLocal, deployTestEnvironment } from './deployEnvironment';
import path from 'path';

const log = Debug("notional:deploy");
const ONE_MONTH = 2592000;
const BASIS_POINT = 1e5;

async function main() {
    const envPath = `${process.env.DOTENV_CONFIG_PATH}`;
    log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
    config({ path: envPath });

    const chainId = process.env.DEPLOY_CHAIN_ID as string;
    let environment: Environment;
    let deployWallet: Wallet;
    let confirmations: number;

    switch (chainId) {
        // Local Ganache
        case "1337":
            deployWallet = new Wallet(
                process.env.TESTNET_PRIVATE_KEY as string,
                new JsonRpcProvider(process.env.TESTNET_PROVIDER)
            );
            console.log(deployWallet.address);
            environment = await deployLocal(deployWallet);
            confirmations = 1;
            break;
        case "42":
            confirmations = 3;
            deployWallet = new Wallet(
                process.env.TESTNET_PRIVATE_KEY as string,
                new JsonRpcProvider(process.env.TESTNET_PROVIDER)
            );
            environment = await deployTestEnvironment(
                deployWallet,
                process.env.WETH_ADDRESS as string,
                process.env.ERC1820_REGISTRY_ADDRESS as string,
                confirmations
            );
            break;
        default:
            log(`Unknown chain id: ${chainId}, quitting`);
            process.exit(1);
    }

    const notional = await NotionalDeployer.deploy(
        environment.deploymentWallet,
        environment,
        new BigNumber(8),
        parseEther("1.30"), // TODO: what do we set this as?
        parseEther("1.06"),
        parseEther("1.02"),
        parseEther("0.80"),
        parseEther("1.01"),
        confirmations
    );

    // List DAI currency
    const currencyId = await notional.listCurrency(
        environment.DAI.address,
        environment.DAIETHOracle,
        parseEther("1.4"),
        false,
        false,
        WeiPerEther, // TODO: check this
        false 
    )

    await notional.deployCashMarket(
        currencyId,
        1,
        ONE_MONTH,
        parseEther("1000"),
        new BigNumber(2.5 * BASIS_POINT),
        new BigNumber(0),
        1_100_000_000,
        85
    );

    await notional.deployCashMarket(
        currencyId,
        2,
        ONE_MONTH * 3,
        parseEther("1000"),
        new BigNumber(2.5 * BASIS_POINT * 3),
        new BigNumber(0),
        1_100_000_000,
        85
    );

    const outputFile = path.join(__dirname, "../" + process.env.CONTRACTS_FILE as string);
    await notional.saveAddresses(outputFile);
    await notional.transferOwner(process.env.TRANSFER_OWNER_PUBLIC_KEY as string);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
