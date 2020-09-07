import {config} from "dotenv";
import path from 'path';
import Debug from "debug";
import { SwapnetDeployer } from './SwapnetDeployer';
import { Contract, ethers, Wallet } from 'ethers';
import ERC20Artifact from "../build/ERC20.json";
import FutureCashArtifact from "../build/FutureCash.json"
import WETHArtifact from "../build/IWETH.json";
import { JsonRpcProvider } from 'ethers/providers';
import { FutureCash } from '../typechain/FutureCash';
import { Erc20 } from '../typechain/Erc20';
import { parseEther } from 'ethers/utils';
import defaultAccounts from "../test/defaultAccounts.json";
import { Iweth } from '../typechain/Iweth';


const log = Debug("deploy:setupLocal");
const envPath = `${process.env.DOTENV_CONFIG_PATH}`
log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
config({path: envPath});

const BLOCK_TIME_LIMIT = 2_000_000_000;

async function main() {
  const provider = new JsonRpcProvider(process.env.TESTNET_PROVIDER);
  const account = new Wallet(
    process.env.TESTNET_PRIVATE_KEY as string,
    provider
  );
  const swapnet = await SwapnetDeployer.restoreFromFile(path.join(__dirname, "../local.json"), account);
  const daiToken = new Contract(await swapnet.escrow.currencyIdToAddress(1), ERC20Artifact.abi, account) as Erc20;

  await daiToken.approve(swapnet.escrow.address, parseEther("10000000"));
  await swapnet.escrow.deposit(daiToken.address, parseEther("6000000"));
  log("Adding $2M liquidity to 1M Dai market");
  await initializeLiquidity(1, swapnet, account, 0);
  log("Adding $2M liquidity to 3M Dai market");
  await initializeLiquidity(2, swapnet, account, 0);
  log("Adding $2M liquidity to 6M Dai market");
  await initializeLiquidity(2, swapnet, account, 1);

  log("Adding ETH into WETH for Wallet 2");
  const testAccount = new Wallet(defaultAccounts[1].secretKey, provider);
  const wethAddress = await swapnet.escrow.WETH();
  const wethToken = new Contract(wethAddress, WETHArtifact.abi, testAccount) as Iweth;
  await wethToken.connect(testAccount).deposit({value: parseEther("5000")});
}

async function initializeLiquidity(futureCashGroup: number, swapnet: SwapnetDeployer, account: Wallet, offset: number) {
  const fg = await swapnet.portfolios.getFutureCashGroup(futureCashGroup);
  const futureCash = new Contract(fg.futureCashMarket, FutureCashArtifact.abi, account) as FutureCash;
  const maturities = await futureCash.getActiveMaturities();
  await txMined(futureCash.addLiquidity(maturities[offset], parseEther("2000000"), parseEther("2000000"), 0, 100_000_000, BLOCK_TIME_LIMIT));
}

async function txMined(tx: Promise<ethers.ContractTransaction>) {
  return await (await tx).wait();
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });