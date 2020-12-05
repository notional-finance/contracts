import {usePlugin, task} from "@nomiclabs/buidler/config";
import defaultAccounts from "./test/defaultAccounts.json";
import {readFileSync} from "fs";
import {ErrorCodes} from "./scripts/errorCodes";

usePlugin("@nomiclabs/buidler-ethers");
usePlugin("@nomiclabs/buidler-solpp");
usePlugin("@nomiclabs/buidler-waffle");
usePlugin("@nomiclabs/buidler-ganache");
usePlugin("@nomiclabs/buidler-solhint");
usePlugin("@nomiclabs/buidler-etherscan");
usePlugin('buidler-abi-exporter');
usePlugin("buidler-gas-reporter");
usePlugin("buidler-typechain");
usePlugin("solidity-coverage");

const CONTRACTS = [
    "CashMarket",
    "Escrow",
    "Portfolios",
    "ERC1155Token",
    "ERC1155Trade",
    "Liquidation",
    "RiskFramework"
];

task("codeSize", "Prints the code size of all contracts")
    .addOptionalParam("contract", "A particular contract to check")
    .setAction(async taskArgs => {
        if (!taskArgs.contract) {
            CONTRACTS.forEach(name => {
                const code = JSON.parse(readFileSync(`./build/${name}.json`, "utf8"));
                let bytes = (code.bytecode.length - 2) / 2;
                if (bytes > 22000) {
                    console.log(`${name}: ${bytes} bytes 🚨`);
                } else {
                    console.log(`${name}: ${bytes} bytes 👍`);
                }
            });
        }
    });

module.exports = {
    solc: {
        version: "0.6.4",
        optimizer: {
            enabled: true,
            runs: 200
        }
    },
    mocha: {
        timeout: 50000
    },
    paths: {
        artifacts: "./build"
    },
    networks: {
        buidlerevm: {
            accounts: defaultAccounts.map(acc => ({
                balance: acc.balance,
                privateKey: acc.secretKey
            }))
        },
        localGanache: {
            url: "http://localhost:8545",
            accounts: ["0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d"]
        },
        coverage: {
            url: "http://127.0.0.1:8555" // Coverage launches its own ganache-cli client
        },
        mainnet: {
            url: process.env.TESTNET_PROVIDER || ''
        },
        kovan: {
            url: process.env.TESTNET_PROVIDER || ''
        }
    },
    etherscan: {
        // The url for the Etherscan API you want to use.
        url: process.env.ETHERSCAN_URL,
        // Your API key for Etherscan
        // Obtain one at https://etherscan.io/
        apiKey: process.env.ETHERSCAN_API_KEY
    },
    typechain: {
        outDir: "typechain",
        target: "ethers-v4"
    },
    gasReporter: {
        enabled: process.env.REPORT_GAS ? true : false,
        outputFile: "gas-report.txt",
        noColors: true
    },
    solpp: {
        defs: ErrorCodes
    },
    abiExporter: {
        only: ['Escrow', 'Portfolios', 'ERC1155Token', 'ERC1155Trade', 'CashMarket', 'Directory', 'IERC20', 'IAggregator']
    }
};
