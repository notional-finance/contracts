import {JsonRpcProvider, Provider} from "ethers/providers";
import {readFileSync, writeFileSync} from "fs";
import { BigNumber } from 'ethers/utils';
import { WeiPerEther, AddressZero } from 'ethers/constants';
import {Wallet, ContractFactory, Contract, ethers} from "ethers";

import ERC20Artifact from "../build/ERC20.json";
import DirectoryArtifact from "../build/Directory.json";
import EscrowArtifact from "../build/Escrow.json";
import PortfoliosArtifact from "../build/Portfolios.json";
import RiskFrameworkArtifact from "../build/RiskFramework.json";
import ERC1155TokenArtifact from "../build/ERC1155Token.json";

import ERC1820RegistryArtifact from "../mocks/ERC1820Registry.json";
import UniswapFactoryArtifact from "../mocks/UniswapFactory.json";
import UniswapExchangeArtifact from "../mocks/UniswapExchange.json";
import MockAggregatorArtifact from "../build/MockAggregator.json";
import ProxyAdminArtifact from "../build/ProxyAdmin.json";
import AdminUpgradeabilityProxyArtifact from "../build/AdminUpgradeabilityProxy.json";

import {Portfolios} from '../typechain/Portfolios';
import {Escrow} from '../typechain/Escrow';
import {ProxyAdmin} from '../typechain/ProxyAdmin';
import {Directory} from '../typechain/Directory';
import {RiskFramework} from '../typechain/RiskFramework';
import {IERC1820Registry} from "../typechain/IERC1820Registry";
import {MockAggregator} from '../typechain/MockAggregator';
import {UniswapExchangeInterface} from "../typechain/UniswapExchangeInterface";
import {UniswapFactoryInterface} from "../typechain/UniswapFactoryInterface";
import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";
import {ERC1155Token} from '../typechain/ERC1155Token';

import Debug from "debug";
import path from 'path';
const log = Debug("swapnet:deploy");

// This is a mirror of the enum in Governed
export const enum CoreContracts {
    Escrow = 0,
    RiskFramework,
    Portfolios,
    ERC1155Token
}

export class SwapnetDeployer {
    constructor(
        public owner: Wallet,
        public escrow: Escrow,
        public portfolios: Portfolios,
        public risk: RiskFramework,
        public provider: Provider,
        public proxyAdmin: ProxyAdmin,
        public directory: Directory,
        public erc1155: ERC1155Token,
        public startBlock: number
    ) {}

    public coreContractToContract = (contract: CoreContracts) => {
        switch(contract) {
            case CoreContracts.ERC1155Token:
                return this.erc1155;
            case CoreContracts.Escrow:
                return this.escrow;
            case CoreContracts.Portfolios:
                return this.portfolios;
            case CoreContracts.RiskFramework:
                return this.risk;
            default:
                throw new Error(`Unknown core contract ${contract}`);
        }
    }

    private static deployContract = async (owner: Wallet, artifact: any, args: any[]) => {
        let gasLimit;
        if (process.env.COVERAGE == "true") {
            gasLimit = 20_000_000;
        } else {
            gasLimit = 6_000_000;
        }
        const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
        const txn = factory.getDeployTransaction(...args);
        txn.gasLimit = gasLimit;
        log(`Deploying ${artifact.contractName}...`);
        const receipt = await (await owner.sendTransaction(txn)).wait();
        const contract = new Contract(receipt.contractAddress as string, artifact.abi, owner);
        log(`Successfully deployed ${artifact.contractName} at ${contract.address}...`);

        return contract;
    };

