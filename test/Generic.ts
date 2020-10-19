import chai from "chai";
import { solidity, deployContract } from "ethereum-waffle";
import { fixture, wallets, fixtureLoader, provider, fastForwardToMaturity } from "./fixtures";
import { Wallet, ethers } from "ethers";
import { WeiPerEther, AddressZero } from "ethers/constants";

import {Ierc20 as ERC20} from "../typechain/Ierc20";
import { CashMarket } from "../typechain/CashMarket";
import { ProxyAdmin } from "../typechain/ProxyAdmin";
import FutureCashArtifact from "../build/CashMarket.json";
import { Escrow } from "../typechain/Escrow";
import AdminUpgradeabilityProxyArtifact from "../build/AdminUpgradeabilityProxy.json";
import { AdminUpgradeabilityProxy } from "../typechain/AdminUpgradeabilityProxy";
import { ErrorDecoder, ErrorCodes } from "../scripts/errorCodes";
import { Portfolios } from "../typechain/Portfolios";
import { BLOCK_TIME_LIMIT } from "./testUtils";
import { parseEther } from 'ethers/utils';

chai.use(solidity);
const { expect } = chai;

describe("Generic Tests", () => {
    let dai: ERC20;
    let futureCash: CashMarket;
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
        futureCash = objs.cashMarket;
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
            0, 100_000_000, 
            BLOCK_TIME_LIMIT
        );
        const futureCashProxy = new ethers.Contract(
            futureCash.address,
            AdminUpgradeabilityProxyArtifact.abi,
            owner
        ) as AdminUpgradeabilityProxy;

        const futureCashUpgrade = (await deployContract(owner, FutureCashArtifact, [], {
            gasLimit: 6000000
        })) as CashMarket;
        await expect(proxyAdmin.upgrade(futureCash.address, futureCashUpgrade.address))
            .to.emit(futureCashProxy, "Upgraded")
            .withArgs(futureCashUpgrade.address);

        const markets = await futureCash.markets(maturities[0]);
        expect(markets.totalCurrentCash).to.equal(WeiPerEther.mul(10000));
        expect(markets.totalLiquidity).to.equal(WeiPerEther.mul(10000));
        expect(markets.totalfCash).to.equal(WeiPerEther.mul(10000));
    });

    it("does not allow wallets to call protected functions on escrow", async () => {
        await expect(escrow.connect(wallet).listCurrency(AddressZero,  {isERC777: false, hasTransferFee: false })).to.be.reverted;
        await expect(escrow.connect(wallet).setReserveAccount(AddressZero)).to.be.reverted;
        await expect(escrow.connect(wallet).setDiscounts(WeiPerEther, WeiPerEther, WeiPerEther)).to.be.reverted;
        await expect(escrow.connect(wallet).addExchangeRate(0, 0, AddressZero, WeiPerEther, WeiPerEther, false)).to.be.reverted;

        await expect(escrow.connect(wallet).setLiquidityHaircut(WeiPerEther)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );
        await expect(escrow.connect(wallet).unlockCurrentCash(2, futureCash.address, WeiPerEther)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );
        await expect(escrow.connect(wallet).portfolioSettleCash(wallet.address, [WeiPerEther])).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );

        await expect(
            escrow.connect(wallet).depositsOnBehalf(wallet.address, [{ currencyId: 1, amount: parseEther("1") }])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(
            escrow.connect(wallet).withdrawsOnBehalf(wallet.address, [{ to: wallet.address, currencyId: 1, amount: parseEther("1")}])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

        await expect(
            escrow.connect(wallet).withdrawFromMarket(wallet.address, 1, WeiPerEther, 0)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(
            escrow.connect(wallet).depositIntoMarket(wallet.address, 1, WeiPerEther, 0)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
    });

    it("does not allow wallets to call protected functions on fCash", async () => {
        await expect(futureCash.connect(wallet).setParameters(1, 0, 1e9, 1000, 4, 0)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );
        await expect(
            futureCash.connect(wallet).settleLiquidityToken(wallet.address, WeiPerEther, maturities[0])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

        await expect(
            futureCash.connect(wallet).tradeCashReceiver(wallet.address, WeiPerEther, WeiPerEther, maturities[0])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(
            futureCash.connect(wallet).tradeLiquidityToken(WeiPerEther, WeiPerEther, maturities[0])
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

        await expect(
            futureCash.connect(wallet).takeCurrentCashOnBehalf(wallet.address, maturities[0], WeiPerEther, 100_000_000)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(
            futureCash.connect(wallet).takefCashOnBehalf(wallet.address, maturities[0], WeiPerEther, 0)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(
            futureCash.connect(wallet).addLiquidityOnBehalf(wallet.address, maturities[0], WeiPerEther, WeiPerEther, 0, 100_000_00)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(
            futureCash.connect(wallet).removeLiquidityOnBehalf(wallet.address, maturities[0], WeiPerEther)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
    });

    it("does not allow wallets to call protected functions on portfolios", async () => {
        await expect(portfolios.connect(wallet).setNumCurrencies(3)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );
        await expect(
            portfolios
                .connect(wallet)
                .transferAccountAsset(wallet.address, AddressZero, "0x00", 1, 0, 1000, WeiPerEther)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));
        await expect(portfolios.connect(wallet).freeCollateralFactors(wallet.address, 1, 0)).to.be.revertedWith(
            ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER)
        );

        await expect(
            portfolios.connect(wallet).raiseCurrentCashViaLiquidityToken(wallet.address, 1, WeiPerEther)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

        await expect(
            portfolios.connect(wallet).upsertAccountAsset(wallet.address, {
                cashGroupId: 1,
                instrumentId: 0,
                maturity: 1000,
                rate: 1e9,
                notional: WeiPerEther,
                assetType: "0x98"
            }, true)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

        await expect(
            portfolios.connect(wallet).upsertAccountAssetBatch(wallet.address, [
                {
                    cashGroupId: 1,
                    instrumentId: 0,
                    maturity: 1000,
                    rate: 1e9,
                    notional: WeiPerEther,
                    assetType: "0x98"
                }
            ], true)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

        await expect(
            portfolios.connect(wallet).upsertAccountAssetBatch(wallet.address, [
                {
                    cashGroupId: 1,
                    instrumentId: 0,
                    maturity: 1000,
                    rate: 1e9,
                    notional: WeiPerEther,
                    assetType: "0x98"
                },
                {
                    cashGroupId: 2,
                    instrumentId: 0,
                    maturity: 1000,
                    rate: 1e9,
                    notional: WeiPerEther,
                    assetType: "0x98"
                }
            ], true)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.INVALID_ASSET_BATCH));

        await expect(
            portfolios.connect(wallet).mintfCashPair(
                wallet.address,
                owner.address,
                1,
                1000,
                WeiPerEther
            )
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

        // This takes a little work to ensure that we get the right revert
        const maturities = await futureCash.getActiveMaturities();
        await escrow.deposit(dai.address, parseEther("1000"));
        await futureCash.addLiquidity(maturities[0], parseEther("1000"), parseEther("1000"), 0, 100_000_000, BLOCK_TIME_LIMIT);
        await escrow.connect(wallet).deposit(dai.address, parseEther("1"));
        await futureCash.connect(wallet).takefCash(maturities[0], parseEther("1"), BLOCK_TIME_LIMIT, 0);
        await expect(
            portfolios.connect(wallet).raiseCurrentCashViaCashReceiver(wallet.address, owner.address, 1, WeiPerEther)
        ).to.be.revertedWith(ErrorDecoder.decodeError(ErrorCodes.UNAUTHORIZED_CALLER));

    });
});
