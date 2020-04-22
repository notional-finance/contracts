import {Wallet} from "ethers";
import {JsonRpcProvider} from "ethers/providers";
import {SwapnetLite} from "./SwapnetLite";

async function main() {
    let owner = new Wallet(
        "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d",
        new JsonRpcProvider("http://localhost:8545")
    );
    let uniswapFactory = await SwapnetLite.deployUniswap(owner);
    let swapnet = await SwapnetLite.deploy(owner, 40, uniswapFactory);

    swapnet.saveAddresses("contracts.json");
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