    private static deployProxyContract = async <T>(
        owner: Wallet,
        artifact: any,
        initializeSig: string,
        params: any[],
        proxyAdmin: ProxyAdmin
    ) => {
        const logic = (await SwapnetDeployer.deployContract(owner, artifact, []));

        const abi = new ethers.utils.Interface(artifact.abi);
        log(`Initializing ${artifact.contractName} with sig ${initializeSig} and params ${params}`);
        const data = abi.functions[`initialize(${initializeSig})`].encode(params);
        const proxy = await SwapnetDeployer.deployContract(
            owner,
            AdminUpgradeabilityProxyArtifact,
            [logic.address, proxyAdmin.address, data]
        );
        log(`Deployed proxy for ${artifact.contractName}`);

        return new ethers.Contract(proxy.address, artifact.abi, owner) as unknown as T;
    };

    public static deployPrerequisites = async (owner: Wallet) => {
        const uniswapTemplate = await SwapnetDeployer.deployContract(owner, UniswapExchangeArtifact, []);
        const uniswapFactory = (await SwapnetDeployer.deployContract(
            owner,
            UniswapFactoryArtifact,
            []
        )) as UniswapFactoryInterface;
        await uniswapFactory.initializeFactory(uniswapTemplate.address);

        const registry = await SwapnetDeployer.deployContract(owner, ERC1820RegistryArtifact, []) as IERC1820Registry;

        return { uniswapFactory, registry };
    }

    private static txMined = async (tx: Promise<ethers.ContractTransaction>) => {
        return await (await tx).wait();
    }

    private static loadArtifact = (contract: string): any => {
        let buildDir;
        if (process.env.COVERAGE == "true") {
            buildDir = path.join(__dirname, "../.coverage_artifacts");
        } else {
            buildDir = path.join(__dirname, "../build");
        }
        return JSON.parse(readFileSync(path.join(buildDir, `${contract}.json`), "utf8"));
    }

