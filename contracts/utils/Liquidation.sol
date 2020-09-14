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

    struct CollateralCurrencyParameters {
        uint128 localCurrencyRequired;
        int256 localCurrencyAvailable;
        uint16 collateralCurrency;
        int256 collateralCurrencyCashClaim;
        int256 collateralCurrencyAvailable;
        uint128 discountFactor;
        uint128 liquidityHaircut;
        IPortfoliosCallable Portfolios;
    }

    struct RateParameters {
        uint256 rate;
        uint256 rateDecimals;
        uint256 localDecimals;
        uint256 collateralDecimals;
    }

    /**
     * @notice Given an account that has liquidity tokens denominated in the currency, liquidates only enough to
     * recollateralize the account.
     * @param account to liquidate
     * @param parameters paramaters required to complete the calculations
     * @return (localCurrencyCredit to the account, localCurrencySold by the liquidator, localCurrencyRequired after action, localCurrencyNetAvailable
     * after the action)
     */
    function liquidateLocalLiquidityTokens(
        address account,
        LocalTokenParameters memory parameters
    ) public returns (uint128, int256, uint128, int256) {
        // The amount of local currency that will be credited back to the account
        uint128 localCurrencyCredit;
        // The amount of local currency the liquidator has "sold". This will be negative because they will
        // receive the incentive amount. The reason for the inverted logic here is for the second step of liquidation
        // where local currency is traded and the liquidator will have their account debited.
        int256 localCurrencySold;

        // Calculate amount of liquidity tokens to withdraw and do the action.
        (uint128 cashClaimWithdrawn, uint128 localCurrencyRaised) = Liquidation._localLiquidityTokenTrade(
            account,
            parameters.localCurrency,
            parameters.localCurrencyRequired,
            parameters.liquidityHaircut,
            parameters.liquidityRepoIncentive,
            parameters.Portfolios
        );

        // Calculates relevant parameters post trade.
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

    /** @notice Trades liquidity tokens in order to attempt to raise `localCurrencyRequired` */
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

        uint128 remainder = Portfolios.raiseCurrentCashViaLiquidityToken(
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
        // cashClaimWithdrawn * (1 - haircut) = value * (1 + incentive)
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

    /**
     * @notice Trades local currency for collateral currency for a payer in order to recollateralize the account.
     * @param payer account that is being liquidated
     * @param payerBalance payer's collateral currency account balance
     * @param localCurrencyBuffer the haircut given to a local currency
     * @param param collateral currency parameters
     * @param rateParam collateral currency exchange rate parameters
     */
    function liquidate(
        address payer,
        int256 payerBalance,
        uint128 localCurrencyBuffer,
        CollateralCurrencyParameters memory param,
        RateParameters memory rateParam
    ) public returns (uint128, uint128, int256) {
        require(param.localCurrencyAvailable < 0, $$(ErrorCode(INSUFFICIENT_LOCAL_CURRENCY_DEBT)));

        param.localCurrencyRequired = _calculateLocalCurrencyToTrade(
            param.localCurrencyRequired,
            param.discountFactor,
            localCurrencyBuffer,
            uint128(param.localCurrencyAvailable.neg())
        );

        return _tradeCollateralCurrency(
            payer,
            payerBalance,
            param,
            rateParam
        );
    }

    function _calculateLocalCurrencyToTrade(
        uint128 localCurrencyRequired,
        uint128 liquidationDiscount,
        uint128 localCurrencyBuffer,
        uint128 maxLocalCurrencyDebt
    ) internal pure returns (uint128) {
        // We calculate the max amount of local currency that the liquidator can trade for here. We set it to the min of the
        // netCurrencyAvailable and the localCurrencyToTrade figure calculated below. The math for this figure is as follows:

        // The benefit given to free collateral in local currency terms:
        //   localCurrencyBenefit = localCurrencyToTrade * localCurrencyBuffer
        // NOTE: this only holds true while maxLocalCurrencyDebt <= 0

        // The penalty for trading collateral currency in local currency terms:
        //   localCurrencyPenalty = collateralCurrencyPurchased * exchangeRate[collateralCurrency][localCurrency]
        //
        //  netLocalCurrencyBenefit = localCurrencyBenefit - localCurrencyPenalty
        //
        // collateralCurrencyPurchased = localCurrencyToTrade * exchangeRate[localCurrency][collateralCurrency] * liquidationDiscount
        // localCurrencyPenalty = localCurrencyToTrade * exchangeRate[localCurrency][collateralCurrency] * exchangeRate[collateralCurrency][localCurrency] * liquidationDiscount
        // localCurrencyPenalty = localCurrencyToTrade * liquidationDiscount
        // netLocalCurrencyBenefit =  localCurrencyToTrade * localCurrencyBuffer - localCurrencyToTrade * liquidationDiscount
        // netLocalCurrencyBenefit =  localCurrencyToTrade * (localCurrencyBuffer - liquidationDiscount)
        // localCurrencyToTrade =  netLocalCurrencyBenefit / (buffer - discount)
        //
        // localCurrencyRequired is netLocalCurrencyBenefit after removing liquidity tokens
        // localCurrencyToTrade =  localCurrencyRequired / (buffer - discount)

        uint128 localCurrencyToTrade = SafeCast.toUint128(
            uint256(localCurrencyRequired)
                .mul(Common.DECIMALS)
                .div(localCurrencyBuffer.sub(liquidationDiscount))
        );

        // We do not trade past the amount of local currency debt the account has or this benefit will not longer be effective.
        localCurrencyToTrade = maxLocalCurrencyDebt < localCurrencyToTrade ? maxLocalCurrencyDebt : localCurrencyToTrade;

        return localCurrencyToTrade;
    }

    function settle(
        address payer,
        int256 payerBalance,
        CollateralCurrencyParameters memory param,
        RateParameters memory rateParam
   ) public returns (uint128, uint128, int256) {
        return _tradeCollateralCurrency(
            payer,
            payerBalance,
            param,
            rateParam
        );
    }

    function _tradeCollateralCurrency(
        address payer,
        int256 payerBalance,
        CollateralCurrencyParameters memory param,
        RateParameters memory rateParam
    ) internal returns (uint128, uint128, int256) {
        require(param.collateralCurrencyAvailable > 0, $$(ErrorCode(INSUFFICIENT_BALANCE)));
        uint128 amountToRaise;
        uint128 localToPurchase;
        uint128 collateralToSell;

        uint128 haircutClaim = _calculateLiquidityTokenHaircut(
            param.collateralCurrencyCashClaim,
            param.liquidityHaircut
        );

        (
            amountToRaise,
            localToPurchase,
            collateralToSell
        ) = _calculatePurchaseAmounts(
            haircutClaim,
            param.localCurrencyRequired,
            param,
            rateParam
        );

        int256 newPayerBalance = _calculateCollateralBalances(
            payer,
            payerBalance,
            param.collateralCurrency,
            collateralToSell,
            amountToRaise,
            param.Portfolios
        );

        return (localToPurchase, collateralToSell, newPayerBalance);
    }

    function _calculateLiquidityTokenHaircut(
        int256 postHaircutCashClaim,
        uint128 liquidityHaircut
    ) internal pure returns (uint128) {
        require(postHaircutCashClaim >= 0);
        // liquidityTokenHaircut = cashClaim / haircut - cashClaim
        uint256 x = uint256(postHaircutCashClaim);

        return SafeCast.toUint128(
            uint256(x)
                .mul(Common.DECIMALS)
                .div(liquidityHaircut)
                .sub(x)
        );
    }

    function _calculatePurchaseAmounts(
        uint128 haircutClaim,
        uint128 maxLocalCurrencyToTrade,
        CollateralCurrencyParameters memory param,
        RateParameters memory rateParam
    ) internal pure returns (uint128, uint128, uint128) {

        int256 collateralToSell = _calculateCollateralToSell(
            rateParam.rate,
            rateParam.rateDecimals,
            param.discountFactor,
            maxLocalCurrencyToTrade,
            rateParam.localDecimals,
            rateParam.collateralDecimals
        );

        uint128 localToPurchase;
        uint128 amountToRaise;
        // This calculation is described in Appendix B of the whitepaper. It is split between this function and
        // _calculateCollateralBalances to deal with stack issues.
        if (param.collateralCurrencyAvailable >= collateralToSell) {
            // We have enough collateral currency available to fulfill the purchase. It is either locked up inside
            // liquidity tokens or in the account's balance. If the account's balance is negative then we will have
            // to raise additional amount to fulfill collateralToSell.
            localToPurchase = maxLocalCurrencyToTrade;
        } else if (param.collateralCurrencyAvailable.add(haircutClaim) >= collateralToSell) {
            // We have enough collateral currency available if we account for the liquidity token haircut that
            // is not part of the collateralCurrencyAvailable figure. Here we raise an additional amount. 

            // This has to be scaled to the preHaircutCashClaim amount:
            // haircutClaim = preHaircutCashClaim - preHaircutCashClaim * haircut
            // haircutClaim = preHaircutCashClaim * (1 - haircut)
            // liquidiytTokenHaircut / (1 - haircut) = preHaircutCashClaim
            amountToRaise = SafeCast.toUint128(
                uint256(collateralToSell.sub(param.collateralCurrencyAvailable))
                    .mul(Common.DECIMALS)
                    .div(Common.DECIMALS.sub(param.liquidityHaircut))
            );
            localToPurchase = maxLocalCurrencyToTrade;
        } else if (collateralToSell > param.collateralCurrencyAvailable.add(haircutClaim)) {
            // There is not enough value collateral currency in the account to fulfill the purchase, we
            // specify the maximum amount that we can get from the account to partially settle.
            collateralToSell = param.collateralCurrencyAvailable.add(haircutClaim);
            amountToRaise = SafeCast.toUint128(
                uint256(haircutClaim)
                    .mul(Common.DECIMALS)
                    .div(Common.DECIMALS.sub(param.liquidityHaircut))
            );

            // In this case we partially settle the collateralToSell amount.
            // collateralDecimals * rateDecimals * 1e18 * localDecimals
            //         / (rateDecimals * 1e18 * collateralDecimals) = localDecimals
            uint256 x = uint256(collateralToSell)
                .mul(rateParam.rateDecimals)
                // Discount factor uses 1e18 as its decimal precision
                .mul(Common.DECIMALS);

            x = x
                .mul(rateParam.localDecimals)
                .div(rateParam.rate);

            localToPurchase = SafeCast.toUint128(x
                    .div(param.discountFactor)
                    .div(rateParam.collateralDecimals)
            );
        }

        require(collateralToSell > 0);

        return (amountToRaise, localToPurchase, uint128(collateralToSell));
    }

    function _calculateCollateralToSell(
        uint256 rate,
        uint256 rateDecimals,
        uint128 discountFactor,
        uint128 localCurrencyRequired,
        uint256 localDecimals,
        uint256 collateralDecimals
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
            .mul(collateralDecimals)
            // discountFactor uses 1e18 as its decimal precision
            .div(Common.DECIMALS)
        );
    }

    function _calculateCollateralBalances(
        address payer,
        int256 payerBalance,
        uint16 collateralCurrency,
        uint128 collateralToSell,
        uint128 amountToRaise,
        IPortfoliosCallable Portfolios
    ) internal returns (int256) {
         // We must deterimine how to transfer collateral from the payer to msg.sender. The collateral may be in cashBalances
        // or it may be locked up in liquidity tokens.
        int256 balance = payerBalance;
        bool creditBalance;

        if (balance >= collateralToSell) {
            balance = balance.sub(collateralToSell);
            creditBalance = true;
        } else {
            // If amountToRaise is greater than (collateralToSell - balance) this means that we're tapping into the
            // haircut claim amount. We need to credit back the difference to the account to ensure that the collateral
            // position does not get worse
            uint128 tmp = uint128(int256(collateralToSell).sub(balance));
            if (amountToRaise > tmp) {
                balance = int256(amountToRaise).sub(tmp);
            } else {
                amountToRaise = tmp;
                balance = 0;
            }

            creditBalance = false;
        }

        if (amountToRaise > 0) {
            uint128 remainder = Portfolios.raiseCurrentCashViaLiquidityToken(
                payer,
                collateralCurrency,
                amountToRaise
            );

            if (creditBalance) {
                balance = balance.add(amountToRaise).sub(remainder);
            } else {
                // Generally we expect remainder to equal zero but this can be off by small amounts due
                // to truncation in the different calculations on the liquidity token haircuts. The upper bound on
                // amountToRaise is based on collateralCurrencyAvailable and the balance. Also note that when removing
                // liquidity tokens some amount of cash receiver is credited back to the account as well. The concern
                // here is that if this is not true then remainder could put the account into a debt that it cannot pay off.
                require(remainder <= 1, $$(ErrorCode(RAISING_LIQUIDITY_TOKEN_BALANCE_ERROR)));
                balance = balance.sub(remainder);
            }
        }

        return balance;
    }
}