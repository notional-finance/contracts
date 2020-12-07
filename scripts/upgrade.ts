import {CoreContracts, NotionalDeployer} from "./NotionalDeployer";
import {config} from "dotenv";
import Debug from "debug";
import { Wallet } from "ethers";
import path from 'path';
import { RetryProvider } from './RetryProvider';
import { AddressZero } from 'ethers/constants';
import * as child_process from 'child_process';

const log = Debug("notional:upgrade");

async function main() {
    const envPath = `${process.env.DOTENV_CONFIG_PATH}`
    log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
    config({path: envPath});

    const chainId = process.env.DEPLOY_CHAIN_ID as string;
    log(`Upgrading on ${chainId} using ${process.env.TESTNET_PROVIDER}`);
    const owner = new Wallet(
        process.env.TESTNET_PRIVATE_KEY as string,
        new RetryProvider(3, process.env.TESTNET_PROVIDER) // Retry provider for alchemy API
    );

    const status = child_process
        .execSync('git status -s')
        .toString().trim()

    if (status.length > 0) {
        log("Do not upgrade with a dirty head! Commit your changes")
        process.exit(1)
    }

    let contracts = process.argv[2].split(',')

    let dryRun = true;
    if (process.argv[3] == "--yes-i-am-sure") {
        log(`You have confirmed you are sure you want to deploy`);
        dryRun = false;
    } else {
        log(`In dry run mode, use --yes-i-am-sure to confirm deployment`)
    }

    const notional = await NotionalDeployer.restoreFromFile(process.env.CONTRACTS_FILE as string, owner);
    const deployedAddresses = []

    // NOTE: because bytecode contains metadata hashes even whitespace change can result in bytecode changes.
    // see: https://solidity.readthedocs.io/en/v0.6.4/metadata.html
    if (contracts.includes("Liquidation")) {
        log(`Attempting to upgrade Liquidation Library on chain: ${chainId}`);
        deployedAddresses.push(await notional.deployLibrary("Liquidation", dryRun));
    }

    if (contracts.includes("RiskFramework")) {
        log(`Attempting to upgrade Risk Framework on chain: ${chainId}`);
        deployedAddresses.push(await notional.deployLibrary("RiskFramework", dryRun));
    }

    if (contracts.includes("Escrow")) {
        log(`Attempting to upgrade Escrow contract on chain: ${chainId}`);
        deployedAddresses.push(await notional.upgradeContract(CoreContracts.Escrow, dryRun));
    }

    if (contracts.includes("ERC1155Token")) {
        log(`Attempting to upgrade ERC1155 Token contract on chain: ${chainId}`);
        deployedAddresses.push(await notional.upgradeContract(CoreContracts.ERC1155Token, dryRun));
    }

    if (contracts.includes("ERC1155Trade")) {
        log(`Attempting to upgrade ERC1155 Trade contract on chain: ${chainId}`);
        deployedAddresses.push(await notional.upgradeContract(CoreContracts.ERC1155Trade, dryRun));
    }

    if (contracts.includes("Portfolios")) {
        log(`Attempting to upgrade Portfolios contract on chain: ${chainId}`);
        deployedAddresses.push(await notional.upgradeContract(CoreContracts.Portfolios, dryRun));
    }

    if (contracts.includes("CashMarket")) {
        const maxCashGroupId = await notional.portfolios.currentCashGroupId();
        for (let i = 1; i <= maxCashGroupId; i++) {
            const group = await notional.portfolios.getCashGroup(i);
            if (group.cashMarket == AddressZero) continue;
            log(`Attempting to upgrade cash group ${i} at address ${group.cashMarket}`)
            deployedAddresses.push(await notional.upgradeCashMarket(group.cashMarket, dryRun));
        }
    }

    log(`Completed at block height ${await owner.provider.getBlockNumber()}`);
    if (!dryRun) {
        const outputFile = path.join(__dirname, "../" + process.env.CONTRACTS_FILE as string);
        await notional.saveAddresses(outputFile);
        const network = await notional.owner.provider.getNetwork()
        await verify(deployedAddresses, network.name)
    }
}

async function verify(addresses: (string | undefined)[], network: string) {
  for (const address of addresses) {
    if (address) {
      log(`verifying ${address} on ${network}`)
      const status = child_process.execSync(`npx buidler --network ${network} verify ${address}`)
      log(status.toString())
    }
  }
}


main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
