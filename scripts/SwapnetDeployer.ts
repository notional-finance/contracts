import {Provider} from "ethers/providers";
import {readFileSync, writeFileSync} from "fs";
import {BigNumber} from "ethers/utils";
import {Wallet, ContractFactory, Contract, ethers} from "ethers";
import { WeiPerEther } from 'ethers/constants';

import DirectoryArtifact from "../build/Directory.json";
import EscrowArtifact from "../build/Escrow.json";
import PortfoliosArtifact from "../build/Portfolios.json";
import ERC1155TokenArtifact from "../build/ERC1155Token.json";
import ERC1155TradeArtifact from "../build/ERC1155Trade.json";
import ProxyAdminArtifact from "../build/ProxyAdmin.json";
import AdminUpgradeabilityProxyArtifact from "../build/AdminUpgradeabilityProxy.json";
import OpenZeppelinUpgradesOwnableArtifact from "../build/OpenZeppelinUpgradesOwnable.json";

import {Portfolios} from "../typechain/Portfolios";
import {Escrow} from "../typechain/Escrow";
import {ProxyAdmin} from "../typechain/ProxyAdmin";
import {Directory} from "../typechain/Directory";
import {Ierc20 as ERC20} from "../typechain/Ierc20";
import {FutureCash} from "../typechain/FutureCash";
import {Erc1155Token as ERC1155Token} from "../typechain/Erc1155Token";
import {Erc1155Trade as ERC1155Trade} from "../typechain/Erc1155Trade";
import { Ierc1820Registry as IERC1820Registry } from "../typechain/Ierc1820Registry";
import { Iweth as IWETH } from '../typechain/Iweth';
import { IAggregator } from '../typechain/IAggregator';
import { OpenZeppelinUpgradesOwnable } from '../typechain/OpenZeppelinUpgradesOwnable';

import Debug from "debug";
import path from "path";
const log = Debug("swapnet:deploy");

export interface Environment {
    deploymentWallet: Wallet,
    WETH: IWETH;
    ERC1820: IERC1820Registry;
    DAI: ERC20;
    USDC: ERC20;
    DAIETHOracle: IAggregator;
    USDCETHOracle: IAggregator;
}

// This is a mirror of the enum in Governed
export const enum CoreContracts {
    Escrow = 0,
    Portfolios,
    ERC1155Token,
    ERC1155Trade
}

export class SwapnetDeployer {
    constructor(
        public owner: Wallet,
        public escrow: Escrow,
        public portfolios: Portfolios,
        public provider: Provider,
        public proxyAdmin: ProxyAdmin,
        public directory: Directory,
        public erc1155: ERC1155Token,
        public erc1155trade: ERC1155Trade,
        public startBlock: number,
        public libraries: Map<string, Contract>,
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
                log(`Linking ${libname} into ${artifact.contractName}`)
                const byteOffsetStart = offset.start * 2 + 2;
                const byteOffsetEnd = byteOffsetStart + offset.length * 2;
                artifact.bytecode = artifact.bytecode.substring(0, byteOffsetStart) +
                    contract.address.substr(2) + 
                    artifact.bytecode.substring(byteOffsetEnd);
            }
        }
    }

    public static deployContract = async (
        owner: Wallet,
        artifact: any,
        args: any[],
        libraries?: Map<string, Contract>
    ) => {
        let gasLimit;
        if (process.env.COVERAGE == "true") {
            gasLimit = 20_000_000;
        } else if (process.env.GAS_LIMIT != null) {
            gasLimit = parseInt(process.env.GAS_LIMIT);
        } else {
            gasLimit = 6_000_000;
        }

        if (Object.keys(artifact.linkReferences).length > 0) {
            if (libraries == null) throw new Error(`Libraries not defined for ${artifact.contractName}`);
            SwapnetDeployer.link(artifact, libraries);
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
        ethToETHHaircut: BigNumber,
        liquidationDiscount: BigNumber,
        settlementDiscount: BigNumber,
        liquidityHaircut: BigNumber,
        repoDiscount: BigNumber,
        confirmations = 3
    ) => {
        const startBlock = await owner.provider.getBlockNumber();
        const libraries = new Map<string, Contract>();
        
        libraries.set("Liquidation", (await SwapnetDeployer.deployContract(
            owner,
            SwapnetDeployer.loadArtifact("Liquidation"),
            []
        )));

        libraries.set("RiskFramework", (await SwapnetDeployer.deployContract(
            owner,
            SwapnetDeployer.loadArtifact("RiskFramework"),
            []
        )));

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
            [directory.address, environment.ERC1820.address, environment.WETH.address, ethToETHHaircut],
            proxyAdmin,
            libraries
        );

        const INIT_NUM_CURRENCIES = 1;
        const portfolios = await SwapnetDeployer.deployProxyContract<Portfolios>(
            owner,
            SwapnetDeployer.loadArtifact("Portfolios"),
            "address,uint16,uint256",
            [directory.address, INIT_NUM_CURRENCIES, maxAssets],
            proxyAdmin,
            libraries
        );

        // If these need to be upgraded we will change the directory. Neither holds state so there is no
        // need for them to be proxies.
        const erc1155 = await SwapnetDeployer.deployContract(
            owner,
            SwapnetDeployer.loadArtifact("ERC1155Token"),
            [directory.address]
        ) as ERC1155Token;

        const erc1155trade = await SwapnetDeployer.deployContract(
            owner,
            SwapnetDeployer.loadArtifact("ERC1155Trade"),
            [directory.address]
        ) as ERC1155Trade;

        // Set dependencies
        log("Setting Swapnet Contract: Escrow");
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.Escrow, escrow.address), confirmations);
        log("Setting Swapnet Contract: Portfolios");
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.Portfolios, portfolios.address), confirmations);
        log("Setting Swapnet Contract: ERC1155Token");
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.ERC1155Token, erc1155.address), confirmations);
        log("Setting Swapnet Contract: ERC1155Trade");
        await SwapnetDeployer.txMined(directory.setContract(CoreContracts.ERC1155Trade, erc1155trade.address), confirmations);

        log("Setting Swapnet Dependencies: Escrow Dependency");
        await SwapnetDeployer.txMined(directory.setDependencies(CoreContracts.Escrow, [
            CoreContracts.Portfolios,
            CoreContracts.ERC1155Trade,
        ]), confirmations);
        log("Setting Swapnet Dependencies: ERC1155Token Dependency");
        await SwapnetDeployer.txMined(
            directory.setDependencies(CoreContracts.ERC1155Token, [CoreContracts.Portfolios]),
            confirmations
        );
        log("Setting Swapnet Dependencies: ERC1155Trade Dependency");
        await SwapnetDeployer.txMined(
            directory.setDependencies(CoreContracts.ERC1155Trade, [CoreContracts.Portfolios, CoreContracts.Escrow]),
            confirmations
        );
        log("Setting Swapnet Dependencies: Portfolio Dependency");
        await SwapnetDeployer.txMined(
            directory.setDependencies(CoreContracts.Portfolios, [
                CoreContracts.Escrow,
                CoreContracts.ERC1155Token,
                CoreContracts.ERC1155Trade
            ]),
            confirmations
        );

        // Setup some contract defaults
        log("Setting liquidation discounts");
        await SwapnetDeployer.txMined(escrow.setDiscounts(liquidationDiscount, settlementDiscount, repoDiscount), confirmations);

        log("Setting liquidity haircut");
        await SwapnetDeployer.txMined(portfolios.setHaircut(liquidityHaircut), confirmations);

        return new SwapnetDeployer(
            owner,
            escrow,
            portfolios,
            owner.provider,
            proxyAdmin,
            directory,
            erc1155,
            erc1155trade,
            startBlock,
            libraries,
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
        await SwapnetDeployer.txMined(this.escrow.listCurrency(tokenAddress, { isERC777, hasTransferFee }), this.defaultConfirmations);
        const currencyId = (await this.escrow.addressToCurrencyId(tokenAddress)) as number;

        log("Registering new exchange rate to ETH");
        if (haircut.lt(WeiPerEther)) {
            throw new Error("Haircut must be greater than 1e18");
        }

        await SwapnetDeployer.txMined(
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

    public deployFutureCashMarket = async (
        currencyId: number,
        numPeriods: number,
        periodSize: number,
        maxTradeSize: BigNumber,
        liquidityFee: BigNumber,
        transactionFee: BigNumber,
        rateAnchor: number,
        rateScalar: number,
        precision: number = 1e9,
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
                futureCash.address
            ), this.defaultConfirmations
        );

        log("Setting future cash parameters...");
        await SwapnetDeployer.txMined(futureCash.setMaxTradeSize(maxTradeSize), this.defaultConfirmations);
        await SwapnetDeployer.txMined(futureCash.setFee(liquidityFee, transactionFee), this.defaultConfirmations);
        await SwapnetDeployer.txMined(futureCash.setRateFactors(rateAnchor, rateScalar), this.defaultConfirmations);

        return futureCash;
    };

    public upgradeContract = async (name: CoreContracts, artifact: any) => {
        const contract = this.coreContractToContract(name);
        const proxy = new ethers.Contract(contract.address, AdminUpgradeabilityProxyArtifact.abi, this.owner);

        // Deploy the upgraded logic contract
        log("Deploying new logic contract");
        const upgrade = await SwapnetDeployer.deployContract(this.owner, artifact, []);
        log(`Deployed new logic contract at ${upgrade.address}`);
        await SwapnetDeployer.txMined(this.proxyAdmin.upgrade(proxy.address, upgrade.address), this.defaultConfirmations);
        log(`Proxy Admin upgraded ${name.toString()}`);
    };

    private transferOwnerOfContract = async (address: string, newOwner: string) => {
        const ownable = new Contract(address, OpenZeppelinUpgradesOwnableArtifact.abi, this.owner) as OpenZeppelinUpgradesOwnable;

        log(`Transfering ownership of contract at ${address} to ${newOwner}`);
        await SwapnetDeployer.txMined(ownable.transferOwnership(newOwner), this.defaultConfirmations);
    }

    public transferOwner = async (newOwner: string) => {
        log(`Transfering ownership of Escrow`);
        await this.transferOwnerOfContract(this.escrow.address, newOwner);

        log(`Transfering ownership of Portfolios`);
        await this.transferOwnerOfContract(this.portfolios.address, newOwner);

        log(`Transfering ownership of Directory`);
        await this.transferOwnerOfContract(this.directory.address, newOwner);

        const maxId = await this.portfolios.currentFutureCashGroupId();
        for (let i = 1; i <= maxId; i++) {
            const group = await this.portfolios.futureCashGroups(i);
            log(`Transferring ownership of Cash Group: ${i}`);
            await this.transferOwnerOfContract(group.futureCashMarket, newOwner);
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
            owner.provider,
            proxyAdmin,
            directory,
            erc1155,
            erc1155trade,
            addresses.startBlock,
            libraries,
            addresses.defaultConfirmations
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
            proxyAdmin: this.proxyAdmin.address,
            directory: this.directory.address,
            erc1155: this.erc1155.address,
            erc1155trade: this.erc1155trade.address,
            startBlock: this.startBlock,
            defaultConfirmations: this.defaultConfirmations,
            libraries: libraries
        };
        writeFileSync(path, JSON.stringify(addresses, null, 2));
    }
}
