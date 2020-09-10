pragma solidity ^0.6.4;
pragma experimental ABIEncoderV2;

import "./Common.sol";
import "../lib/SafeMath.sol";
import "../interface/IPortfoliosCallable.sol";

import "./Liquidation.sol";

contract MockLiquidation {
    event TradeDepositCurrency(uint128 localToPurchase, uint128 depositToSell, int256 newPayerBalance);
    function tradeDepositCurrency(
        address payer,
        int256 payerBalance,
        Liquidation.DepositCurrencyParameters memory param,
        Liquidation.RateParameters memory rateParam
    ) public returns (uint128, uint128, int256) {
        (uint128 localToPurchase, uint128 depositToSell, int256 newPayerBalance) = 
            Liquidation._tradeDepositCurrency(payer, payerBalance, param, rateParam);

        emit TradeDepositCurrency(localToPurchase, depositToSell, newPayerBalance);
    }

    event LiquidityTokenTrade(uint128 cashClaimWithdrawn, uint128 localCurrencyRaised);
    function localLiquidityTokenTrade(
        address account,
        uint16 currency,
        uint128 localCurrencyRequired,
        uint128 liquidityHaircut,
        uint128 liquidityRepoIncentive,
        address Portfolios
    ) public {
        (uint128 cashClaimWithdrawn, uint128 localCurrencyRaised) = 
            Liquidation._localLiquidityTokenTrade(
                account,
                currency,
                localCurrencyRequired,
                liquidityHaircut,
                liquidityRepoIncentive,
                IPortfoliosCallable(Portfolios)
            );

        emit LiquidityTokenTrade(cashClaimWithdrawn, localCurrencyRaised);
    }

    function calculatePostTradeFactors(
        uint128 cashClaimWithdrawn,
        int256 netCurrencyAvailable,
        uint128 localCurrencyRequired,
        uint128 localCurrencyRaised,
        uint128 liquidityHaircut
    ) public pure returns (int256, uint128, int256, uint128) {
        return Liquidation._calculatePostTradeFactors(cashClaimWithdrawn, netCurrencyAvailable, localCurrencyRequired, localCurrencyRaised, liquidityHaircut);
    }

    function calculateLocalCurrencyToTrade(
        uint128 localCurrencyRequired,
        uint128 liquidationDiscount,
        uint128 localCurrencyHaircut,
        uint128 maxLocalCurrencyDebt
    ) public pure returns (uint128) {
        return Liquidation._calculateLocalCurrencyToTrade(localCurrencyRequired, liquidationDiscount, localCurrencyHaircut, maxLocalCurrencyDebt);
    }

    function calculateLiquidityTokenHaircut(
        int256 postHaircutCashClaim,
        uint128 liquidityHaircut
    ) public pure returns (uint128)  {
        return Liquidation._calculateLiquidityTokenHaircut(postHaircutCashClaim, liquidityHaircut);
    }

    function calculatePurchaseAmounts(
        uint128 haircutClaim,
        uint128 maxLocalCurrencyToTrade,
        Liquidation.DepositCurrencyParameters memory param,
        Liquidation.RateParameters memory rateParam
    ) public pure returns (uint128, uint128, uint128) {
        return Liquidation._calculatePurchaseAmounts(haircutClaim, maxLocalCurrencyToTrade, param, rateParam);
    }

    function calculateDepositToSell(
        uint256 rate,
        uint256 rateDecimals,
        uint128 discountFactor,
        uint128 localCurrencyRequired,
        uint256 localDecimals,
        uint256 depositDecimals
    ) public pure returns (uint128) {
        return Liquidation._calculateDepositToSell(rate, rateDecimals, discountFactor, localCurrencyRequired, localDecimals, depositDecimals);
    }

    function transferDepositBalances(
        address payer,
        int256 payerBalance,
        uint16 depositCurrency,
        uint128 depositToSell,
        uint128 amountToRaise,
        address Portfolios
    ) public returns (int256) {
        return Liquidation._transferDepositBalances(payer, payerBalance, depositCurrency, depositToSell, amountToRaise, IPortfoliosCallable(Portfolios));
    }
}

contract MockPortfolios {
    using SafeMath for uint256;
    uint128 public _remainder;
    uint128 public _amount;
    uint128 public liquidityHaircut;
    uint128 public _cash;
    uint128 public _fCash;
    bool public _wasCalled;

    function setHaircut(uint128 haircut) public {
        liquidityHaircut = haircut;
    }

    function setRemainder(uint128 remainder) public {
        _remainder = remainder;
    }

    function setClaim(uint128 cash, uint128 fCash) public {
        _cash = cash;
        _fCash = fCash;
    }

    function getClaim() public view returns (uint128, uint128) {
        uint256 cashClaim = uint256(_cash)
            .mul(liquidityHaircut)
            .div(Common.DECIMALS);

        uint256 fCashClaim = uint256(_fCash)
            .mul(liquidityHaircut)
            .div(Common.DECIMALS);

        return (uint128(cashClaim), uint128(fCashClaim));
    }

    function raiseCollateralViaLiquidityToken(
        address /* account */,
        uint16 /* currency */,
        uint128 amount
    ) external returns (uint128) {
        _wasCalled = true;
        _amount = amount;

        // If cash is set we return the remainder here
        if (_cash != 0) {
            if (amount >= _cash) {
                return amount - _cash;
            } else {
                return 0;
            }
        }

        return _remainder;
    }
}