import {Provider} from "ethers/providers";
import {readFileSync, writeFileSync} from "fs";
import {BigNumber, parseEther} from "ethers/utils";
import {WeiPerEther, AddressZero} from "ethers/constants";
import {Wallet, ContractFactory, Contract, ethers} from "ethers";

import ERC20Artifact from "../build/ERC20.json";
import DirectoryArtifact from "../build/Directory.json";
import EscrowArtifact from "../build/Escrow.json";
import PortfoliosArtifact from "../build/Portfolios.json";
import RiskFrameworkArtifact from "../build/RiskFramework.json";
import ERC1155TokenArtifact from "../build/ERC1155Token.json";
import ERC1155TradeArtifact from "../build/ERC1155Trade.json";

import ERC1820RegistryArtifact from "../mocks/ERC1820Registry.json";
import WETHArtifact from "../mocks/WETH9.json";
import MockAggregatorArtifact from "../build/MockAggregator.json";
import ProxyAdminArtifact from "../build/ProxyAdmin.json";
import AdminUpgradeabilityProxyArtifact from "../build/AdminUpgradeabilityProxy.json";

import {Portfolios} from "../typechain/Portfolios";
import {Escrow} from "../typechain/Escrow";
import {ProxyAdmin} from "../typechain/ProxyAdmin";
import {Directory} from "../typechain/Directory";
import {RiskFramework} from "../typechain/RiskFramework";
import {Ierc1820Registry as IERC1820Registry} from "../typechain/Ierc1820Registry";
import {MockAggregator} from "../typechain/MockAggregator";
import {Erc20 as ERC20} from "../typechain/Erc20";
import {FutureCash} from "../typechain/FutureCash";
import {Erc1155Token as ERC1155Token} from "../typechain/Erc1155Token";
import {Erc1155Trade as ERC1155Trade} from "../typechain/Erc1155Trade";
import {Iweth as IWETH} from '../typechain/Iweth';

import Debug from "debug";
import path from "path";
const log = Debug("swapnet:deploy");

