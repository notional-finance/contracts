import {Wallet, ContractFactory, Contract} from "ethers";
import {UniswapExchangeInterface} from "../typechain/UniswapExchangeInterface";
import {ERC20} from "../typechain/ERC20";
import {FutureCash} from "../typechain/FutureCash";

import ERC20Artifact from "../build/ERC20.json";
import FutureCashArtifact from "../build/FutureCash.json";
import UniswapFactoryArtifact from "../uniswap/UniswapFactory.json";
import UniswapExchangeArtifact from "../uniswap/UniswapExchange.json";
import {UniswapFactoryInterface} from "../typechain/UniswapFactoryInterface";
import {JsonRpcProvider, Provider} from "ethers/providers";
import {readFileSync, writeFileSync} from "fs";

export class SwapnetLite {
    constructor(
        public owner: Wallet,
        public uniswap: UniswapExchangeInterface,
        public dai: ERC20,
        public futureCash: FutureCash,
        public provider: Provider
    ) {}

    private static deployContract = async (owner: Wallet, artifact: any, args: any[]) => {
        const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
        let contract = await factory.deploy(...args);
        await contract.deployed();

        return contract;
    };

    public static deployUniswap = async (owner: Wallet) => {
        let uniswapTemplate = await SwapnetLite.deployContract(owner, UniswapExchangeArtifact, []);
        let uniswapFactory = (await SwapnetLite.deployContract(
            owner,
            UniswapFactoryArtifact,
            []
        )) as UniswapFactoryInterface;
        await uniswapFactory.initializeFactory(uniswapTemplate.address);

        return uniswapFactory.address;
    };

    public static deploy = async (owner: Wallet, periodSize: number, uniswapFactoryAddress: string) => {
        let dai = (await SwapnetLite.deployContract(owner, ERC20Artifact, [])) as ERC20;
        let uniswapFactory = new Contract(
            uniswapFactoryAddress,
            UniswapFactoryArtifact.abi,
            owner
        ) as UniswapFactoryInterface;
        await uniswapFactory.createExchange(dai.address, {gasLimit: 5000000});

        let uniswap = new Contract(
            await uniswapFactory.getExchange(dai.address),
            UniswapExchangeArtifact.abi,
            owner
        ) as UniswapExchangeInterface;

        let futureCash = (await SwapnetLite.deployContract(owner, FutureCashArtifact, [
            periodSize,
            dai.address,
            uniswap.address
        ])) as FutureCash;

        return new SwapnetLite(owner, uniswap, dai, futureCash, owner.provider);
    };

    public static restoreFromFile = (path: string, provider: JsonRpcProvider) => {
        let addresses = JSON.parse(readFileSync(path, "utf8"));

        let owner = new Wallet(addresses.owner, provider);
        let uniswap = new Contract(addresses.uniswap, UniswapExchangeArtifact.abi, owner) as UniswapExchangeInterface;
        let dai = new Contract(addresses.dai, ERC20Artifact.abi, owner) as ERC20;
        let futureCash = new Contract(addresses.futureCash, FutureCashArtifact.abi, owner) as FutureCash;

        return new SwapnetLite(owner, uniswap, dai, futureCash, provider);
    };

    public saveAddresses(path: string) {
        writeFileSync(
            path,
            JSON.stringify(
                {
                    owner: this.owner.privateKey,
                    uniswap: this.uniswap.address,
                    dai: this.dai.address,
                    futureCash: this.futureCash.address
                },
                null,
                2
            )
        );
    }
}
