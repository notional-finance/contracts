import {config} from "dotenv";
import path from 'path';
import Debug from "debug";
import { NotionalDeployer } from './NotionalDeployer';
import { Contract, ethers, Wallet } from 'ethers';
import ERC20Artifact from "../build/IERC20.json";
import CashMarketArtifact from "../build/CashMarket.json"
import WETHArtifact from "../build/IWETH.json";
import { JsonRpcProvider } from 'ethers/providers';
import { CashMarket } from '../typechain/CashMarket';
import { Ierc20 as Erc20 } from '../typechain/Ierc20';
import { BigNumber, parseEther } from 'ethers/utils';
import defaultAccounts from "../test/defaultAccounts.json";
import { Iweth } from '../typechain/Iweth';
import { MaxUint256 } from 'ethers/constants';
import { exit } from 'process';


const log = Debug("deploy:liquidity");
const envPath = `${process.env.DOTENV_CONFIG_PATH}`
log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
config({path: envPath});

const BLOCK_TIME_LIMIT = 2_000_000_000;

async function main() {
  if (process.env.DEPLOY_CHAIN_ID as string != "1337") {
    log(`Not running on local environment, using ${process.env.DEPLOY_CHAIN_ID as string} exiting`);
    exit(1);
  }

  const provider = new JsonRpcProvider(process.env.TESTNET_PROVIDER);
  const account = new Wallet(
    process.env.TESTNET_PRIVATE_KEY as string,
    provider
  );
  const notional = await NotionalDeployer.restoreFromFile(path.join(__dirname, "../" + process.env.CONTRACTS_FILE as string), account);
  const daiToken = new Contract(await notional.escrow.currencyIdToAddress(1), ERC20Artifact.abi, account) as Erc20;

  await txMined(daiToken.approve(notional.escrow.address, MaxUint256));
  await txMined(notional.escrow.deposit(daiToken.address, parseEther("6000000")));
  log("Adding $2M liquidity to 1M Dai market");
  await initializeLiquidity(1, notional, account, 0, parseEther("2000000"), parseEther("1800000"));
  log("Adding $2M liquidity to 3M Dai market");
  await initializeLiquidity(2, notional, account, 0, parseEther("2000000"), parseEther("2000000"));
  log("Adding $2M liquidity to 6M Dai market");
  await initializeLiquidity(2, notional, account, 1, parseEther("2000000"), parseEther("2200000"));

  const chainId = process.env.DEPLOY_CHAIN_ID as string;
  if (chainId == "1337") {
    log("Adding ETH into WETH for Wallet 2");
    const testAccount = new Wallet(defaultAccounts[1].secretKey, provider);
    const wethAddress = await notional.escrow.WETH();
    const wethToken = new Contract(wethAddress, WETHArtifact.abi, testAccount) as Iweth;
    await txMined(wethToken.connect(testAccount).deposit({value: parseEther("5000")}));
  }
}

async function initializeLiquidity(cashGroup: number, notional: NotionalDeployer, account: Wallet, offset: number, cash: BigNumber, fCash: BigNumber) {
  const fg = await notional.portfolios.getCashGroup(cashGroup);
  const futureCash = new Contract(fg.cashMarket, CashMarketArtifact.abi, account) as CashMarket;
  const maturities = await futureCash.getActiveMaturities();
  await txMined(futureCash.addLiquidity(maturities[offset], cash, fCash, 0, 100_000_000, BLOCK_TIME_LIMIT));
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