// This is a mirror of the enum in Governed
export const enum CoreContracts {
    Escrow = 0,
    RiskFramework,
    Portfolios,
    ERC1155Token,
    ERC1155Trade
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
        public erc1155trade: ERC1155Trade,
        public startBlock: number,
        public libraries: Map<string, Contract>
    ) {}

    public coreContractToContract = (contract: CoreContracts) => {
        switch (contract) {
            case CoreContracts.ERC1155Token:
                return this.erc1155;
            case CoreContracts.ERC1155Trade:
                return this.erc1155trade;
            case CoreContracts.Escrow:
                return this.escrow;
            case CoreContracts.Portfolios:
                return this.portfolios;
            case CoreContracts.RiskFramework:
                return this.risk;
            default:
                throw new Error(`Unknown core contract ${contract}`);
        }
    };

    private static link = (
        artifact: any,
        libraries: Map<string, Contract>
    ) => {
        for (let k of Object.keys(artifact.linkReferences)) {
            let libname = Object.keys(artifact.linkReferences[k])[0];
            const contract = libraries.get(libname);
            if (contract == null) throw new Error(`${libname} library is not defined`);

            for (let offset of artifact.linkReferences[k][libname]) {
                log(`Linking ${libname} into ${artifact.contractName}`)
                const byteOffsetStart = offset.start * 2 + 2;
                const byteOffsetEnd = byteOffsetStart + offset.length * 2;
                artifact.bytecode = artifact.bytecode.substring(0, byteOffsetStart) +
                    contract.address.substr(2) + 
                    artifact.bytecode.substring(byteOffsetEnd);
            }
        }
    }

    private static deployContract = async (
        owner: Wallet,
        artifact: any,
        args: any[],
        libraries?: Map<string, Contract>
    ) => {
        let gasLimit;
        if (process.env.COVERAGE == "true") {
            gasLimit = 20_000_000;
        } else {
            gasLimit = 6_000_000;
        }

        if (Object.keys(artifact.linkReferences).length > 0) {
            if (libraries == null) throw new Error(`Libraries not defined for ${artifact.contractName}`);
            SwapnetDeployer.link(artifact, libraries);
        }

        try {
            const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
            const txn = factory.getDeployTransaction(...args);
            txn.gasLimit = gasLimit;
            log(`Deploying ${artifact.contractName}...`);
            const receipt = await (await owner.sendTransaction(txn)).wait();
            const contract = new Contract(receipt.contractAddress as string, artifact.abi, owner);
            log(`Successfully deployed ${artifact.contractName} at ${contract.address}...`);
            return contract;
        } catch {
            throw new Error("fail");
        }

    };

    private static deployProxyContract = async <T>(
        owner: Wallet,
        artifact: any,
        initializeSig: string,
        params: any[],
        proxyAdmin: ProxyAdmin,
        libraries: Map<string, Contract>
    ) => {
        const logic = await SwapnetDeployer.deployContract(owner, artifact, [], libraries);

        const abi = new ethers.utils.Interface(artifact.abi);
        log(`Initializing ${artifact.contractName} with sig ${initializeSig} and params ${params}`);
        const data = abi.functions[`initialize(${initializeSig})`].encode(params);
        const proxy = await SwapnetDeployer.deployContract(owner, AdminUpgradeabilityProxyArtifact, [
            logic.address,
            proxyAdmin.address,
            data
        ]);
        log(`Deployed proxy for ${artifact.contractName}`);

        return (new ethers.Contract(proxy.address, artifact.abi, owner) as unknown) as T;
    };

    public static deployPrerequisites = async (owner: Wallet) => {
        const weth = (await SwapnetDeployer.deployContract(owner, WETHArtifact, [])) as IWETH;
        const registry = (await SwapnetDeployer.deployContract(owner, ERC1820RegistryArtifact, [])) as IERC1820Registry;

        return {registry, weth};
    };

    private static txMined = async (tx: Promise<ethers.ContractTransaction>) => {
        return await (await tx).wait();
    };

    private static loadArtifact = (contract: string): any => {
        let buildDir;
        if (process.env.COVERAGE == "true") {
            buildDir = path.join(__dirname, "../.coverage_artifacts");
        } else {
            buildDir = path.join(__dirname, "../build");
        }
        return JSON.parse(readFileSync(path.join(buildDir, `${contract}.json`), "utf8"));
    };

    public static deploy = async (
        owner: Wallet,
        registryAddress: string,
        wethAddress: string,
        liquidationDiscount: BigNumber,
        settlementDiscount: BigNumber,
        liquidityHaircut: BigNumber,
        repoDiscount: BigNumber
    ) => {
        const startBlock = await owner.provider.getBlockNumber();
        const libraries = new Map<string, Contract>();
        
        libraries.set("Liquidation", (await SwapnetDeployer.deployContract(
            owner,
            SwapnetDeployer.loadArtifact("Liquidation"),
            []
        )))

        const proxyAdmin = (await SwapnetDeployer.deployContract(
            owner,
            SwapnetDeployer.loadArtifact("ProxyAdmin"),
            []
        )) as ProxyAdmin;

        const directory = await SwapnetDeployer.deployProxyContract<Directory>(
            owner,
            SwapnetDeployer.loadArtifact("Directory"),
            "",
            [],
            proxyAdmin,
            libraries
        );

        const escrow = await SwapnetDeployer.deployProxyContract<Escrow>(
            owner,
            SwapnetDeployer.loadArtifact("Escrow"),
            "address,address,address,uint128",
            [directory.address, registryAddress, wethAddress, parseEther("1.3")],
            proxyAdmin,
            libraries
        );

        const portfolios = await SwapnetDeployer.deployProxyContract<Portfolios>(
            owner,
            SwapnetDeployer.loadArtifact("Portfolios"),
            "address,uint16,uint256",
            [directory.address, 1, 10],
            proxyAdmin,
            libraries
        );

        const risk = await SwapnetDeployer.deployProxyContract<RiskFramework>(
            owner,
            SwapnetDeployer.loadArtifact("RiskFramework"),
            "address",
            [directory.address],
            proxyAdmin,
            libraries
        );

        const erc1155 = await SwapnetDeployer.deployProxyContract<ERC1155Token>(
            owner,
            SwapnetDeployer.loadArtifact("ERC1155Token"),
            "address",
            [directory.address],
            proxyAdmin,
            libraries
        );

        const erc1155trade = await SwapnetDeployer.deployProxyContract<ERC1155Trade>(
            owner,
            SwapnetDeployer.loadArtifact("ERC1155Trade"),
            "address",
            [directory.address],
            proxyAdmin,
            libraries
        );

        // Set dependencies
        log("Setting Swapnet Contract: Escrow");
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.Escrow, escrow.address));
        log("Setting Swapnet Contract: Portfolios");
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.Portfolios, portfolios.address));
        log("Setting Swapnet Contract: RiskFramework");
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.RiskFramework, risk.address));
        log("Setting Swapnet Contract: ERC1155Token");
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.ERC1155Token, erc1155.address));
        log("Setting Swapnet Contract: ERC1155Trade");
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.ERC1155Trade, erc1155trade.address));

        log("Setting Swapnet Dependencies: Escrow Dependency");
        await SwapnetDeployer.txMined(directory.setDependencies(CoreContracts.Escrow, [
            CoreContracts.Portfolios,
            CoreContracts.ERC1155Trade,
            CoreContracts.RiskFramework
        ]));
        log("Setting Swapnet Dependencies: RiskFramework Dependency");
        await SwapnetDeployer.txMined(
            directory.setDependencies(CoreContracts.RiskFramework, [
                CoreContracts.Portfolios,
                CoreContracts.Escrow,
            ])
        );
        log("Setting Swapnet Dependencies: ERC1155Token Dependency");
        await SwapnetDeployer.txMined(
            directory.setDependencies(CoreContracts.ERC1155Token, [CoreContracts.Portfolios])
        );
        log("Setting Swapnet Dependencies: ERC1155Trade Dependency");
        await SwapnetDeployer.txMined(
            directory.setDependencies(CoreContracts.ERC1155Trade, [CoreContracts.Portfolios, CoreContracts.Escrow])
        );
        log("Setting Swapnet Dependencies: Portfolio Dependency");
        await SwapnetDeployer.txMined(
            directory.setDependencies(CoreContracts.Portfolios, [
                CoreContracts.Escrow,
                CoreContracts.RiskFramework,
                CoreContracts.ERC1155Token,
                CoreContracts.ERC1155Trade
            ])
        );

        // Setup some contract defaults
        log("Setting liquidation discounts");
        await SwapnetDeployer.txMined(escrow.setDiscounts(liquidationDiscount, settlementDiscount, repoDiscount));

        log("Setting collateral currencies");
        await SwapnetDeployer.txMined(risk.setHaircut(liquidityHaircut));

        return new SwapnetDeployer(
            owner,
            escrow,
            portfolios,
            risk,
            owner.provider,
            proxyAdmin,
            directory,
            erc1155,
            erc1155trade,
            startBlock,
            libraries
        );
    };

    public deployMockCurrency = async (
        initialExchangeRate: BigNumber,
        haircut: BigNumber,
    ) => {
        // A mock currency has an ERC20 token and chainlink.
        log("Deploying mock currency");
        const erc20 = (await SwapnetDeployer.deployContract(this.owner, ERC20Artifact, [])) as ERC20;

        log("Listing currency on Escrow");
        await SwapnetDeployer.txMined(this.escrow.listCurrency(erc20.address, { isERC777: false, hasTransferFee: false }));
        const currencyId = (await this.escrow.addressToCurrencyId(erc20.address)) as number;

        log("Registering new exchange rate");
        const {chainlink} = await this.deployExchangeRate(
            currencyId,
            0,
            initialExchangeRate,
            haircut
        );

        return {currencyId, erc20, chainlink};
    };

    public async deployExchangeRate(
        base: number,
        quote: number,
        initialExchangeRate: BigNumber,
        haircut: BigNumber
    ) {
        log("Deploying mock chainlink");
        const chainlink = (await SwapnetDeployer.deployContract(
            this.owner,
            MockAggregatorArtifact,
            []
        )) as MockAggregator;
        await SwapnetDeployer.txMined(chainlink.setAnswer(initialExchangeRate));

        await SwapnetDeployer.txMined(
            this.escrow.addExchangeRate(
                base,
                quote,
                chainlink.address,
                haircut,
                WeiPerEther,
                false
            )
        );

        return {chainlink};
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
        const futureCash = (await SwapnetDeployer.deployProxyContract(
            this.owner,
            SwapnetDeployer.loadArtifact("FutureCash"),
            "address,address",
            [this.directory.address, tokenAddress],
            this.proxyAdmin,
            new Map<string, Contract>()

        )) as FutureCash;

        log("Creating future cash group...");
        await SwapnetDeployer.txMined(
            this.portfolios.createFutureCashGroup(
                numPeriods,
                periodSize,
                precision,
                currencyId,
                futureCash.address,
                AddressZero
            )
        );

        log("Setting future cash parameters...");
        await SwapnetDeployer.txMined(futureCash.setMaxTradeSize(maxTradeSize));
        await SwapnetDeployer.txMined(futureCash.setFee(liquidityFee, transactionFee));
        await SwapnetDeployer.txMined(futureCash.setRateFactors(rateAnchor, rateScalar));

        return futureCash;
    };

    public upgradeContract = async (name: CoreContracts, artifact: any) => {
        const contract = this.coreContractToContract(name);
        const proxy = new ethers.Contract(contract.address, AdminUpgradeabilityProxyArtifact.abi, this.owner);

        // Deploy the upgraded logic contract
        log("Deploying new logic contract");
        const upgrade = await SwapnetDeployer.deployContract(this.owner, artifact, []);
        log(`Deployed new logic contract at ${upgrade.address}`);
        await SwapnetDeployer.txMined(this.proxyAdmin.upgrade(proxy.address, upgrade.address));
        log(`Proxy Admin upgraded ${name.toString()}`);
    };

    public static restoreFromFile = async (path: string, owner: Wallet) => {
        const addresses = JSON.parse(readFileSync(path, "utf8"));

        const escrow = new Contract(addresses.escrow, EscrowArtifact.abi, owner) as Escrow;
        const portfolios = new Contract(addresses.portfolios, PortfoliosArtifact.abi, owner) as Portfolios;
        const risk = new Contract(addresses.risk, RiskFrameworkArtifact.abi, owner) as RiskFramework;
        const proxyAdmin = new Contract(addresses.proxyAdmin, ProxyAdminArtifact.abi, owner) as ProxyAdmin;
        const directory = new Contract(addresses.directory, DirectoryArtifact.abi, owner) as Directory;
        const erc1155 = new Contract(addresses.erc1155, ERC1155TokenArtifact.abi, owner) as ERC1155Token;
        const erc1155trade = new Contract(addresses.erc1155trade, ERC1155TradeArtifact.abi, owner) as ERC1155Trade;
        const libraries = Object.keys(addresses.libraries).reduce((obj, name) => {
            obj.set(name, new Contract(addresses.libraries[name], SwapnetDeployer.loadArtifact(name).abi, owner));
            return obj;
        }, new Map<string, Contract>())

        return new SwapnetDeployer(
            owner,
            escrow,
            portfolios,
            risk,
            owner.provider,
            proxyAdmin,
            directory,
            erc1155,
            erc1155trade,
            addresses.startBlock,
            libraries
        );
    };

    public async saveAddresses(path: string) {
        const network = await this.owner.provider.getNetwork();
        const libraries = Array.from(this.libraries.entries()).reduce((obj, [name, contract]) => {
            obj[name] = contract.address;
            return obj;
        }, {} as {[name: string]: string})
        const addresses = {
            chainId: network.chainId,
            networkName: network.name,
            escrow: this.escrow.address,
            portfolios: this.portfolios.address,
            risk: this.risk.address,
            proxyAdmin: this.proxyAdmin.address,
            directory: this.directory.address,
            erc1155: this.erc1155.address,
            erc1155trade: this.erc1155trade.address,
            startBlock: this.startBlock,
            libraries: libraries
        };
        writeFileSync(path, JSON.stringify(addresses, null, 2));
    }
}
