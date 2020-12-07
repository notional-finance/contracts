import {Provider} from "ethers/providers";
import {readFileSync, writeFileSync} from "fs";
import {BigNumber, parseUnits} from "ethers/utils";
import {Wallet, ContractFactory, Contract, ethers} from "ethers";
import { WeiPerEther } from 'ethers/constants';

import DirectoryArtifact from "../build/Directory.json";
import EscrowArtifact from "../build/Escrow.json";
import PortfoliosArtifact from "../build/Portfolios.json";
import ERC1155TokenArtifact from "../build/ERC1155Token.json";
import ERC1155TradeArtifact from "../build/ERC1155Trade.json";
import ProxyAdminArtifact from "../build/ProxyAdmin.json";
import CreateProxyFactoryArtifact from "../build/CreateProxyFactory.json";
import AdminUpgradeabilityProxyArtifact from "../build/AdminUpgradeabilityProxy.json";
import OpenZeppelinUpgradesOwnableArtifact from "../build/OpenZeppelinUpgradesOwnable.json";

import {Portfolios} from "../typechain/Portfolios";
import {Escrow} from "../typechain/Escrow";
import {ProxyAdmin} from "../typechain/ProxyAdmin";
import {Directory} from "../typechain/Directory";
import {Ierc20 as ERC20} from "../typechain/Ierc20";
import {CashMarket} from "../typechain/CashMarket";
import {Erc1155Token as ERC1155Token} from "../typechain/Erc1155Token";
import {Erc1155Trade as ERC1155Trade} from "../typechain/Erc1155Trade";
import { Ierc1820Registry as IERC1820Registry } from "../typechain/Ierc1820Registry";
import { Iweth as IWETH } from '../typechain/Iweth';
import { IAggregator } from '../typechain/IAggregator';
import { OpenZeppelinUpgradesOwnable } from '../typechain/OpenZeppelinUpgradesOwnable';
import { CreateProxyFactory } from '../typechain/CreateProxyFactory';
import { AdminUpgradeabilityProxy } from '../typechain/AdminUpgradeabilityProxy';

import Debug from "debug";
import path from "path";
const log = Debug("notional:deploy");

export interface Environment {
    deploymentWallet: Wallet,
    WETH: IWETH;
    ERC1820: IERC1820Registry;
    DAI: ERC20;
    USDC: ERC20;
    DAIETHOracle: IAggregator;
    USDCETHOracle: IAggregator;
    proxyFactory: CreateProxyFactory;
}

// This is a mirror of the enum in Governed
export const enum CoreContracts {
    Escrow = 0,
    Portfolios,
    ERC1155Token,
    ERC1155Trade
}

