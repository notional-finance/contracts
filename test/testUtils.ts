import { Escrow } from "../typechain/Escrow";
import { FutureCash } from "../typechain/FutureCash";
import { Portfolios } from "../typechain/Portfolios";
import { Wallet } from "ethers";
import { MockAggregator } from "../typechain/MockAggregator";
import { Erc20 as ERC20 } from "../typechain/Erc20";
import { WeiPerEther } from "ethers/constants";
import { BigNumber, parseEther } from "ethers/utils";
import { provider, CURRENCY, fastForwardToMaturity } from "./fixtures";
import {Iweth as IWETH} from "../typechain/Iweth";

// This will stop working in 2033 :)
export const BLOCK_TIME_LIMIT = 2_000_000_000;
export const IMPLIED_RATE_LIMIT = 60_000_000;
export enum SwapType {
    LIQUIDITY_TOKEN = "0xac",
    CASH_PAYER = "0x98",
    CASH_RECEIVER = "0xa8"
}

export class TestUtils {
    constructor(
        public escrow: Escrow,
        public futureCash: FutureCash,
        public portfolios: Portfolios,
        public dai: ERC20,
        public owner: Wallet,
        public chainlink: MockAggregator,
        public weth: IWETH
    ) {}

    public async setupLiquidity(
        lp = this.owner,
        targetProportion = 0.5,
        collateralAmount = WeiPerEther.mul(10_000),
        maturityOffsets = [0]
    ) {
        const maturities = await this.futureCash.getActiveMaturities();
        const futureCashAmount = collateralAmount.mul(targetProportion / (1 - targetProportion));

        for (let m of maturityOffsets) {
            await this.escrow.connect(lp).deposit(this.dai.address, collateralAmount);
            await this.futureCash
                .connect(lp)
                .addLiquidity(maturities[m], collateralAmount, futureCashAmount, 0, 100_000_000, BLOCK_TIME_LIMIT);
        }
    }

    public async borrowAndWithdraw(
        wallet: Wallet,
        borrowFutureCash: BigNumber,
        collateralRatio = 1.05,
        maturityOffset = 0,
        impliedRateLimit = IMPLIED_RATE_LIMIT
    ) {
        const exchangeRate = await this.chainlink.latestAnswer();
        const haircut = (await this.escrow.getExchangeRate(this.dai.address, this.weth.address)).haircut;
        const maturities = await this.futureCash.getActiveMaturities();

        const ethAmount = borrowFutureCash
            .mul(exchangeRate)
            .div(WeiPerEther)
            .mul(haircut)
            .div(WeiPerEther)
            .mul(parseEther(collateralRatio.toString()))
            .div(WeiPerEther);

        await this.escrow.connect(wallet).depositEth({value: ethAmount});
        const beforeAmount = await this.escrow.currencyBalances(this.dai.address, wallet.address);
        await this.futureCash
            .connect(wallet)
            .takeCollateral(maturities[maturityOffset], borrowFutureCash, BLOCK_TIME_LIMIT, impliedRateLimit);
        const collateralAmount = (await this.escrow.currencyBalances(this.dai.address, wallet.address)).sub(
            beforeAmount
        );

        // Remove the dai so only the ETH is collateralizing the CASH_PAYER
        await this.escrow.connect(wallet).withdraw(this.dai.address, collateralAmount);

        return [ethAmount, collateralAmount];
    }

    public async isCollateralized(account: Wallet) {
        const fc = await this.portfolios.freeCollateralView(account.address);
        return fc[0].gte(0);
    }

    public async checkEthBalanceIntegrity(accounts: Wallet[]) {
        const totalEthBalance = await this.weth.balanceOf(this.escrow.address);
        let escrowEthBalance = new BigNumber(0);
        for (let a of accounts) {
            escrowEthBalance = escrowEthBalance.add(await this.escrow.currencyBalances(this.weth.address, a.address));
        }

        return escrowEthBalance.eq(totalEthBalance);
    }

    public async checkBalanceIntegrity(accounts: Wallet[], additionalMarket?: string) {
        const totalDaiBalance = await this.dai.balanceOf(this.escrow.address);
        let escrowDaiBalance = new BigNumber(0);
        for (let a of accounts) {
            escrowDaiBalance = escrowDaiBalance.add(await this.escrow.currencyBalances(this.dai.address, a.address));
        }
        escrowDaiBalance = escrowDaiBalance.add(
            await this.escrow.currencyBalances(this.dai.address, this.futureCash.address)
        );

        if (additionalMarket !== undefined) {
            escrowDaiBalance = escrowDaiBalance.add(
                await this.escrow.currencyBalances(this.dai.address, additionalMarket)
            );
        }

        return totalDaiBalance.eq(escrowDaiBalance);
    }

    public async checkCashIntegrity(accounts: Wallet[], currencyId = CURRENCY.DAI) {
        const accountAddresses = accounts.map(w => w.address);
        await this.portfolios.settleAccountBatch(accountAddresses);

        let totalCashBalance = new BigNumber(0);
        for (let a of accountAddresses) {
            totalCashBalance = totalCashBalance.add(await this.escrow.cashBalances(currencyId, a));
        }

        return totalCashBalance.eq(0);
    }

