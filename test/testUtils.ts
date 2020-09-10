import { Escrow } from "../typechain/Escrow";
import { FutureCash } from "../typechain/FutureCash";
import { Portfolios } from "../typechain/Portfolios";
import { Wallet } from "ethers";
import { MockAggregator } from "../mocks/MockAggregator";
import {Ierc20 as ERC20} from "../typechain/Ierc20";
import { WeiPerEther } from "ethers/constants";
import { BigNumber, parseEther } from "ethers/utils";
import { provider, CURRENCY, fastForwardToMaturity } from "./fixtures";
import {Iweth as IWETH} from "../typechain/Iweth";
import { debug } from 'debug';

const log = debug("test:testutils");

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
        public token: ERC20,
        public owner: Wallet,
        public chainlink: MockAggregator,
        public weth: IWETH,
        public currencyId: number
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
            await this.escrow.connect(lp).deposit(this.token.address, collateralAmount);
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
        const erObj = (await this.escrow.getExchangeRate(this.currencyId, CURRENCY.ETH));
        const tokenDecimals = (await this.escrow.currencyIdToDecimals(this.currencyId));
        const maturities = await this.futureCash.getActiveMaturities();

        const ethAmount = borrowFutureCash
            .mul(exchangeRate)
            .mul(erObj.haircut)
            .div(erObj.rateDecimals)
            .div(WeiPerEther)
            .mul(WeiPerEther)
            .div(tokenDecimals)
            .mul(parseEther(collateralRatio.toString()))
            .div(WeiPerEther);

        log(`Borrowing ${borrowFutureCash.toString()} for ${ethAmount} ETH at maturity ${maturities[maturityOffset]}`);

        await this.escrow.connect(wallet).depositEth({value: ethAmount});
        const beforeAmount = await this.escrow.cashBalances(this.currencyId, wallet.address);
        await this.futureCash
            .connect(wallet)
            .takeCollateral(maturities[maturityOffset], borrowFutureCash, BLOCK_TIME_LIMIT, impliedRateLimit);
        const collateralAmount = (await this.escrow.cashBalances(this.currencyId, wallet.address)).sub(
            beforeAmount
        );

        // Remove the dai so only the ETH is collateralizing the CASH_PAYER
        await this.escrow.connect(wallet).withdraw(this.token.address, collateralAmount);

        return [ethAmount, collateralAmount];
    }

    public async isCollateralized(account: Wallet) {
        const fc = await this.portfolios.freeCollateralView(account.address);
        log(`Free Collateral: ${fc}`)
        return fc[0].gte(0);
    }

    public async checkEthBalanceIntegrity(accounts: Wallet[]) {
        const totalEthBalance = await this.weth.balanceOf(this.escrow.address);
        let escrowEthBalance = new BigNumber(0);
        for (let a of accounts) {
            escrowEthBalance = escrowEthBalance.add(await this.escrow.cashBalances(CURRENCY.ETH, a.address));
        }

        log(`Eth Balance Integrity: ${escrowEthBalance}, ${totalEthBalance}`);

        return escrowEthBalance.eq(totalEthBalance);
    }

    public async checkBalanceIntegrity(accounts: Wallet[], additionalMarket?: string) {
        await this.portfolios.settleMaturedAssetsBatch(accounts.map((a) => a.address));

        const totalDaiBalance = await this.token.balanceOf(this.escrow.address);
        log(`Total Dai Balance: ${totalDaiBalance}`)
        let escrowDaiBalance = new BigNumber(0);
        for (let a of accounts) {
            log(`Cash Balance: ${a.address}: ${await this.escrow.cashBalances(this.currencyId, a.address)}`)
            escrowDaiBalance = escrowDaiBalance.add(await this.escrow.cashBalances(this.currencyId, a.address));
        }

        log(`Future Cash Market: ${await this.escrow.cashBalances(this.currencyId, this.futureCash.address)}`)
        escrowDaiBalance = escrowDaiBalance.add(
            await this.escrow.cashBalances(this.currencyId, this.futureCash.address)
        );

        if (additionalMarket !== undefined) {
            escrowDaiBalance = escrowDaiBalance.add(
                await this.escrow.cashBalances(this.currencyId, additionalMarket)
            );
        }

        log(`Balance Integrity: ${totalDaiBalance}, ${escrowDaiBalance}`);
        return totalDaiBalance.eq(escrowDaiBalance);
    }

    public async checkMarketIntegrity(accounts: Wallet[], maturities: number[]) {
        const markets = await Promise.all(
            maturities.map(m => {
                return this.futureCash.markets(m);
            })
        );

        const aggregateCollateral = markets.reduce((val, market) => {
            return val.add(market.totalCollateral);
        }, new BigNumber(0));
        const marketBalance = await this.escrow.cashBalances(this.currencyId, this.futureCash.address);

        if (!aggregateCollateral.eq(marketBalance)) {
            log(`market integrity check, collateral: ${aggregateCollateral}, ${marketBalance}`);
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
                if (asset.maturity === maturities[i]) {
                    if (asset.swapType === SwapType.CASH_RECEIVER) {
                        totalCash = totalCash.add(asset.notional);
                    } else if (asset.swapType === SwapType.CASH_PAYER) {
                        totalCash = totalCash.sub(asset.notional);
                    }
                }
                return totalCash;
            }, new BigNumber(0));

            const totalTokens = allAssets.reduce((totalTokens, asset) => {
                if (asset.maturity === maturities[i]) {
                    if (asset.swapType === SwapType.LIQUIDITY_TOKEN) {
                        totalTokens = totalTokens.add(asset.notional);
                    }
                }
                return totalTokens;
            }, new BigNumber(0));

            // Cash must always net out to zero
            if (!totalCash.add(markets[i].totalFutureCash).eq(0)) {
                log(`market integrity check, net cash: ${totalCash}, ${markets[i].totalFutureCash}`);
                return false;
            }

            if (!totalTokens.eq(markets[i].totalLiquidity)) {
                log(`market integrity check, liquidity: ${totalTokens}, ${markets[i].totalLiquidity}`);
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
            if (t.maturity == maturity && t.swapType == swapType) {
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
        await this.portfolios.settleMaturedAssetsBatch(addresses);
    }

    public async settleCashBalance(
        payer: Wallet,
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

        await this.escrow
            .connect(operator)
            .settleCashBalance(currencyId, depositCurrencyId, payer.address, balance);

        const payerCashBalanceAfter = await this.escrow.cashBalances(currencyId, payer.address);

        log(`Settle Cash Balance: ${payerCashBalanceBefore}, ${payerCashBalanceAfter}`)
        return [
            payerCashBalanceAfter.sub(payerCashBalanceBefore).eq(balance)
        ];
    }

    public async setupSellFutureCash(
        reserve: Wallet,
        wallet: Wallet,
        borrowAmount: BigNumber,
        futureCashAmount: BigNumber
    ) {
        await this.escrow.setReserveAccount(reserve.address);
        await this.escrow.connect(reserve).deposit(this.token.address, WeiPerEther.mul(1000));

        const maturities = await this.futureCash.getActiveMaturities();
        await this.borrowAndWithdraw(wallet, borrowAmount);

        await this.escrow.connect(wallet).deposit(this.token.address, futureCashAmount);
        await this.futureCash
            .connect(wallet)
            .takeFutureCash(maturities[1], futureCashAmount, BLOCK_TIME_LIMIT, 0);

        await this.chainlink.setAnswer(WeiPerEther);
        await this.escrow.liquidate(wallet.address, CURRENCY.DAI, CURRENCY.ETH);
    }
}
