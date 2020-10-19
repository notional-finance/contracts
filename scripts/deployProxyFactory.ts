import { config } from "dotenv";
import { Wallet } from 'ethers';
import Debug from "debug";
import { JsonRpcProvider } from 'ethers/providers';
import { deployProxyFactory } from "./deployEnvironment";

const log = Debug("notional:deploy");

async function main() {
  const envPath = `${process.env.DOTENV_CONFIG_PATH}`;
  log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
  config({ path: envPath })

  const deployWallet = new Wallet(
      process.env.TESTNET_PRIVATE_KEY as string,
      new JsonRpcProvider(process.env.TESTNET_PROVIDER)
  )
  const factory = await deployProxyFactory(deployWallet, 3);
  console.log(factory.address);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });