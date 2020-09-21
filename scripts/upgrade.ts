import {NotionalDeployer, CoreContracts} from "./NotionalDeployer";
import {config} from "dotenv";
import Debug from "debug";
import { Wallet } from "ethers";
import { JsonRpcProvider } from "ethers/providers";

import EscrowArtifact from "../build/Escrow.json";
import ERC1155TokenArtifact from "../build/ERC1155Token.json";
import ERC1155TradeArtifact from "../build/ERC1155Trade.json";
import PortfoliosArtifact from "../build/Portfolios.json";

const log = Debug("notional:upgrade");

async function main() {
    const envPath = `${process.env.DOTENV_CONFIG_PATH}`
    log(`Loading enviromnent from ${envPath} from ${process.cwd()}`);
    config({path: envPath});

    const chainId = process.env.DEPLOY_CHAIN_ID as string;
    log(`Upgrading on ${chainId} using ${process.env.TESTNET_PROVIDER}`);
    const owner = new Wallet(
        process.env.TESTNET_PRIVATE_KEY as string,
        new JsonRpcProvider(process.env.TESTNET_PROVIDER)
    );

    const notional = await NotionalDeployer.restoreFromFile(process.env.CONTRACTS_FILE as string, owner);

    log(`Upgrading Escrow contract on chain: ${chainId}`);
    await notional.upgradeContract(CoreContracts.Escrow, EscrowArtifact);
    log(`Upgrading ERC1155 Token contract on chain: ${chainId}`);
    await notional.upgradeContract(CoreContracts.ERC1155Token, ERC1155TokenArtifact);
    log(`Upgrading ERC1155 Trade contract on chain: ${chainId}`);
    await notional.upgradeContract(CoreContracts.ERC1155Trade, ERC1155TradeArtifact);
    log(`Upgrading Portfolios contract on chain: ${chainId}`);
    await notional.upgradeContract(CoreContracts.Portfolios, PortfoliosArtifact);
    log(`Completed at block height ${await owner.provider.getBlockNumber()}`);

    // TODO: upgrading future cash contracts
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
