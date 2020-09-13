import {config} from "dotenv";
import path from 'path';
import Debug from "debug";
import { NotionalDeployer } from '../scripts/NotionalDeployer';
import { Contract, ethers, Wallet } from 'ethers';
import ERC20Artifact from "../build/ERC20.json";
import CashMarketArtifact from "../build/CashMarket.json"
import { JsonRpcProvider } from 'ethers/providers';
import { CashMarket } from '../typechain/CashMarket';
import { Erc20 } from '../typechain/Erc20';
import { parseEther, BigNumber } from 'ethers/utils';
import { writeFileSync } from 'fs';

const log = Debug("gas");
const envPath = `${process.env.DOTENV_CONFIG_PATH}`
log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
config({path: envPath});

const BLOCK_TIME_LIMIT = 2_000_000_000;

async function main() {
  const account = new Wallet(
    process.env.TESTNET_PRIVATE_KEY as string,
    new JsonRpcProvider(process.env.TESTNET_PROVIDER)
  );
  const notional = await NotionalDeployer.restoreFromFile(path.join(__dirname, "../local.json"), account);
  const daiToken = new Contract(await notional.escrow.currencyIdToAddress(1), ERC20Artifact.abi, account) as Erc20;

  await daiToken.approve(notional.escrow.address, parseEther("10000000"));
  await notional.escrow.deposit(daiToken.address, parseEther("6000000"));
  log("Adding $2M liquidity to 1M Dai market");
  await initializeLiquidity(1, notional, account);
  // log("Adding $2M liquidity to 3M Dai market");
  // await initializeLiquidity(2, notional, account);
  // log("Adding $2M liquidity to 6M Dai market");
  // await initializeLiquidity(3, notional, account);
}

async function initializeLiquidity(cashGroup: number, notional: NotionalDeployer, account: Wallet) {
  const fg = await notional.portfolios.getCashGroup(cashGroup);
  const futureCash = new Contract(fg.cashMarket, CashMarketArtifact.abi, account) as CashMarket;
  const maturities = await futureCash.getActiveMaturities();
  const txn = await txMined(futureCash.addLiquidity(maturities[0], parseEther("2000000"), parseEther("2000000"), 0, 100_000_000, BLOCK_TIME_LIMIT));
  log(`Transaction mined: ${txn.transactionHash}`);
  
  const trace = await (notional.provider as JsonRpcProvider).send("debug_traceTransaction", [txn.transactionHash, {}]);
  await logTrace(trace);
}

async function logTrace(trace: any) {
  log(`${trace.gas}`)
  log(`${trace.structLogs.length}`)

  let output = "depth\tgasCost\top\tpc\tmemSize\tstorageSize\tstack\tmemory\tstorage\n";
  let prevMem = "";
  let prevStack = "";
  let prevStore = "";
  for (let line of trace.structLogs) {

    // Since using proxies, even numbered depth is in a proxy
    if (line.depth % 2 == 0) continue;

    let tmpMem = Array.from(line.memory).map((v) => (new BigNumber("0x" + (v as string))).toString()).toString();
    let tmpStack = Array.from(line.stack).map((v) => (new BigNumber("0x" + (v as string))).toString()).toString();
    let tmpStore = JSON.stringify(
      Object.keys(line.storage).reduce((obj, k:string) => {
        obj[k] = new BigNumber("0x" + line.storage[k] as string).toString();
        return obj;
      }, {} as {[name: string]: string})
    );


    let writeMem = tmpMem == prevMem ? "" : tmpMem;
    let writeStack = tmpStack == prevStack ? "" : tmpStack;
    let writeStore = tmpStore == prevStore ? "" : tmpStore;

    prevMem = tmpMem != prevMem ? writeMem : prevMem;
    prevStore = tmpStack != prevStack ? writeStack : prevStack;
    prevStore = tmpStore != prevStore ? writeStore : prevStore;

    output = output + [line.depth,line.gasCost,line.op,line.pc,line.memory.length,line.storage.length,writeStack,writeMem,writeStore].join('\t') + '\n';
  }

  writeFileSync("gaslog.csv", output);
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
