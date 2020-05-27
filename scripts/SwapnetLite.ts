import {Wallet, ContractFactory, Contract, ethers} from "ethers";
import {UniswapExchangeInterface} from "../typechain/UniswapExchangeInterface";
import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";

import ERC20Artifact from "../build/ERC20.json";
import DirectoryArtifact from "../build/Directory.json";
import EscrowArtifact from "../build/Escrow.json";
import PortfoliosArtifact from "../build/Portfolios.json";
import RiskFrameworkArtifact from "../build/RiskFramework.json";
import FutureCashArtifact from "../build/FutureCash.json";

import ERC1820RegistryArtifact from "../mocks/ERC1820Registry.json";
import UniswapFactoryArtifact from "../mocks/UniswapFactory.json";
import UniswapExchangeArtifact from "../mocks/UniswapExchange.json";
import MockAggregatorArtifact from "../build/MockAggregator.json";
import ProxyAdminArtifact from "../build/ProxyAdmin.json";
import AdminUpgradeabilityProxyArtifact from "../build/AdminUpgradeabilityProxy.json";

import {UniswapFactoryInterface} from "../typechain/UniswapFactoryInterface";
import {JsonRpcProvider, Provider} from "ethers/providers";
import {readFileSync, writeFileSync} from "fs";
import { MockAggregator } from '../typechain/MockAggregator';
import { BigNumber } from 'ethers/utils';
import { WeiPerEther, AddressZero } from 'ethers/constants';
import { Portfolios } from '../typechain/Portfolios';
import { Escrow } from '../typechain/Escrow';
import { ProxyAdmin } from '../typechain/ProxyAdmin';
import { Directory } from '../typechain/Directory';
import { RiskFramework } from '../typechain/RiskFramework';
import {IERC1820Registry} from "../typechain/IERC1820Registry";
import Debug from "debug";

const log = Debug("swapnet:deploy");

// This is a mirror of the enum in Governed
export const enum CoreContracts {
    Escrow = 0,
    Instruments,
    LiquidationAuction,
    RiskFramework,
    Swap,
    Portfolios,
    SettlementOracle,
    ERC1155Token,
    SwapnetUtils,
    PoolShares
}

export class SwapnetLite {
    constructor(
        public owner: Wallet,
        public escrow: Escrow,
        public portfolios: Portfolios,
        public risk: RiskFramework,
        public provider: Provider,
        public proxyAdmin: ProxyAdmin,
        public directory: Directory
    ) {}

    private static deployContract = async (owner: Wallet, artifact: any, args: any[]) => {
        const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
        const contract = await factory.deploy(...args);
        log(`Deploying ${artifact.contractName}...`);
        await contract.deployed();
        log(`Successfully deployed ${artifact.contractName}...`);

        return contract;
    };

    private static deployProxyContract = async <T>(
        owner: Wallet,
        artifact: any,
        initializeSig: string,
        params: any[],
        proxyAdmin: ProxyAdmin
    ) => {
        const logic = (await SwapnetLite.deployContract(owner, artifact, []));

        const abi = new ethers.utils.Interface(artifact.abi);
        log(`Initializing ${artifact.contractName} with sig ${initializeSig} and params ${params}`);
        const data = abi.functions[`initialize(${initializeSig})`].encode(params);
        const proxy = await SwapnetLite.deployContract(
            owner,
            AdminUpgradeabilityProxyArtifact,
            [logic.address, proxyAdmin.address, data]
        );
        log(`Deployed proxy for ${artifact.contractName}`);

        return new ethers.Contract(proxy.address, artifact.abi, owner) as unknown as T;
    };

    public static deployPrerequisites = async (owner: Wallet) => {
        const uniswapTemplate = await SwapnetLite.deployContract(owner, UniswapExchangeArtifact, []);
        const uniswapFactory = (await SwapnetLite.deployContract(
            owner,
            UniswapFactoryArtifact,
            []
        )) as UniswapFactoryInterface;
        await uniswapFactory.initializeFactory(uniswapTemplate.address);

        const registry = await SwapnetLite.deployContract(owner, ERC1820RegistryArtifact, []) as IERC1820Registry;

        return { uniswapFactory, registry };
    }

    public static deploy = async (owner: Wallet, registryAddress: string) => {
        const proxyAdmin = await SwapnetLite.deployContract(
            owner,
            ProxyAdminArtifact,
            []
        ) as ProxyAdmin;

        const directory = await SwapnetLite.deployProxyContract<Directory>(
            owner,
            DirectoryArtifact,
            '',
            [],
            proxyAdmin
        );

        const escrow = await SwapnetLite.deployProxyContract<Escrow>(
            owner,
            EscrowArtifact,
            'address,address',
            [directory.address, registryAddress],
            proxyAdmin
        );

        const portfolios = await SwapnetLite.deployProxyContract<Portfolios>(
            owner,
            PortfoliosArtifact,
            'address,uint256',
            [directory.address, 100],
            proxyAdmin
        );

        const risk = await SwapnetLite.deployProxyContract<RiskFramework>(
            owner,
            RiskFrameworkArtifact,
            'address',
            [directory.address],
            proxyAdmin
        );

        // Set dependencies
        log("Setting Swapnet Dependencies")
        await directory.setContract(CoreContracts.Escrow, escrow.address);
        await directory.setContract(CoreContracts.Portfolios, portfolios.address);
        await directory.setContract(CoreContracts.RiskFramework, risk.address);
        await directory.setDependencies(CoreContracts.Portfolios, [CoreContracts.Escrow, CoreContracts.RiskFramework]);
        await directory.setDependencies(CoreContracts.Escrow, [CoreContracts.Portfolios]);
        await directory.setDependencies(CoreContracts.RiskFramework, [CoreContracts.Portfolios]);

        // Setup some contract defaults
        log("Setting contract default parameters")
        await escrow.createCurrencyGroup(AddressZero); // This creates a group for ETH
        await escrow.setEscrowHaircuts(
            WeiPerEther.add(WeiPerEther.div(100).mul(5)),
            WeiPerEther.add(WeiPerEther.div(100).mul(1))
        );

        await escrow.setCollateralCurrency(1);
        await portfolios.setCollateralCurrency(1);
        await risk.setHaircut(WeiPerEther.add(WeiPerEther.div(100).mul(5)));

        return new SwapnetLite(owner, escrow, portfolios, risk, owner.provider, proxyAdmin, directory);
    };

