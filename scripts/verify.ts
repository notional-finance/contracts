import {config} from "dotenv";
import Debug from "debug";
import { NotionalDeployer } from './NotionalDeployer';
import { Wallet } from 'ethers';
import { RetryProvider } from './RetryProvider';
import * as child_process from 'child_process';

const log = Debug("notional:verify");

async function verify(addresses: (string | undefined)[], network: string) {
  for (const address of addresses) {
    if (address) {
      log(`verifying ${address} on ${network}`)
      const status = child_process.execSync(`npx buidler --network ${network} verify ${address}`)
      log(status.toString())
    }
  }
}

async function main() {
  // Verify deployed contracts and their logic implementations
  const envPath = `${process.env.DOTENV_CONFIG_PATH}`
  log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
  config({path: envPath});

  const chainId = process.env.DEPLOY_CHAIN_ID as string;
  log(`Verifying on ${chainId} using ${process.env.TESTNET_PROVIDER}`);
  const owner = new Wallet(
      process.env.TESTNET_PRIVATE_KEY as string,
      new RetryProvider(3, process.env.TESTNET_PROVIDER) // Retry provider for alchemy API
  );

  const notional = await NotionalDeployer.restoreFromFile(process.env.CONTRACTS_FILE as string, owner);
  const verifyAddresses: string[] = []
  verifyAddresses.push(notional.portfolios.address)
  verifyAddresses.push(notional.escrow.address)
  verifyAddresses.push(notional.erc1155.address)
  verifyAddresses.push(notional.erc1155trade.address)
  verifyAddresses.push(notional.cashMarketLogicAddress)
  verifyAddresses.push(notional.libraries.get('RiskFramework')!.address)
  verifyAddresses.push(notional.libraries.get('Liquidation')!.address)
  verifyAddresses.push(await notional.proxyAdmin.getProxyImplementation(notional.escrow.address))
  verifyAddresses.push(await notional.proxyAdmin.getProxyImplementation(notional.portfolios.address))
  verifyAddresses.push(await notional.proxyAdmin.getProxyImplementation(notional.erc1155.address))
  verifyAddresses.push(await notional.proxyAdmin.getProxyImplementation(notional.erc1155trade.address))

  const network = await notional.owner.provider.getNetwork()
  await verify(verifyAddresses, network.name)
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
