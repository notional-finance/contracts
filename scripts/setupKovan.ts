import { Wallet, Contract, ethers } from "ethers";
import ERC20Artifact from "../build/ERC20.json";
import FutureCashArtifact from "../build/FutureCash.json";
import { JsonRpcProvider } from 'ethers/providers';
import { ERC20 } from '../typechain/ERC20';
import { FutureCash } from '../typechain/FutureCash';
import { WeiPerEther, AddressZero } from 'ethers/constants';
import {config} from "dotenv";
import Debug from "debug";
import { SwapnetDeployer } from './SwapnetDeployer';
import { parseEther } from 'ethers/utils';
import path from 'path';

const log = Debug("subgraph:setupKovan");
const envPath = `${process.env.DOTENV_CONFIG_PATH}`
log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
config({path: envPath});

async function main() {
  const account = new Wallet(
    process.env.TESTNET_PRIVATE_KEY as string,
    new JsonRpcProvider(process.env.TESTNET_PROVIDER)
  );

  const swapnet = await SwapnetDeployer.restoreFromFile(path.join(__dirname, "../kovan.json"), account);
  const testToken = new Contract(await swapnet.escrow.currencyIdToAddress(1), ERC20Artifact.abi, account) as ERC20;
  const ig = await swapnet.portfolios.getInstrumentGroup(1);
  const futureCash = new Contract(ig.futureCashMarket, FutureCashArtifact.abi, account) as FutureCash;
  log("Setup contracts");

  log("Mint test tokens");
  await txMined(testToken.mint());
  log("Approve escrow for deposits");
  await txMined(testToken.approve(swapnet.escrow.address, WeiPerEther.mul(100)));
  log("Deposit test tokens");
  await txMined(swapnet.escrow.deposit(testToken.address, WeiPerEther.mul(100)));
  log("Deposit 0.25 ETH as collateral");
  await txMined(swapnet.escrow.depositEth({ value: parseEther("0.25") }));

  log(`ETH Balances in Escrow: ${await swapnet.escrow.currencyBalances(AddressZero, account.address)}`);
  log(`Test Token Balances in Escrow: ${await swapnet.escrow.currencyBalances(testToken.address, account.address)}`);

  log("Returns the maturity that is currently active (there is only 1 on this contract)");
  const maturity = (await futureCash.getActiveMaturities())[0];
  let blockNum = await account.provider.getBlockNumber();
  log("Provide Liquidity (needs to be done first or trades will not work)");
  await txMined(futureCash.addLiquidity(
    maturity,
    WeiPerEther.mul(100),
    WeiPerEther.mul(100),
    blockNum + 1000
  ));

  log("This portfolio will have 100 liquidity tokens and 100 cash payer");
  let portfolio = await swapnet.portfolios.getTrades(account.address);
  log("Current Portfolio:")
  log(portfolio);

  log("Test token balance is now empty (currently providing liquidity)");
  log(`Test Token Balances in Escrow: ${await swapnet.escrow.currencyBalances(testToken.address, account.address)}`);

  const market = await futureCash.markets(maturity);
  log("Future Cash Market Data:");
  log(market);

  log("Borrow Tokens (collateralized by ETH)");
  blockNum = await account.provider.getBlockNumber();
  log("We will borrow at the market rate with an obligation to pay 5 tokens at maturity.");
  await txMined(futureCash.takeCollateral(
    maturity,
    WeiPerEther.mul(5),
    blockNum + 1000,
    100_000_000
  ));
  log("Borrowed tokens are deposited into escrow");
  log(`Test Token Balances in Escrow: ${await swapnet.escrow.currencyBalances(testToken.address, account.address)}`);
  log("Withdraw all of the test tokens");
  await txMined(swapnet.escrow.withdraw(testToken.address, await swapnet.escrow.currencyBalances(testToken.address, account.address)));
  log("Test token balance is now empty");
  log(`Test Token Balances in Escrow: ${await swapnet.escrow.currencyBalances(testToken.address, account.address)}`);

  log("This portfolio will have 100 liquidity tokens and 105 cash payer");
  portfolio = await swapnet.portfolios.getTrades(account.address);
  log("Current Portfolio:")
  log(portfolio);

  log("Lend Test Tokens");
  log(`Test Token Balances in Escrow: ${await swapnet.escrow.currencyBalances(testToken.address, account.address)}`);

  log("Will Mint 100e18 test tokens back to msg.sender");
  await txMined(testToken.mint());
  log("Approve escrow for deposits");
  await txMined(testToken.approve(swapnet.escrow.address, WeiPerEther.mul(100)));
  log("Deposit test tokens");
  await txMined(swapnet.escrow.deposit(testToken.address, WeiPerEther.mul(100)));

  blockNum = await account.provider.getBlockNumber();
  await txMined(futureCash.takeFutureCash(maturity, WeiPerEther.mul(5), blockNum + 100, 0));

  log("Token balances have been reduced and we have net out our cash payer exposure (but not totally)");
  portfolio = await swapnet.portfolios.getTrades(account.address);
  log("Current Portfolio:")
  log(portfolio);

  log(`Test Token Balances in Escrow: ${await swapnet.escrow.currencyBalances(testToken.address, account.address)}`);
  blockNum = await account.provider.getBlockNumber();
  await txMined(futureCash.removeLiquidity(maturity, WeiPerEther.mul(5), blockNum + 100));





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