    public async checkMarketIntegrity(accounts: Wallet[]) {
        const maturities = await this.futureCash.getActiveMaturities();
        const markets = await Promise.all(
            maturities.map(m => {
                return this.futureCash.markets(m);
            })
        );

        const aggregateCollateral = markets.reduce((val, market) => {
            return val.add(market.totalCollateral);
        }, new BigNumber(0));
        const marketBalance = await this.escrow.currencyBalances(this.dai.address, this.futureCash.address);

        if (!aggregateCollateral.eq(marketBalance)) {
            return false;
        }

        const id = await this.futureCash.FUTURE_CASH_GROUP();

        const allAssets = (
            await Promise.all(
                accounts.map(a => {
                    return this.portfolios.getAssets(a.address);
                })
            )
        )
            .reduce((acc, val) => acc.concat(val), [])
            .filter(t => {
                return t.futureCashGroupId === id;
            });

        for (let i = 0; i < maturities.length; i++) {
            const totalCash = allAssets.reduce((totalCash, asset) => {
                if (asset.startTime + asset.duration === maturities[i]) {
                    if (asset.swapType === SwapType.CASH_RECEIVER) {
                        totalCash = totalCash.add(asset.notional);
                    } else if (asset.swapType === SwapType.CASH_PAYER) {
                        totalCash = totalCash.sub(asset.notional);
                    }
                }
                return totalCash;
            }, new BigNumber(0));

            const totalTokens = allAssets.reduce((totalTokens, asset) => {
                if (asset.startTime + asset.duration === maturities[i]) {
                    if (asset.swapType === SwapType.LIQUIDITY_TOKEN) {
                        totalTokens = totalTokens.add(asset.notional);
                    }
                }
                return totalTokens;
            }, new BigNumber(0));

            // Cash must always net out to zero
            if (!totalCash.add(markets[i].totalFutureCash).eq(0)) {
                return false;
            }

            if (!totalTokens.eq(markets[i].totalLiquidity)) {
                return false;
            }
        }

        return true;
    }

    private async hasAsset(account: Wallet, swapType: string, maturity?: number, notional?: BigNumber) {
        if (maturity === undefined) {
            maturity = (await this.futureCash.getActiveMaturities())[0];
        }
        const p = await this.portfolios.getAssets(account.address);

        for (let t of p) {
            if (t.startTime + t.duration == maturity && t.swapType == swapType) {
                if (notional !== undefined) {
                    return notional.eq(t.notional);
                } else {
                    return true;
                }
            }
        }

        return false;
    }
    public async hasLiquidityToken(account: Wallet, maturity?: number, tokens?: BigNumber, payer?: BigNumber) {
        if (payer !== undefined && payer.isZero()) {
            return this.hasAsset(account, SwapType.LIQUIDITY_TOKEN, maturity, tokens);
        } else {
            return (
                this.hasAsset(account, SwapType.LIQUIDITY_TOKEN, maturity, tokens) &&
                this.hasCashPayer(account, maturity, payer === undefined ? tokens : payer)
            );
        }
    }

    public async hasCashPayer(account: Wallet, maturity?: number, notional?: BigNumber) {
        return this.hasAsset(account, SwapType.CASH_PAYER, maturity, notional);
    }

    public async hasCashReceiver(account: Wallet, maturity?: number, notional?: BigNumber) {
        return this.hasAsset(account, SwapType.CASH_RECEIVER, maturity, notional);
    }

    public async mineAndSettleAccount(accounts: Wallet[]) {
        const maturities = await this.futureCash.getActiveMaturities();
        await fastForwardToMaturity(provider, maturities[0]);
        const addresses = accounts.map(a => a.address);
        await this.portfolios.settleAccountBatch(addresses);
    }

    public async settleCashBalance(
        payer: Wallet,
        receiver: Wallet,
        balance?: BigNumber,
        operator?: Wallet,
        currencyId = CURRENCY.DAI,
        depositCurrencyId = CURRENCY.ETH
    ) {
        if (balance === undefined) {
            balance = (await this.escrow.cashBalances(currencyId, payer.address)).mul(-1);
        }
        if (operator === undefined) {
            operator = this.escrow.signer as Wallet;
        }
        const payerCashBalanceBefore = await this.escrow.cashBalances(currencyId, payer.address);
        const receiverCashBalanceBefore = await this.escrow.cashBalances(currencyId, receiver.address);
        const receiverCurrencyBefore = await this.escrow.currencyBalances(this.dai.address, receiver.address);

        await this.escrow
            .connect(operator)
            .settleCashBalance(currencyId, depositCurrencyId, payer.address, receiver.address, balance);

        const payerCashBalanceAfter = await this.escrow.cashBalances(currencyId, payer.address);
        const receiverCashBalanceAfter = await this.escrow.cashBalances(currencyId, receiver.address);
        const receiverCurrencyAfter = await this.escrow.currencyBalances(this.dai.address, receiver.address);

        return [
            payerCashBalanceAfter.sub(payerCashBalanceBefore).eq(balance) &&
                receiverCashBalanceBefore.sub(receiverCashBalanceAfter).eq(balance) &&
                receiverCurrencyAfter.sub(receiverCurrencyBefore).eq(balance),
            balance
        ];
    }

    public async setupSellFutureCash(
        reserve: Wallet,
        wallet: Wallet,
        borrowAmount: BigNumber,
        futureCashAmount: BigNumber
    ) {
        await this.escrow.setReserveAccount(reserve.address);
        await this.escrow.connect(reserve).deposit(this.dai.address, WeiPerEther.mul(1000));

        const maturities = await this.futureCash.getActiveMaturities();
        await this.borrowAndWithdraw(wallet, borrowAmount);

        await this.escrow.connect(wallet).deposit(this.dai.address, futureCashAmount);
        await this.futureCash
            .connect(wallet)
            .takeFutureCash(maturities[1], futureCashAmount, BLOCK_TIME_LIMIT, 20_000_000);

        await this.chainlink.setAnswer(WeiPerEther);
        await this.escrow.liquidate(wallet.address, CURRENCY.DAI, CURRENCY.ETH);
    }
}
