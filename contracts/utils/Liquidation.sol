pragma solidity ^0.6.4;
pragma experimental ABIEncoderV2;

import "./Common.sol";

import "../lib/SafeInt256.sol";
import "../lib/SafeMath.sol";
import "../lib/SafeUInt128.sol";
import "../interface/IPortfoliosCallable.sol";

import "@openzeppelin/contracts/utils/SafeCast.sol";

library Liquidation {
    using SafeMath for uint256;
    using SafeInt256 for int256;
    using SafeUInt128 for uint128;

    struct LocalTokenParameters {
        uint16 localCurrency;
        uint128 localCurrencyRequired;
        uint128 liquidityHaircut;
        uint128 liquidityRepoIncentive;
        int256 localCurrencyNetAvailable;
        IPortfoliosCallable Portfolios;
    }

    struct DepositCurrencyParameters {
        uint128 localCurrencyRequired;
        int256 localCurrencyAvailable;
        uint16 depositCurrency;
        int256 depositCurrencyCashClaim;
        int256 depositCurrencyAvailable;
        uint128 discountFactor;
        uint128 liquidityHaircut;
        IPortfoliosCallable Portfolios;
    }

    struct RateParameters {
        uint256 rate;
        uint256 rateDecimals;
        uint256 localDecimals;
        uint256 depositDecimals;
    }

    function liquidateLocalLiquidityTokens(
        address account,
        LocalTokenParameters memory parameters
    ) public returns (uint128, int256, uint128, int256) {
        uint128 localCurrencyCredit;
        int256 localCurrencySold;

        (uint128 cashClaimWithdrawn, uint128 localCurrencyRaised) = Liquidation._localLiquidityTokenTrade(
            account,
            parameters.localCurrency,
            parameters.localCurrencyRequired,
            parameters.liquidityHaircut,
            parameters.liquidityRepoIncentive,
            parameters.Portfolios
        );

        (
            localCurrencySold,
            localCurrencyCredit,
            parameters.localCurrencyNetAvailable,
            parameters.localCurrencyRequired
        ) = Liquidation._calculatePostTradeFactors(
            cashClaimWithdrawn,
            parameters.localCurrencyNetAvailable,
            parameters.localCurrencyRequired,
            localCurrencyRaised,
            parameters.liquidityHaircut
        );

        return (localCurrencyCredit, localCurrencySold, parameters.localCurrencyRequired, parameters.localCurrencyNetAvailable);
    }

    function liquidate(
        address payer,
        int256 payerBalance,
        uint128 localCurrencyHaircut,
        DepositCurrencyParameters memory param,
        RateParameters memory rateParam
    ) public returns (uint128, uint128, int256) {
        param.localCurrencyRequired = _calculateLocalCurrencyToTrade(
            param.localCurrencyRequired,
            param.discountFactor,
            localCurrencyHaircut,
            uint128(param.localCurrencyAvailable.neg())
        );

        return _tradeDepositCurrency(
            payer,
            payerBalance,
            param,
            rateParam
        );
    }

    function settle(
        address payer,
        int256 payerBalance,
        DepositCurrencyParameters memory param,
        RateParameters memory rateParam
   ) public returns (uint128, uint128, int256) {
        return _tradeDepositCurrency(
            payer,
            payerBalance,
            param,
            rateParam
        );
    }

    function _tradeDepositCurrency(
        address payer,
        int256 payerBalance,
        DepositCurrencyParameters memory param,
        RateParameters memory rateParam
    ) internal returns (uint128, uint128, int256) {
        require(param.depositCurrencyAvailable > 0, $$(ErrorCode(INSUFFICIENT_BALANCE)));
        uint128 amountToRaise;
        uint128 localToPurchase;
        uint128 depositToSell;

        uint128 haircutClaim = _calculateLiquidityTokenHaircut(
            param.depositCurrencyCashClaim,
            param.liquidityHaircut
        );

        (
            amountToRaise,
            localToPurchase,
            depositToSell
        ) = _calculatePurchaseAmounts(
            haircutClaim,
            param.localCurrencyRequired,
            param,
            rateParam
        );

        int256 newPayerBalance = _transferDepositBalances(
            payer,
            payerBalance,
            param.depositCurrency,
            depositToSell,
            amountToRaise,
            param.Portfolios
        );

        return (localToPurchase, depositToSell, newPayerBalance);
    }

    function _localLiquidityTokenTrade(
        address account,
        uint16 currency,
        uint128 localCurrencyRequired,
        uint128 liquidityHaircut,
        uint128 liquidityRepoIncentive,
        IPortfoliosCallable Portfolios
    ) internal returns (uint128, uint128) {
        // We can only recollateralize the local currency using the part of the liquidity token that
        // between the pre-haircut cash claim and the post-haircut cash claim.
        // cashClaim - cashClaim * haircut = required * (1 + incentive)
        // cashClaim * (1 - haircut) = required * (1 + incentive)
        // cashClaim = required * (1 + incentive) / (1 - haircut)
        uint128 cashClaimsToTrade = SafeCast.toUint128(
            uint256(localCurrencyRequired)
                .mul(liquidityRepoIncentive)
                .div(Common.DECIMALS.sub(liquidityHaircut))
        );

        uint128 remainder = Portfolios.raiseCollateralViaLiquidityToken(
            account,
            currency,
            cashClaimsToTrade
        );

        uint128 localCurrencyRaised;
        uint128 cashClaimWithdrawn = cashClaimsToTrade.sub(remainder);
        if (remainder > 0) {
            // cashClaim = required * (1 + incentive) / (1 - haircut)
            // (cashClaim - remainder) = (required - delta) * (1 + incentive) / (1 - haircut)
            // cashClaimWithdrawn = (required - delta) * (1 + incentive) / (1 - haircut)
            // cashClaimWithdrawn * (1 - haircut) = (required - delta) * (1 + incentive)
            // cashClaimWithdrawn * (1 - haircut) / (1 + incentive) = (required - delta) = localCurrencyRaised
            localCurrencyRaised = SafeCast.toUint128(
                uint256(cashClaimWithdrawn)
                    .mul(Common.DECIMALS.sub(liquidityHaircut))
                    .div(liquidityRepoIncentive)
            );
        } else {
            localCurrencyRaised = localCurrencyRequired;
        }

        return (cashClaimWithdrawn, localCurrencyRaised);
    }

    function _calculatePostTradeFactors(
        uint128 cashClaimWithdrawn,
        int256 netCurrencyAvailable,
        uint128 localCurrencyRequired,
        uint128 localCurrencyRaised,
        uint128 liquidityHaircut
    ) internal pure returns (int256, uint128, int256, uint128) {
        // This is the portion of the cashClaimWithdrawn that is available to recollateralize the account.
        // cashClaimWithdrawn = value * (1 + incentive) / (1 - haircut)
        uint128 haircutClaimAmount = SafeCast.toUint128(
            uint256(cashClaimWithdrawn)
                .mul(Common.DECIMALS.sub(liquidityHaircut))
                .div(Common.DECIMALS)
        );


        // This is the incentive paid to the liquidator for extracting liquidity tokens.
        uint128 incentive = haircutClaimAmount.sub(localCurrencyRaised);

        return (
            // This is negative because we use it to offset what the liquidator may deposit into the account
            int256(incentive).neg(),
            // This is what will be credited back to the account
            cashClaimWithdrawn.sub(incentive),
            // The haircutClaimAmount - incentive is added to netCurrencyAvailable because it is now recollateralizing the account. This
            // is used in the next step to guard against raising too much local currency (to the point where netCurrencyAvailable is positive)
            // such that additional local currency does not actually help the account's free collateral position.
            netCurrencyAvailable.add(haircutClaimAmount).sub(incentive),
            // The new local currency required is what we required before minus the amount we added to netCurrencyAvailable to
            // recollateralize the account in the previous step.
            localCurrencyRequired.add(incentive).sub(haircutClaimAmount)
        );
    }

    function _calculateLocalCurrencyToTrade(
        uint128 localCurrencyRequired,
        uint128 liquidationDiscount,
        uint128 localCurrencyHaircut,
        uint128 maxLocalCurrencyDebt
    ) internal pure returns (uint128) {
        // We calculate the max amount of local currency that the liquidator can trade for here. We set it to the min of the
        // netCurrencyAvailable and the localCurrencyToTrade figure calculated below. The math for this figure is as follows:

        // The benefit given to free collateral in local currency terms:
        //   localCurrencyBenefit = localCurrencyToTrade * localCurrencyHaircut
        // NOTE: this only holds true while maxLocalCurrencyDebt <= 0

        // The penalty for trading deposit currency in local currency terms:
        //   localCurrencyPenalty = depositCurrencyPurchased * exchangeRate[depositCurrency][localCurrency]
        //
        //  netLocalCurrencyBenefit = localCurrencyBenefit - localCurrencyPenalty
        //
        // depositCurrencyPurchased = localCurrencyToTrade * exchangeRate[localCurrency][depositCurrency] * liquidationDiscount
        // localCurrencyPenalty = localCurrencyToTrade * exchangeRate[localCurrency][depositCurrency] * exchangeRate[depositCurrency][localCurrency] * liquidationDiscount
        // localCurrencyPenalty = localCurrencyToTrade * liquidationDiscount
        // netLocalCurrencyBenefit =  localCurrencyToTrade * localCurrencyHaircut - localCurrencyToTrade * liquidationDiscount
        // netLocalCurrencyBenefit =  localCurrencyToTrade * (localCurrencyHaircut - liquidationDiscount)
        // localCurrencyToTrade =  netLocalCurrencyBenefit / (haircut - discount)
        //
        // localCurrencyRequired is netLocalCurrencyBenefit after removing liquidity tokens
        // localCurrencyToTrade =  localCurrencyRequired / (haircut - discount)

        uint128 localCurrencyToTrade = SafeCast.toUint128(
            uint256(localCurrencyRequired)
                .mul(Common.DECIMALS)
                .div(localCurrencyHaircut.sub(liquidationDiscount))
        );

        // We do not trade past the amount of local currency debt the account has or this benefit will not longer be effective.
        localCurrencyToTrade = maxLocalCurrencyDebt < localCurrencyToTrade ? maxLocalCurrencyDebt : localCurrencyToTrade;

        return localCurrencyToTrade;
    }

    function _calculateLiquidityTokenHaircut(
        int256 postHaircutCashClaim,
        uint128 liquidityHaircut
    ) internal pure returns (uint128) {
        require(postHaircutCashClaim >= 0);
        // liquidityTokenHaircut = cashClaim / haircut - cashClaim
        //                       = cashClaim * (1  / haircut - 1)
        return SafeCast.toUint128(
            uint256(postHaircutCashClaim)
                .mul((Common.DECIMALS.mul(Common.DECIMALS)).div(liquidityHaircut)
                        .sub(Common.DECIMALS))
        );
    }

    function _calculatePurchaseAmounts(
        uint128 haircutClaim,
        uint128 maxLocalCurrencyToTrade,
        DepositCurrencyParameters memory param,
        RateParameters memory rateParam
    ) internal pure returns (uint128, uint128, uint128) {

        int256 depositToSell = _calculateDepositToSell(
            rateParam.rate,
            rateParam.rateDecimals,
            param.discountFactor,
            maxLocalCurrencyToTrade,
            rateParam.localDecimals,
            rateParam.depositDecimals
        );

        uint128 localToPurchase;
        uint128 amountToRaise;
        if (param.depositCurrencyAvailable >= depositToSell) {
            // We have enough deposit currency available to fulfill the purchase. It is either locked up inside
            // liquidity tokens or in the account's balance. If the account's balance is negative then we will have
            // to raise additional amount to fulfill depositToSell.
            // 
            // if (balance >= depositToSell) {
            //     amountToRaise = 0;
            //     balanceToTransfer = depositToSell;
            // } else {
            //     amountToRaise = depositToSell - balance;
            //     balanceToTransfer = balance > 0 ? balance : 0;
            // }

            localToPurchase = maxLocalCurrencyToTrade;
        } else if (param.depositCurrencyAvailable.add(haircutClaim) >= depositToSell) {
            // We have enough deposit currency available if we account for the liquidity token haircut that
            // is not part of the depositCurrencyAvailable figure. Here we raise an additional amount. 
            // 
            // if (balance >= depositToSell) {
            //     // The balance may be sufficient to cover depositToSell here so we'll transfer it but we also
            //     // need to extract a certain amount of haircutClaim in order to leave the account in balance.
            //     amountToRaise = (depositToSell - depositCurrencyAvailable) / (1 - haircut)
            //     balanceToTransfer = depositToSell;
            // } else {
            //     amountToRaise = depositToSell - balance;
            //     balanceToTransfer = balance > 0 ? balance : 0;
            // }

            // This has to be scaled to the preHaircutCashClaim amount:
            // haircutClaim = preHaircutCashClaim - preHaircutCashClaim * haircut
            // haircutClaim = preHaircutCashClaim * (1 - haircut)
            // liquidiytTokenHaircut / (1 - haircut) = preHaircutCashClaim
            amountToRaise = SafeCast.toUint128(
                uint256(depositToSell.sub(param.depositCurrencyAvailable))
                    .mul(Common.DECIMALS)
                    .div(Common.DECIMALS.sub(param.liquidityHaircut))
            );
            localToPurchase = maxLocalCurrencyToTrade;
        } else if (depositToSell > param.depositCurrencyAvailable.add(haircutClaim)) {
            // There is not enough value deposit currency in the account to fulfill the purchase, we
            // specify the maximum amount that we can get from the account to partially settle.
            //
            // if (balance >= depositToSell) {
            //     amountToRaise = haircutClaim / (1 - haircut);
            //     balanceToTransfer = depositToSell;
            // } else {
            //     amountToRaise = depositToSell - balance;
            //     balanceToTransfer = balance > 0 ? balance : 0;
            // }

            depositToSell = param.depositCurrencyAvailable.add(haircutClaim);
            amountToRaise = SafeCast.toUint128(
                uint256(haircutClaim)
                    .mul(Common.DECIMALS)
                    .div(Common.DECIMALS.sub(param.liquidityHaircut))
            );

            // In this case we partially settle the depositToSell amount
            localToPurchase = SafeCast.toUint128(
                uint256(depositToSell)
                    .mul(rateParam.rateDecimals)
                    // Discount factor uses 1e18 as its decimal precision
                    .mul(Common.DECIMALS)
                    .div(rateParam.rate)
                    .div(param.discountFactor)
            );
        }

        require(depositToSell > 0);

        return (amountToRaise, localToPurchase, uint128(depositToSell));
    }

    function _calculateDepositToSell(
        uint256 rate,
        uint256 rateDecimals,
        uint128 discountFactor,
        uint128 localCurrencyRequired,
        uint256 localDecimals,
        uint256 depositDecimals
    ) internal pure returns (uint128) {
        uint256 x = rate
            .mul(localCurrencyRequired)
            .mul(discountFactor);

        x = x
            .div(rateDecimals)
            .div(localDecimals);
        
        // Splitting calculation to handle stack depth
        return SafeCast.toUint128(x
            // Multiplying to the quote decimal precision (may not be the same as the rate precision)
            .mul(depositDecimals)
            // discountFactor uses 1e18 as its decimal precision
            .div(Common.DECIMALS)
        );
    }

    function _transferDepositBalances(
        address payer,
        int256 payerBalance,
        uint16 depositCurrency,
        uint128 depositToSell,
        uint128 amountToRaise,
        IPortfoliosCallable Portfolios
    ) internal returns (int256) {
         // We must deterimine how to transfer collateral from the payer to msg.sender. The collateral may be in cashBalances
        // or it may be locked up in liquidity tokens.
        int256 balance = payerBalance;
        bool creditBalance;

        if (balance >= depositToSell) {
            balance = balance.sub(depositToSell);
            creditBalance = true;
        } else {
            // Override the amountToRaise variable here because we will always spend the entire balance and raise
            // the remaining amount.
            amountToRaise = uint128(int256(depositToSell).sub(balance));
            balance = 0;
            creditBalance = false;
        }

        if (amountToRaise > 0) {
            uint128 remainder = Portfolios.raiseCollateralViaLiquidityToken(
                payer,
                depositCurrency,
                amountToRaise
            );

            if (creditBalance) {
                balance = balance.add(amountToRaise).sub(remainder);
            } else {
                // Generally we expect remainder to equal zero but this can be off by small amounts due
                // to truncation in the different calculations on the liquidity token haircuts. The upper bound on
                // amountToRaise is based on depositCurrencyAvailable and the balance. Also note that when removing
                // liquidity tokens some amount of cash receiver is credited back to the account as well. The concern
                // here is that if this is not true then remainder could put the account into a debt that it cannot pay off.
                require(remainder <= 1, $$(ErrorCode(RAISING_LIQUIDITY_TOKEN_BALANCE_ERROR)));
                balance = balance.sub(remainder);
            }
        }

        return balance;
    }
}