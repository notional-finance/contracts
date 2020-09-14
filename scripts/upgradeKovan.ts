import {NotionalDeployer, CoreContracts} from "./NotionalDeployer";
import {config} from "dotenv";
import Debug from "debug";
import { Wallet } from "ethers";
import { JsonRpcProvider } from "ethers/providers";

import EscrowArtifact from "../build/Escrow.json";
import ERC1155TokenArtifact from "../build/ERC1155Token.json";
import PortfoliosArtifact from "../build/Portfolios.json";

const log = Debug("subgraph:deployKovan");
const envPath = `${process.env.DOTENV_CONFIG_PATH}`
log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
config({path: envPath});

async function main() {
    log(`Upgrading to kovan testnet using ${process.env.TESTNET_PROVIDER}`);
    const owner = new Wallet(
        process.env.TESTNET_PRIVATE_KEY as string,
        new JsonRpcProvider(process.env.TESTNET_PROVIDER)
    );

    const notional = await NotionalDeployer.restoreFromFile(process.env.CONTRACTS_FILE as string, owner);

    log(`Upgrading Escrow contract on kovan testnet`);
    await notional.upgradeContract(CoreContracts.Escrow, EscrowArtifact);
    log(`Upgrading ERC1155 Token contract on kovan testnet`);
    await notional.upgradeContract(CoreContracts.ERC1155Token, ERC1155TokenArtifact);
    log(`Upgrading Portfolios contract on kovan testnet`);
    await notional.upgradeContract(CoreContracts.Portfolios, PortfoliosArtifact);
    log(`Completed at block height ${await owner.provider.getBlockNumber()}`);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
