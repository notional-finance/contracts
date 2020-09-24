import {CoreContracts, NotionalDeployer} from "./NotionalDeployer";
import {config} from "dotenv";
import Debug from "debug";
import { Wallet } from "ethers";
import { JsonRpcProvider } from "ethers/providers";
import path from 'path';

const log = Debug("notional:upgrade");

async function main() {
    const envPath = `${process.env.DOTENV_CONFIG_PATH}`
    log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
    config({path: envPath});

    const chainId = process.env.DEPLOY_CHAIN_ID as string;
    log(`Upgrading on ${chainId} using ${process.env.TESTNET_PROVIDER}`);
    const owner = new Wallet(
        process.env.TESTNET_PRIVATE_KEY as string,
        new JsonRpcProvider(process.env.TESTNET_PROVIDER)
    );

    const status = require('child_process')
        .execSync('git status -s')
        .toString().trim()

    if (status.length > 0) {
        log("Do not upgrade with a dirty head! Commit your changes")
        process.exit(1)
    }

    let dryRun = true;
    if (process.argv[2] == "--yes-i-am-sure") {
        log(`You have confirmed you are sure you want to deploy`);
        dryRun = false;
    } else {
        log(`In dry run mode, use --yes-i-am-sure to confirm deployment`)
    }

    const notional = await NotionalDeployer.restoreFromFile(process.env.CONTRACTS_FILE as string, owner);

    // NOTE: because bytecode contains metadata hashes even whitespace change can result in bytecode changes.
    // see: https://solidity.readthedocs.io/en/v0.6.4/metadata.html
    const changedLibraries = await notional.checkDeployedLibraries();
    for (let l of changedLibraries) {
        await notional.deployLibrary(l, dryRun);
    }

    log(`Attempting to upgrade Escrow contract on chain: ${chainId}`);
    await notional.upgradeContract(CoreContracts.Escrow, dryRun);
    log(`Attempting to upgrade ERC1155 Token contract on chain: ${chainId}`);
    await notional.upgradeContract(CoreContracts.ERC1155Token, dryRun);
    log(`Attempting to upgrade ERC1155 Trade contract on chain: ${chainId}`);
    await notional.upgradeContract(CoreContracts.ERC1155Trade, dryRun);
    log(`Attempting to upgrade Portfolios contract on chain: ${chainId}`);
    await notional.upgradeContract(CoreContracts.Portfolios, dryRun);
    log(`Completed at block height ${await owner.provider.getBlockNumber()}`);

    // TODO: upgrading future cash contracts
    if (!dryRun) {
        const outputFile = path.join(__dirname, "../" + process.env.CONTRACTS_FILE as string);
        await notional.saveAddresses(outputFile);
    }
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