export class NotionalDeployer {
    constructor(
        public owner: Wallet,
        public escrow: Escrow,
        public portfolios: Portfolios,
        public provider: Provider,
        public proxyAdmin: ProxyAdmin,
        public proxyFactory: CreateProxyFactory,
        public directory: Directory,
        public erc1155: ERC1155Token,
        public erc1155trade: ERC1155Trade,
        public cashMarketLogicAddress: string,
        public startBlock: number,
        public libraries: Map<string, Contract>,
        public deployedCodeHash: Map<string, string>,
        public defaultConfirmations: number
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
            default:
                throw new Error(`Unknown core contract ${contract}`);
        }
    };

    public coreContractToName = (contract: CoreContracts) => {
        switch (contract) {
            case CoreContracts.ERC1155Token:
                return "ERC1155Token";
            case CoreContracts.ERC1155Trade:
                return "ERC1155Trade";
            case CoreContracts.Escrow:
                return "Escrow";
            case CoreContracts.Portfolios:
                return "Portfolios";
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
                log(`Linking ${libname} into ${artifact.contractName} using ${contract.address}`)
                const byteOffsetStart = offset.start * 2 + 2;
                const byteOffsetEnd = byteOffsetStart + offset.length * 2;
                artifact.bytecode = artifact.bytecode.substring(0, byteOffsetStart) +
                    contract.address.substr(2) + 
                    artifact.bytecode.substring(byteOffsetEnd);
            }
        }

        return artifact;
    }

    public static deployContract = async (
        owner: Wallet,
        name: string | any,
        args: any[],
        confirmations: number,
        libraries?: Map<string, Contract>
    ) => {
        let gasLimit: number | undefined;
        if (process.env.COVERAGE == "true") {
            gasLimit = 20_000_000;
        } else if (process.env.GAS_LIMIT != null) {
            gasLimit = parseInt(process.env.GAS_LIMIT);
        } else {
            gasLimit = 6_000_000;
        }
        log(`Gas limit setting ${process.env.GAS_LIMIT} and ${gasLimit}`)

        let artifact;
        if (typeof name == "string") {
            artifact = NotionalDeployer.loadArtifact(name);
        } else {
            artifact = name;
        }

        if (Object.keys(artifact.linkReferences).length > 0) {
            if (libraries == null) throw new Error(`Libraries not defined for ${artifact.contractName}`);
            artifact = NotionalDeployer.link(artifact, libraries);
        }

        const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
        const txn = factory.getDeployTransaction(...args);
        if (gasLimit == -1) {
            if (process.env.GAS_PRICE == undefined) throw new Error("Define gas price in environment")
            txn.gasPrice = parseUnits(process.env.GAS_PRICE, "gwei");
            log(`Gas price: ${txn.gasPrice}`)
        } else {
            txn.gasLimit = gasLimit;
        }

        log(`Deploying ${artifact.contractName}...`);
        const receipt = await (await owner.sendTransaction(txn)).wait(confirmations);
        const contract = new Contract(receipt.contractAddress as string, artifact.abi, owner);
        log(`Successfully deployed ${artifact.contractName} at ${contract.address}`);

        // We hash the bytecode in the artifact because the code on chain is not the same
        const bytecodeHash = ethers.utils.keccak256(artifact.bytecode);

        return {
            contract: contract,
            bytecodeHash: bytecodeHash
        };
    };

    private static deployProxyContract = async <T>(
        owner: Wallet,
        name: string,
        initializeSig: string,
        params: any[],
        proxyAdmin: ProxyAdmin,
        libraries: Map<string, Contract>,
        deployedCodeHash: Map<string, string>,
        confirmations: number,
        proxyFactory?: CreateProxyFactory,
        salt?: string,
        cashMarketLogicAddress?: string
    ) => {
        let logicAddress;

        if (name != "CashMarket") {
            const { contract: logic, bytecodeHash } = await NotionalDeployer.deployContract(owner, name, [], confirmations, libraries);
            deployedCodeHash.set(name, bytecodeHash);
            logicAddress = logic.address;
        } else {
            if (cashMarketLogicAddress == undefined) throw new Error("Cash market logic address undefined when deploying cash market")
            logicAddress = cashMarketLogicAddress;
        }

        const artifact = NotionalDeployer.loadArtifact(name);
        const abi = new ethers.utils.Interface(artifact.abi);
        log(`Initializing ${artifact.contractName} with sig ${initializeSig} and params ${params}`);
        const data = abi.functions[`initialize(${initializeSig})`].encode(params);

        let proxyAddress;
        if (proxyFactory == undefined) {
            // Deploy a proxy without the proxy factory, this will not have a predicatable address
            const { contract: proxy } = await NotionalDeployer.deployContract(owner, "AdminUpgradeabilityProxy", [
                logicAddress,
                proxyAdmin.address,
                data
            ], confirmations);
            proxyAddress = proxy.address;
        } else {
            if (salt == undefined) {
                salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(artifact.contractName))
            }
            proxyAddress = await proxyFactory.getDeploymentAddress(salt, owner.address);
            log(`Using proxy factory, got deployment address of ${proxyAddress} for ${artifact.contractName}`);
            await NotionalDeployer.txMined(proxyFactory.deploy(salt, logicAddress, proxyAdmin.address, data), confirmations);
        }

        log(`Deployed proxy for ${artifact.contractName} at ${proxyAddress}`);
        return (new ethers.Contract(proxyAddress, artifact.abi, owner) as unknown) as T
    };

    public static txMined = async (tx: Promise<ethers.ContractTransaction>, confirmations: number) => {
        return await (await tx).wait(confirmations);
    };

    public static loadArtifact = (contract: string): any => {
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
        environment: Environment,
        maxAssets: BigNumber,
        liquidationDiscount: BigNumber,
        settlementDiscount: BigNumber,
        liquidityHaircut: BigNumber,
        repoDiscount: BigNumber,
        fCashHaircut: BigNumber,
        fCashMaxHaircut: BigNumber,
        confirmations = 3
    ) => {
        const startBlock = await owner.provider.getBlockNumber();
        const libraries = new Map<string, Contract>();
        // Deploy transactions are used to determine if bytecode has changed
        const deployedCodeHash = new Map<string, string>();
        let cashMarketLogicAddress: string;
        
        {
            let {contract, bytecodeHash} = await NotionalDeployer.deployContract(
                owner,
                "Liquidation",
                [],
                confirmations
            );

            libraries.set("Liquidation", contract);
            deployedCodeHash.set("Liquidation", bytecodeHash);
        }

        {
            let {contract, bytecodeHash} = await NotionalDeployer.deployContract(
                owner,
                "RiskFramework",
                [],
                confirmations
            );
            libraries.set("RiskFramework", contract);
            deployedCodeHash.set("RiskFramework", bytecodeHash);
        }

        {
            let {contract, bytecodeHash} = await NotionalDeployer.deployContract(
                owner,
                "CashMarket",
                [],
                confirmations
            );
            cashMarketLogicAddress = contract.address;
            deployedCodeHash.set("CashMarket", bytecodeHash)
        }

        const proxyAdmin = (await NotionalDeployer.deployContract(
            owner,
            "ProxyAdmin",
            [],
            confirmations,
        )).contract as ProxyAdmin;

        const  directory = await NotionalDeployer.deployProxyContract<Directory>(
            owner,
            "Directory",
            "address",
            [owner.address],
            proxyAdmin,
            libraries,
            deployedCodeHash,
            confirmations,
            environment.proxyFactory
        );

        const escrow = await NotionalDeployer.deployProxyContract<Escrow>(
            owner,
            "Escrow",
            "address,address,address,address",
            [directory.address, owner.address, environment.ERC1820.address, environment.WETH.address],
            proxyAdmin,
            libraries,
            deployedCodeHash,
            confirmations,
            environment.proxyFactory
        );

        const INIT_NUM_CURRENCIES = 1;
        const portfolios = await NotionalDeployer.deployProxyContract<Portfolios>(
            owner,
            "Portfolios",
            "address,address,uint16,uint256",
            [directory.address, owner.address, INIT_NUM_CURRENCIES, maxAssets],
            proxyAdmin,
            libraries,
            deployedCodeHash,
            confirmations,
            environment.proxyFactory
        );

        // If these need to be upgraded we will change the directory. Neither holds state so there is no
        // need for them to be proxies.
        const erc1155 = await NotionalDeployer.deployProxyContract(
            owner,
            "ERC1155Token",
            "address,address",
            [directory.address,owner.address],
            proxyAdmin,
            libraries,
            deployedCodeHash,
            confirmations,
            environment.proxyFactory
        ) as ERC1155Token;

        const erc1155trade = await NotionalDeployer.deployProxyContract(
            owner,
            "ERC1155Trade",
            "address,address",
            [directory.address,owner.address],
            proxyAdmin,
            libraries,
            deployedCodeHash,
            confirmations,
            environment.proxyFactory
        ) as ERC1155Trade;

        // Set dependencies
        log("Setting Notional Contract: Escrow");
        await NotionalDeployer.txMined(directory.setContract(CoreContracts.Escrow, escrow.address), confirmations);
        log("Setting Notional Contract: Portfolios");
        await NotionalDeployer.txMined(directory.setContract(CoreContracts.Portfolios, portfolios.address), confirmations);
        log("Setting Notional Contract: ERC1155Token");
        await NotionalDeployer.txMined(directory.setContract(CoreContracts.ERC1155Token, erc1155.address), confirmations);
        log("Setting Notional Contract: ERC1155Trade");
        await NotionalDeployer.txMined(directory.setContract(CoreContracts.ERC1155Trade, erc1155trade.address), confirmations);

        log("Setting Notional Dependencies: Escrow Dependency");
        await NotionalDeployer.txMined(directory.setDependencies(CoreContracts.Escrow, [
            CoreContracts.Portfolios,
            CoreContracts.ERC1155Trade,
        ]), confirmations);
        log("Setting Notional Dependencies: ERC1155Token Dependency");
        await NotionalDeployer.txMined(
            directory.setDependencies(CoreContracts.ERC1155Token, [CoreContracts.Portfolios]),
            confirmations
        );
        log("Setting Notional Dependencies: ERC1155Trade Dependency");
        await NotionalDeployer.txMined(
            directory.setDependencies(CoreContracts.ERC1155Trade, [CoreContracts.Portfolios, CoreContracts.Escrow]),
            confirmations
        );
        log("Setting Notional Dependencies: Portfolio Dependency");
        await NotionalDeployer.txMined(
            directory.setDependencies(CoreContracts.Portfolios, [
                CoreContracts.Escrow,
                CoreContracts.ERC1155Token,
                CoreContracts.ERC1155Trade
            ]),
            confirmations
        );

        // Setup some contract defaults
        log("Setting liquidation discounts");
        await NotionalDeployer.txMined(escrow.setDiscounts(liquidationDiscount, settlementDiscount, repoDiscount), confirmations);

        log("Setting risk haircuts");
        await NotionalDeployer.txMined(portfolios.setHaircuts(liquidityHaircut, fCashHaircut, fCashMaxHaircut), confirmations);

        return new NotionalDeployer(
            owner,
            escrow,
            portfolios,
            owner.provider,
            proxyAdmin,
            environment.proxyFactory,
            directory,
            erc1155,
            erc1155trade,
            cashMarketLogicAddress,
            startBlock,
            libraries,
            deployedCodeHash,
            confirmations
        );
    };

    public listCurrency = async (
        tokenAddress: string,
        rateOracle: IAggregator,
        haircut: BigNumber,
        isERC777: boolean,
        hasTransferFee: boolean,
        rateDecimals: BigNumber,
        mustInvert: boolean
    ) => {
        log("Listing currency on Escrow");
        await NotionalDeployer.txMined(this.escrow.listCurrency(tokenAddress, { isERC777, hasTransferFee }), this.defaultConfirmations);
        const currencyId = (await this.escrow.addressToCurrencyId(tokenAddress)) as number;

        log("Registering new exchange rate to ETH");
        if (haircut.lt(WeiPerEther)) {
            throw new Error("Haircut must be greater than 1e18");
        }

        await NotionalDeployer.txMined(
            this.escrow.addExchangeRate(
                currencyId,
                0,
                rateOracle.address,
                haircut,
                rateDecimals,
                mustInvert
            ),
            this.defaultConfirmations
        );

        return currencyId;
    };

    public deployCashMarket = async (
        currencyId: number,
        numMaturities: number,
        maturityLength: number,
        maxTradeSize: BigNumber,
        liquidityFee: BigNumber,
        transactionFee: BigNumber,
        rateAnchor: number,
        rateScalar: number,
        precision: number = 1e9,
    ) => {
        const cashMarket = (await NotionalDeployer.deployProxyContract(
            this.owner,
            "CashMarket",
            "address,address",
            [this.directory.address, this.owner.address],
            this.proxyAdmin,
            new Map<string, Contract>(),
            this.deployedCodeHash,
            this.defaultConfirmations,
            undefined,
            undefined,
            this.cashMarketLogicAddress
        )) as CashMarket;
        await NotionalDeployer.txMined(cashMarket.initializeDependencies(), this.defaultConfirmations);

        log("Creating cash group...");
        await NotionalDeployer.txMined(
            this.portfolios.createCashGroup(
                numMaturities,
                maturityLength,
                precision,
                currencyId,
                cashMarket.address
            ), this.defaultConfirmations
        );

        log("Setting cash market parameters...");
        await NotionalDeployer.txMined(cashMarket.setMaxTradeSize(maxTradeSize), this.defaultConfirmations);
        await NotionalDeployer.txMined(cashMarket.setFee(liquidityFee, transactionFee), this.defaultConfirmations);
        await NotionalDeployer.txMined(cashMarket.setRateFactors(rateAnchor, rateScalar), this.defaultConfirmations);

        return cashMarket;
    };

    public checkDeployedLibraries = async () => {
        const changedLibraries: string[] = [];

        for (let [name, ] of Array.from(this.libraries.entries())) {
            const artifact = NotionalDeployer.loadArtifact(name);
            const localBytecodeHash = ethers.utils.keccak256(artifact.bytecode);
            const bytecodeHash = this.deployedCodeHash.get(name);
            if (bytecodeHash == undefined) throw new Error(`Deploy transaction for ${name} not defined`);

            if (bytecodeHash !== localBytecodeHash) changedLibraries.push(name);
        }

        return changedLibraries;
    }

    public deployLibrary = async (name: string, dryRun: boolean) => {
        if (!dryRun) {
            const {contract, bytecodeHash}  = await NotionalDeployer.deployContract(
                this.owner,
                name,
                [],
                this.defaultConfirmations
            );

            this.libraries.set(name, contract);
            this.deployedCodeHash.set(name, bytecodeHash);

            log(`Library ${name} deployed to ${this.libraries.get(name)?.address}`);
            return this.libraries.get(name)?.address
        } else {
            log(`*** Skipping library deployment of ${name}, dry run ***`);
        }

        return undefined
    }

    public upgradeCashMarket = async (address: string, dryRun: boolean) => {
        const shouldDeployLogic: boolean = await this.upgradeCheckCodeHash("CashMarket");

        if (shouldDeployLogic) {
            if (dryRun) {
                log(`*** Would have deployed new CashMarket logic contract ***`)
            } else {
                const upgrade = await this.upgradeDeployLogic("CashMarket");
                log(`Setting cash market logic address to: ${upgrade.address}`);
                this.cashMarketLogicAddress = upgrade.address;
            }
        }

        const implementationAddress = await this.proxyAdmin.getProxyImplementation(address);
        if (implementationAddress != this.cashMarketLogicAddress) {
            log(`Cash Market at proxy ${address} must upgrade logic to ${this.cashMarketLogicAddress}`);
            await this.upgradeProxy("CashMarket", address, this.cashMarketLogicAddress, dryRun);
        }

        return shouldDeployLogic ? this.cashMarketLogicAddress : undefined;
    }

    public upgradeContract = async (name: CoreContracts, dryRun: boolean) => {
        const contractName = this.coreContractToName(name);
        const contract = this.coreContractToContract(name);

        const shouldDeploy: boolean = await this.upgradeCheckCodeHash(contractName);
        if (!shouldDeploy) return;

        if (!dryRun) {
            const upgrade = await this.upgradeDeployLogic(contractName);
            await this.upgradeProxy(contractName, contract.address, upgrade.address, dryRun);
            return upgrade.address
        } else {
            log(`*** Would have deployed ${contractName} in dry run ***`);
            return undefined
        }
    };

    private async upgradeCheckCodeHash(contractName: string) {
        // Check implementation bytecode
        const bytecodeHash = this.deployedCodeHash.get(contractName);

        if (bytecodeHash == undefined) throw new Error(`Deploy transaction for ${contractName} not defined`);

        let artifact = NotionalDeployer.loadArtifact(contractName);
        artifact = NotionalDeployer.link(artifact, this.libraries);
        const localBytecodeHash = ethers.utils.keccak256(artifact.bytecode);

        if (bytecodeHash == localBytecodeHash) {
            log(`Bytecode unchanged for ${contractName}, do not deploy`);
            return false;
        }

        return true;
    }

    private async upgradeDeployLogic(contractName: string) {
        log("Deploying new logic contract");
        const {contract: upgrade, bytecodeHash: newBytecodeHash} = await NotionalDeployer.deployContract(
            this.owner,
            contractName,
            [],
            this.defaultConfirmations,
            this.libraries
        );
        this.deployedCodeHash.set(contractName, newBytecodeHash);

        log(`Deployed new logic contract at ${upgrade.address}`);

        return upgrade;
    }

    private async upgradeProxy(contractName: string, proxyAddress: string, newLogicAddress: string, dryRun: boolean) {
        const proxyAdminOwner = await this.proxyAdmin.owner();
        if (dryRun) {
            log(`Did not upgrade ${contractName} proxy at ${proxyAddress} to new logic address ${newLogicAddress}, dry run.`)
            return;
        }

        if (proxyAdminOwner != this.owner.address) {
            log(`Cannot upgrade proxy, must use proxyAdmin owner address ${proxyAdminOwner}`);
        } else {
            const proxy = new ethers.Contract(proxyAddress, AdminUpgradeabilityProxyArtifact.abi, this.owner) as AdminUpgradeabilityProxy;
            await NotionalDeployer.txMined(this.proxyAdmin.upgrade(proxy.address, newLogicAddress), this.defaultConfirmations);
            log(`Proxy Admin upgraded ${contractName}`);
        }
    }

    private transferOwnerOfContract = async (address: string, newOwner: string) => {
        const ownable = new Contract(address, OpenZeppelinUpgradesOwnableArtifact.abi, this.owner) as OpenZeppelinUpgradesOwnable;

        log(`Transfering ownership of contract at ${address} to ${newOwner}`);
        await NotionalDeployer.txMined(ownable.transferOwnership(newOwner), this.defaultConfirmations);
    }

    public transferOwner = async (newOwner: string) => {
        log(`Transfering ownership of Escrow`);
        await this.transferOwnerOfContract(this.escrow.address, newOwner);

        log(`Transfering ownership of Portfolios`);
        await this.transferOwnerOfContract(this.portfolios.address, newOwner);

        log(`Transfering ownership of Directory`);
        await this.transferOwnerOfContract(this.directory.address, newOwner);

        log(`Transfering ownership of ERC1155 Token`);
        await this.transferOwnerOfContract(this.erc1155.address, newOwner);

        log(`Transfering ownership of ERC1155 Trade`);
        await this.transferOwnerOfContract(this.erc1155trade.address, newOwner);

        const maxId = await this.portfolios.currentCashGroupId();
        for (let i = 1; i <= maxId; i++) {
            const group = await this.portfolios.cashGroups(i);
            log(`Transferring ownership of Cash Group: ${i}`);
            await this.transferOwnerOfContract(group.cashMarket, newOwner);
        }

        log(`Transfering ownership of ProxyAdmin`);
        // This allows newOwner to upgrade proxies
        await this.transferOwnerOfContract(this.proxyAdmin.address, newOwner);
    }

    public static restoreFromFile = async (path: string, owner: Wallet) => {
        const addresses = JSON.parse(readFileSync(path, "utf8"));

        const escrow = new Contract(addresses.escrow, EscrowArtifact.abi, owner) as Escrow;
        const portfolios = new Contract(addresses.portfolios, PortfoliosArtifact.abi, owner) as Portfolios;
        const proxyAdmin = new Contract(addresses.proxyAdmin, ProxyAdminArtifact.abi, owner) as ProxyAdmin;
        const createProxyFactory = new Contract(addresses.proxyFactory, CreateProxyFactoryArtifact.abi, owner) as CreateProxyFactory;
        const directory = new Contract(addresses.directory, DirectoryArtifact.abi, owner) as Directory;
        const erc1155 = new Contract(addresses.erc1155, ERC1155TokenArtifact.abi, owner) as ERC1155Token;
        const erc1155trade = new Contract(addresses.erc1155trade, ERC1155TradeArtifact.abi, owner) as ERC1155Trade;
        const cashMarketLogicAddress = addresses.cashMarketLogic as string;
        const libraries = Object.keys(addresses.libraries).reduce((obj, name) => {
            const contract = new Contract(addresses.libraries[name], NotionalDeployer.loadArtifact(name).abi, owner);
            obj.set(name, contract);
            return obj;
        }, new Map<string, Contract>())

        const deployedCodeHash = Object.keys(addresses.deployedCodeHash).reduce((obj, name) => {
            obj.set(name, addresses.deployedCodeHash[name]);
            return obj;
        }, new Map<string, string>())

        return new NotionalDeployer(
            owner,
            escrow,
            portfolios,
            owner.provider,
            proxyAdmin,
            createProxyFactory,
            directory,
            erc1155,
            erc1155trade,
            cashMarketLogicAddress,
            addresses.startBlock,
            libraries,
            deployedCodeHash,
            addresses.defaultConfirmations
        );
    };

    public async saveAddresses(path: string) {
        const network = await this.owner.provider.getNetwork();
        const libraries = Array.from(this.libraries.entries()).reduce((obj, [name, contract]) => {
            obj[name] = contract.address;
            return obj;
        }, {} as {[name: string]: string})

        const deployedCodeHash = Array.from(this.deployedCodeHash.entries()).reduce((obj, [name, hash]) => {
            obj[name] = hash;
            return obj;
        }, {} as {[name: string]: string})

        const gitHash = require('child_process')
            .execSync('git rev-parse HEAD')
            .toString().trim()

        const addresses = {
            chainId: network.chainId,
            networkName: network.name,
            escrow: this.escrow.address,
            portfolios: this.portfolios.address,
            proxyAdmin: this.proxyAdmin.address,
            proxyFactory: this.proxyFactory.address,
            directory: this.directory.address,
            erc1155: this.erc1155.address,
            erc1155trade: this.erc1155trade.address,
            cashMarketLogic: this.cashMarketLogicAddress,
            startBlock: this.startBlock,
            defaultConfirmations: this.defaultConfirmations,
            libraries: libraries,
            deployedCodeHash: deployedCodeHash,
            gitHash: gitHash
        };
        writeFileSync(path, JSON.stringify(addresses, null, 2));
    }
}
