import {Wallet} from "ethers";
import {JsonRpcProvider} from "ethers/providers";
import {SwapnetLite} from "./SwapnetLite";
import { WeiPerEther } from 'ethers/constants';
import { BigNumber } from 'ethers/utils';

async function main() {
    let owner = new Wallet(
        "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d",
        new JsonRpcProvider("http://localhost:8545")
    );
    const prereqs = await SwapnetLite.deployPrerequisites(owner);
    const swapnet = await SwapnetLite.deploy(owner, prereqs.registry.address);

    await swapnet.deployMockCurrency(
        prereqs.uniswapFactory,
        WeiPerEther.div(100),
        WeiPerEther.div(100).mul(30),
    );

    await swapnet.deployFutureCashMarket(
        2,
        4,
        40,
        WeiPerEther.mul(10_000),
        new BigNumber(0),
        new BigNumber(0)
    )

    swapnet.saveAddresses("contracts.json");
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