    public static deploy = async (
        owner: Wallet,
        registryAddress: string,
        liquidationDiscount = WeiPerEther,
        settlementDiscount = WeiPerEther,
        portfolioHaircut = WeiPerEther
    ) => {
        const startBlock = await owner.provider.getBlockNumber();
        const proxyAdmin = await SwapnetDeployer.deployContract(
            owner,
            SwapnetDeployer.loadArtifact("ProxyAdmin"),
            []
        ) as ProxyAdmin;

        const directory = await SwapnetDeployer.deployProxyContract<Directory>(
            owner,
            SwapnetDeployer.loadArtifact("Directory"),
            '',
            [],
            proxyAdmin
        );

        const escrow = await SwapnetDeployer.deployProxyContract<Escrow>(
            owner,
            SwapnetDeployer.loadArtifact("Escrow"),
            'address,address',
            [directory.address, registryAddress],
            proxyAdmin
        );

        const portfolios = await SwapnetDeployer.deployProxyContract<Portfolios>(
            owner,
            SwapnetDeployer.loadArtifact("Portfolios"),
            'address,uint256',
            [directory.address, 100],
            proxyAdmin
        );

        const risk = await SwapnetDeployer.deployProxyContract<RiskFramework>(
            owner,
            SwapnetDeployer.loadArtifact("RiskFramework"),
            'address',
            [directory.address],
            proxyAdmin
        );

        const erc1155 = await SwapnetDeployer.deployProxyContract<ERC1155Token>(
            owner,
            SwapnetDeployer.loadArtifact("ERC1155Token"),
            'address',
            [directory.address],
            proxyAdmin
        );

        // Set dependencies
        log("Setting Swapnet Contract: Escrow")
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.Escrow, escrow.address));
        log("Setting Swapnet Contract: Portfolios")
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.Portfolios, portfolios.address));
        log("Setting Swapnet Contract: RiskFramework")
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.RiskFramework, risk.address));
        log("Setting Swapnet Contract: ERC1155")
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.ERC1155Token, erc1155.address));
        log("Setting Swapnet Dependencies: Escrow Dependency")
        await SwapnetDeployer.txMined(directory.setDependencies(CoreContracts.Escrow, [CoreContracts.Portfolios]));
        log("Setting Swapnet Dependencies: RiskFramework Dependency")
        await SwapnetDeployer.txMined(directory.setDependencies(CoreContracts.RiskFramework, [CoreContracts.Portfolios]))
        log("Setting Swapnet Dependencies: ERC1155 Dependency")
        await SwapnetDeployer.txMined(directory.setDependencies(CoreContracts.ERC1155Token, [CoreContracts.Portfolios]));
        log("Setting Swapnet Dependencies: Portfolio Dependency")
        await SwapnetDeployer.txMined(directory.setDependencies(CoreContracts.Portfolios, [CoreContracts.Escrow, CoreContracts.RiskFramework, CoreContracts.ERC1155Token]));

        // Setup some contract defaults
        log("Setting liquidation discounts")
        await SwapnetDeployer.txMined(escrow.setDiscounts(liquidationDiscount, settlementDiscount));

        log("Setting collateral currencies")
        await SwapnetDeployer.txMined(risk.setHaircut(portfolioHaircut));

        return new SwapnetDeployer(owner, escrow, portfolios, risk, owner.provider, proxyAdmin, directory, erc1155, startBlock);
    };

    public deployMockCurrency = async (
        uniswapFactory: UniswapFactoryInterface,
        initialExchangeRate: BigNumber,
        haircut: BigNumber,
        isTradable: boolean,
        seedEthBalance = WeiPerEther
    ) => {
        // A mock currency has an ERC20 token, chainlink, and uniswap exchange.
        log("Deploying mock currency")
        const erc20 = (await SwapnetDeployer.deployContract(
            this.owner,
            ERC20Artifact,
            []
        )) as ERC20;

        log("Listing currency on Escrow")
        if (isTradable) {
            await SwapnetDeployer.txMined(this.escrow.listTradableCurrency(erc20.address));
        } else {
            await SwapnetDeployer.txMined(this.escrow.listDepositCurrency(erc20.address));
        }
        const currencyId = await this.escrow.addressToCurrencyId(erc20.address) as number;

        log("Registering new exchange rate")
        const {chainlink, uniswapExchange} = await this.deployExchangeRate(
            currencyId,
            0,
            initialExchangeRate,
            seedEthBalance,
            haircut,
            { erc20, uniswapFactory }
        );

        return {currencyId, erc20, chainlink, uniswapExchange}
    };

    public async deployExchangeRate(base: number, quote: number, initialExchangeRate: BigNumber,
        seedEthBalance: BigNumber, haircut: BigNumber, uniswap?: {erc20: ERC20, uniswapFactory: UniswapFactoryInterface}) {
        log("Deploying mock chainlink")
        const chainlink = (await SwapnetDeployer.deployContract(
            this.owner,
            MockAggregatorArtifact,
            [])
        ) as MockAggregator;
        await SwapnetDeployer.txMined(chainlink.setAnswer(initialExchangeRate));

        let uniswapExchange: any = { address: AddressZero };
        if (uniswap !== undefined) {
            log("Deploying mock uniswap")
            await SwapnetDeployer.txMined(
                uniswap.uniswapFactory.createExchange(uniswap.erc20.address, {gasLimit: 5_000_000})
            );
            uniswapExchange = new ethers.Contract(
                await uniswap.uniswapFactory.getExchange(uniswap.erc20.address),
                UniswapExchangeArtifact.abi,
                this.owner
            ) as UniswapExchangeInterface;

            const tokenBalance = seedEthBalance.mul(WeiPerEther).div(initialExchangeRate);
            await SwapnetDeployer.txMined(uniswap.erc20.approve(uniswapExchange.address, WeiPerEther.mul(100_000_000)));

            const chainId = (await this.provider.getNetwork()).chainId;
            if (chainId === 1337) {
                // This is required in ganache to get the block timestamp correct.
                log("Resetting network timestamp")
                await (this.provider as JsonRpcProvider).send(
                    "evm_mine",
                    [Math.floor(new Date().getTime() / 1000)]
                );
            }
            const currentBlock = await this.provider.getBlock(await this.provider.getBlockNumber());

            // Setup the liquidity pool
            log(`Seeding mock uniswap pool at ${uniswapExchange.address}`);
            await SwapnetDeployer.txMined(uniswapExchange.addLiquidity(
                seedEthBalance,
                tokenBalance,
                currentBlock.timestamp + 10000,
                { value: seedEthBalance }
            ));
        }

        await SwapnetDeployer.txMined(this.escrow.addExchangeRate(
            base,
            quote,
            chainlink.address,
            uniswapExchange.address,
            haircut
        ));

        return {chainlink, uniswapExchange};
    }

    public deployFutureCashMarket = async (
        currencyId: number,
        numPeriods: number,
        periodSize: number,
        maxTradeSize: BigNumber,
        liquidityFee: BigNumber,
        transactionFee: BigNumber,
        precision: number = 1e9,
        rateAnchor: number = 1_050_000_000,
        rateScalar: number = 100
    ) => {
        const tokenAddress = await this.escrow.currencyIdToAddress(currencyId);
        const futureCash = await SwapnetDeployer.deployProxyContract(
            this.owner,
            SwapnetDeployer.loadArtifact("FutureCash"),
            'address,address',
            [this.directory.address, tokenAddress],
            this.proxyAdmin
        ) as FutureCash;

        log("Creating instrument group...");
        await SwapnetDeployer.txMined(this.portfolios.createInstrumentGroup(
            numPeriods,
            periodSize,
            precision,
            currencyId,
            futureCash.address,
            AddressZero
        ));

        log("Setting future cash parameters...");
        await SwapnetDeployer.txMined(futureCash.setMaxTradeSize(maxTradeSize));
        await SwapnetDeployer.txMined(futureCash.setFee(liquidityFee, transactionFee));
        await SwapnetDeployer.txMined(futureCash.setRateFactors(rateAnchor, rateScalar))

        return futureCash;
    }

    public upgradeContract = async (name: CoreContracts, artifact: any) => {
        const contract = this.coreContractToContract(name)
        const proxy = new ethers.Contract(contract.address, AdminUpgradeabilityProxyArtifact.abi, this.owner);

        // Deploy the upgraded logic contract
        log("Deploying new logic contract");
        const upgrade = await SwapnetDeployer.deployContract(this.owner, artifact, []);
        log(`Deployed new logic contract at ${upgrade.address}`);
        await SwapnetDeployer.txMined(this.proxyAdmin.upgrade(proxy.address, upgrade.address));
        log(`Proxy Admin upgraded ${name.toString()}`);
    }

    public static restoreFromFile = async (path: string, owner: Wallet) => {
        const addresses = JSON.parse(readFileSync(path, "utf8"));

        const escrow = new Contract(addresses.escrow, EscrowArtifact.abi, owner) as Escrow;
        const portfolios = new Contract(addresses.portfolios, PortfoliosArtifact.abi, owner) as Portfolios;
        const risk = new Contract(addresses.risk, RiskFrameworkArtifact.abi, owner) as RiskFramework;
        const proxyAdmin = new Contract(addresses.proxyAdmin, ProxyAdminArtifact.abi, owner) as ProxyAdmin;
        const directory = new Contract(addresses.directory, DirectoryArtifact.abi, owner) as Directory;
        const erc1155 = new Contract(addresses.erc1155, ERC1155TokenArtifact.abi, owner) as ERC1155Token;

        return new SwapnetDeployer(
            owner,
            escrow,
            portfolios,
            risk,
            owner.provider,
            proxyAdmin,
            directory,
            erc1155,
            addresses.startBlock
        );
    };

    public async saveAddresses(path: string) {
        const network = await this.owner.provider.getNetwork();
        const addresses = {
            chainId: network.chainId,
            networkName: network.name,
            escrow: this.escrow.address,
            portfolios: this.portfolios.address,
            risk: this.risk.address,
            proxyAdmin: this.proxyAdmin.address,
            directory: this.directory.address,
            erc1155: this.erc1155.address,
            startBlock: this.startBlock
        }
        writeFileSync(path, JSON.stringify(addresses, null, 2));
    }
}
