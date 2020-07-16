import chai from "chai";
import { solidity, deployContract } from "ethereum-waffle";
import { fixture, wallets, fixtureLoader, provider, fastForwardToMaturity } from "./fixtures";
import { Wallet, ethers } from "ethers";
import { WeiPerEther, AddressZero } from "ethers/constants";

import { Erc20 as ERC20 } from "../typechain/Erc20";
import { FutureCash } from "../typechain/FutureCash";
import { ProxyAdmin } from "../typechain/ProxyAdmin";
import FutureCashArtifact from "../build/FutureCash.json";
import { Escrow } from "../typechain/Escrow";
import AdminUpgradeabilityProxyArtifact from "../build/AdminUpgradeabilityProxy.json";
import { AdminUpgradeabilityProxy } from "../typechain/AdminUpgradeabilityProxy";
import { ErrorDecoder, ErrorCodes } from "../scripts/errorCodes";
import { Portfolios } from "../typechain/Portfolios";
import { BLOCK_TIME_LIMIT } from "./testUtils";

chai.use(solidity);
const { expect } = chai;

describe("Generic Tests", () => {
    let dai: ERC20;
    let futureCash: FutureCash;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let rateAnchor: number;
    let proxyAdmin: ProxyAdmin;
    let maturities: number[];

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;
        proxyAdmin = objs.proxyAdmin;
        escrow = objs.escrow;
        portfolios = objs.portfolios;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);

        // Set the blockheight to the beginning of the next period
        maturities = await futureCash.getActiveMaturities();
        await fastForwardToMaturity(provider, maturities[1]);
        maturities = await futureCash.getActiveMaturities();
    });

    it("allows upgrades to the contracts without losing access to previous storage", async () => {
        let maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, WeiPerEther.mul(10_000));
        await futureCash.addLiquidity(
            maturities[0],
            WeiPerEther.mul(10_000),
            WeiPerEther.mul(10_000),
            BLOCK_TIME_LIMIT
        );
        const futureCashProxy = new ethers.Contract(
            futureCash.address,
            AdminUpgradeabilityProxyArtifact.abi,
            owner
        ) as AdminUpgradeabilityProxy;

        const futureCashUpgrade = (await deployContract(owner, FutureCashArtifact, [], {
            gasLimit: 6000000
        })) as FutureCash;
        await expect(proxyAdmin.upgrade(futureCash.address, futureCashUpgrade.address))
            .to.emit(futureCashProxy, "Upgraded")
            .withArgs(futureCashUpgrade.address);

        const markets = await futureCash.markets(maturities[0]);
        expect(markets.totalCollateral).to.equal(WeiPerEther.mul(10000));
        expect(markets.totalLiquidity).to.equal(WeiPerEther.mul(10000));
        expect(markets.totalFutureCash).to.equal(WeiPerEther.mul(10000));
    });

    it("does not allow wallets to call protected functions on escrow", async () => {
        await expect(escrow.connect(wallet).unlockCollateral(2, futureCash.address, WeiPerEther)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );
        await expect(escrow.connect(wallet).portfolioSettleCash(wallet.address, [WeiPerEther])).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );

        await expect(
            escrow.connect(wallet).withdrawFromMarket(wallet.address, dai.address, 1, WeiPerEther, 0)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(
            escrow.connect(wallet).depositIntoMarket(wallet.address, dai.address, 1, WeiPerEther, 0)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
    });

    it("does not allow wallets to call protected functions on future cash", async () => {
        await expect(futureCash.connect(wallet).setParameters(1, 0, 1e9, 1000, 4, 0)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );
        await expect(
            futureCash.connect(wallet).settleLiquidityToken(wallet.address, WeiPerEther, maturities[0])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

        await expect(
            futureCash.connect(wallet).tradeCashPayer(WeiPerEther, WeiPerEther, maturities[0])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(
            futureCash.connect(wallet).tradeCashReceiver(wallet.address, WeiPerEther, WeiPerEther, maturities[0])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(
            futureCash.connect(wallet).tradeLiquidityToken(WeiPerEther, WeiPerEther, maturities[0])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
    });

    it("does not allow wallets to call protected functions on portfolios", async () => {
        await expect(portfolios.connect(wallet).setNumCurrencies(3)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );
        await expect(
            portfolios
                .connect(wallet)
                .transferAccountAsset(wallet.address, AddressZero, "0x00", 1, 0, 1000, 40, WeiPerEther)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(portfolios.connect(wallet).freeCollateralNoEmit(wallet.address)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );

        await expect(
            portfolios.connect(wallet).raiseCollateralViaCashReceiver(wallet.address, 1, WeiPerEther)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(
            portfolios.connect(wallet).raiseCollateralViaLiquidityToken(wallet.address, 1, WeiPerEther)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(portfolios.connect(wallet).repayCashPayer(wallet.address, 1, WeiPerEther)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );

        await expect(
            portfolios.connect(wallet).upsertAccountAsset(wallet.address, {
                futureCashGroupId: 1,
                instrumentId: 0,
                startTime: 1000,
                duration: 40,
                rate: 1e9,
                notional: WeiPerEther,
                swapType: "0x98"
            })
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

        await expect(
            portfolios.connect(wallet).upsertAccountAssetBatch(wallet.address, [
                {
                    futureCashGroupId: 1,
                    instrumentId: 0,
                    startTime: 1000,
                    duration: 40,
                    rate: 1e9,
                    notional: WeiPerEther,
                    swapType: "0x98"
                }
            ])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

        await expect(
            portfolios.connect(wallet).upsertAccountAssetBatch(wallet.address, [
                {
                    futureCashGroupId: 1,
                    instrumentId: 0,
                    startTime: 1000,
                    duration: 40,
                    rate: 1e9,
                    notional: WeiPerEther,
                    swapType: "0x98"
                },
                {
                    futureCashGroupId: 2,
                    instrumentId: 0,
                    startTime: 1000,
                    duration: 40,
                    rate: 1e9,
                    notional: WeiPerEther,
                    swapType: "0x98"
                }
            ])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
    });
});