    public deployMockCurrency = async (
        uniswapFactory: UniswapFactoryInterface,
        initialExchangeRate: BigNumber,
        haircut: BigNumber
    ) => {
        // A mock currency has an ERC20 token, chainlink, and uniswap exchange.
        log("Deploying mock currency")
        const erc20 = (await SwapnetLite.deployContract(
            this.owner,
            ERC20Artifact,
            []
        )) as ERC20;

        log("Deploying mock chainlink")
        const chainlink = (await SwapnetLite.deployContract(
            this.owner,
            MockAggregatorArtifact,
            [])
        ) as MockAggregator;
        await chainlink.setAnswer(initialExchangeRate);

        log("Deploying mock uniswap")
        await uniswapFactory.createExchange(erc20.address, {gasLimit: 5_000_000});
        const uniswapExchange = new ethers.Contract(
            await uniswapFactory.getExchange(erc20.address),
            UniswapExchangeArtifact.abi,
            this.owner
        ) as UniswapExchangeInterface;

        const ethBalance = WeiPerEther.mul(10_000);
        const tokenBalance = ethBalance.mul(WeiPerEther).div(initialExchangeRate);
        await erc20.approve(uniswapExchange.address, WeiPerEther.mul(100_000_000));

        if ((await this.provider.getNetwork()).name == "ganache") {
            // This is required in ganache to get the block timestamp correct.
            log("Resetting network timestamp")
            await (this.provider as JsonRpcProvider).send(
                "evm_mine",
                [Math.floor(new Date().getTime() / 1000)]
            );
        }
        const currentBlock = await this.provider.getBlock(await this.provider.getBlockNumber());

        // Setup the liquidity pool
        log("Seeding mock uniswap pool")
        await uniswapExchange.addLiquidity(
            ethBalance,
            tokenBalance,
            currentBlock.timestamp + 10000,
            { value: ethBalance }
        );

        log("Registering new exchange rate")
        await this.escrow.createCurrencyGroup(erc20.address);
        const currencyId = await this.escrow.tokensToGroups(erc20.address);
        await this.escrow.addExchangeRate(
            currencyId,
            1,
            chainlink.address,
            uniswapExchange.address,
            haircut
        );
    };

    public deployFutureCashMarket = async (
        currencyId: number,
        numPeriods: number,
        periodSize: number,
        maxTradeSize: BigNumber,
        liquidityFee: BigNumber,
        transactionFee: BigNumber,
        precision: number = 1e9,
    ) => {
        const cg = await this.escrow.getCurrencyGroup(currencyId);
        const futureCash = await SwapnetLite.deployProxyContract(
            this.owner,
            FutureCashArtifact,
            'address,address',
            [this.directory.address, cg.primary],
            this.proxyAdmin
        ) as FutureCash;

        await this.portfolios.createInstrumentGroup(
            numPeriods,
            periodSize,
            precision,
            currencyId,
            futureCash.address,
            AddressZero
        );

        await futureCash.setMaxTradeSize(maxTradeSize);
        await futureCash.setFee(liquidityFee, transactionFee);

        return futureCash;
    }


    public static restoreFromFile = (path: string, provider: JsonRpcProvider) => {
        const addresses = JSON.parse(readFileSync(path, "utf8"));

        const owner = new Wallet(addresses.owner, provider);
        const escrow = new Contract(addresses.escrow, EscrowArtifact.abi, owner) as Escrow;
        const portfolios = new Contract(addresses.portfolios, PortfoliosArtifact.abi, owner) as Portfolios;
        const risk = new Contract(addresses.risk, RiskFrameworkArtifact.abi, owner) as RiskFramework;
        const proxyAdmin = new Contract(addresses.proxyAdmin, ProxyAdminArtifact.abi, owner) as ProxyAdmin;
        const directory = new Contract(addresses.directory, DirectoryArtifact.abi, owner) as Directory;

        return new SwapnetLite(
            owner,
            escrow,
            portfolios,
            risk,
            provider,
            proxyAdmin,
            directory
        );
    };

    public saveAddresses(path: string) {
        writeFileSync(
            path,
            JSON.stringify(
                {
                    owner: this.owner.privateKey,
                    escrow: this.escrow.address,
                    portfolios: this.portfolios.address,
                    risk: this.risk.address,
                    proxyAdmin: this.proxyAdmin.address,
                    directory: this.directory.address
                },
                null,
                2
            )
        );
    }
}
