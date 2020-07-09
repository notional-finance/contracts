import {SwapnetDeployer} from "./SwapnetDeployer";
import {config} from "dotenv";
import Debug from "debug";
import { Wallet, Contract } from "ethers";
import { JsonRpcProvider } from "ethers/providers";
import { parseEther, BigNumber } from "ethers/utils";

import { IERC1820Registry } from "../typechain/IERC1820Registry";
import { UniswapFactoryInterface } from "../typechain/UniswapFactoryInterface";
import ERC1820RegistryArtifact from "../mocks/ERC1820Registry.json";
import UniswapFactoryArtifact from "../mocks/UniswapFactory.json";

const log = Debug("subgraph:deployKovan");
const envPath = `${process.env.DOTENV_CONFIG_PATH}`
log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
config({path: envPath});

async function main() {
    log(`Deploying to kovan testnet using ${process.env.TESTNET_PROVIDER}`);
    let owner = new Wallet(
        process.env.TESTNET_PRIVATE_KEY as string,
        new JsonRpcProvider(process.env.TESTNET_PROVIDER)
    );
    let prereqs = {
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

    // update portfolio haircut
    // set discounts
    const swapnet = await SwapnetDeployer.deploy(owner, prereqs.registry.address);
    // update max trades
    await (await swapnet.portfolios.setMaxAssets(20)).wait()
    // set reserve account
    await (await swapnet.escrow.setReserveAccount(process.env.RESERVE_ACCOUNT as string)).wait();
    await swapnet.saveAddresses(process.env.CONTRACTS_FILE as string);

    // DEPLOY MOCK CURRENCIES (2)
    // list new tradable currency
    // list new deposit currency
    // update exchange rate
    const tradable = await swapnet.deployMockCurrency(
      prereqs.uniswapFactory,
      parseEther("0.01"),
      parseEther("1.3"),
      true,
      parseEther("0.25")
    );
    await swapnet.deployMockCurrency(
      prereqs.uniswapFactory,
      parseEther("10"),
      parseEther("0.7"),
      false,
      parseEther("0.25")
    );

    // DEPLOY FUTURE CASH MARKET
    // new future cash group
    // update max trades
    // update fees
    // update rate factors
    await swapnet.deployFutureCashMarket(
      tradable.currencyId,
      1,
      21600,
      parseEther("100000"),
      new BigNumber(0),
      new BigNumber(0),
      1e9,
      1_000_300_000,
      100
    );

    // TODO
    // update future cash group
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
