pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../lib/SafeInt256.sol";
import "../lib/SafeMath.sol";

import "../utils/Governed.sol";
import "../utils/Common.sol";
import "../interface/IPortfoliosCallable.sol";

import "../FutureCash.sol";

/**
 * @title Risk Framework
 * @notice Calculates the currency requirements for a portfolio.
 */
library RiskFramework {
    using SafeMath for uint256;
    using SafeInt256 for int256;

    /** The cash ladder for a single instrument or future cash group */
    struct CashLadder {
        // The future cash group id for this cash ladder
        uint16 id;
        // The currency group id for this cash ladder
        uint16 currency;
        // The cash ladder for the periods of this future cash group
        int256[] cashLadder;
    }

    /**
     * @notice Given a portfolio of assets, returns a set of requirements in every currency represented.
     * @param portfolio a portfolio of assets
     * @return a set of requirements in every future cash group represented by the portfolio
     */
    function getRequirement(
        Common.Asset[] memory portfolio,
        uint128 liquidityHaircut,
        address Portfolios
    ) public view returns (Common.Requirement[] memory) {
        Common._sortPortfolio(portfolio);

        // Each position in this array will hold the value of the portfolio in each maturity.
        (Common.FutureCashGroup[] memory futureCashGroups, CashLadder[] memory ladders) = _fetchFutureCashGroups(
            portfolio,
            IPortfoliosCallable(Portfolios)
        );

        int256[] memory npv = _getCashLadders(portfolio, futureCashGroups, ladders, liquidityHaircut);

        // We now take the per future cash group cash ladder and summarize it into a single requirement. The future
        // cash group requirements will be aggregated into a single currency requirement in the free collateral function
        Common.Requirement[] memory requirements = new Common.Requirement[](ladders.length);

        for (uint256 i; i < ladders.length; i++) {
            requirements[i].currency = ladders[i].currency;
            requirements[i].npv = npv[i];

            for (uint256 j; j < ladders[i].cashLadder.length; j++) {
                // Loop through each period in the cash ladder and add negative balances to the required
                // collateral along with a negative haircut.
                if (ladders[i].cashLadder[j] < 0) {
                    requirements[i].requirement = requirements[i].requirement.add(ladders[i].cashLadder[j].neg());
                }
            }
        }

        return requirements;
    }

    /**
     * @notice Calculates the cash ladders for every future cash group in a portfolio.
     *
     * @param portfolio a portfolio of assets
     * @return an array of cash ladders and an npv figure for every future cash group
     */
    function _getCashLadders(
        Common.Asset[] memory portfolio,
        Common.FutureCashGroup[] memory futureCashGroups,
        CashLadder[] memory ladders,
        uint128 liquidityHaircut
    ) internal view returns (int256[] memory) {
        uint32 blockTime = uint32(block.timestamp);

        // This will hold the current collateral balance.
        int256[] memory npv = new int256[](ladders.length);

        // Set up the first group's cash ladder before we iterate
        uint256 groupIndex;
        // In this loop we know that the assets are sorted and none of them have matured. We always call
        // settleMaturedAssets before we enter the risk framework.
        for (uint256 i; i < portfolio.length; i++) {
            if (portfolio[i].futureCashGroupId != ladders[groupIndex].id) {
                // This is the start of a new group
                groupIndex++;
            }

            (int256 cashAmount, int256 npvAmount) = _calculateAssetValue(
                portfolio[i],
                futureCashGroups[groupIndex],
                blockTime,
                liquidityHaircut
            );

            npv[groupIndex] = npv[groupIndex].add(npvAmount);
            if (portfolio[i].maturity <= blockTime) {
                // If asset has matured then all the future cash is considered NPV
                npv[groupIndex] = npv[groupIndex].add(cashAmount);
            } else {
                uint256 offset = (portfolio[i].maturity - blockTime) / futureCashGroups[groupIndex].periodSize;

                if (futureCashGroups[groupIndex].futureCashMarket == address(0)) {
                    // We do not allow positive future cash to net out negative future cash for idiosyncratic trades
                    // so we zero out positive cash at this point.
                    cashAmount = cashAmount > 0 ? 0 : cashAmount;
                }

                ladders[groupIndex].cashLadder[offset] = ladders[groupIndex].cashLadder[offset].add(cashAmount);
            }
        }

        return npv;
    }

    function _calculateAssetValue(
        Common.Asset memory asset,
        Common.FutureCashGroup memory fg,
        uint32 blockTime,
        uint128 liquidityHaircut
    ) internal view returns (int256, int256) {
        // This is the offset in the cash ladder
        int256 npv;
        int256 futureCash;

        if (Common.isLiquidityToken(asset.swapType)) {
            (npv, futureCash) = _calculateLiquidityTokenClaims(asset, fg.futureCashMarket, blockTime, liquidityHaircut);
        } else if (Common.isCash(asset.swapType)) {
            futureCash = Common.isPayer(asset.swapType) ? int256(asset.notional).neg() : asset.notional;
        }

        return (futureCash, npv);
    }

    function _calculateLiquidityTokenClaims(
        Common.Asset memory asset,
        address futureCashMarket,
        uint32 blockTime,
        uint128 liquidityHaircut
    ) internal view returns (uint128, uint128) {
        FutureCash.Market memory market = FutureCash(futureCashMarket).getMarket(asset.maturity);

        uint256 collateralClaim;
        uint256 futureCashClaim;

        if (blockTime < asset.maturity) {
            // We haircut these amounts because it is uncertain how much claim either of these will actually have
            // when it comes to reclaim the liquidity token. For example, there may be less collateral in the pool
            // relative to future cash due to trades that have happened between the initial free collateral check
            // and the liquidation.
            collateralClaim = uint256(market.totalCollateral)
                .mul(asset.notional)
                .mul(liquidityHaircut)
                .div(Common.DECIMALS)
                .div(market.totalLiquidity);

            futureCashClaim = uint256(market.totalFutureCash)
                .mul(asset.notional)
                .mul(liquidityHaircut)
                .div(Common.DECIMALS)
                .div(market.totalLiquidity);
        } else {
            collateralClaim = uint256(market.totalCollateral)
                .mul(asset.notional)
                .div(market.totalLiquidity);

            futureCashClaim = uint256(market.totalFutureCash)
                .mul(asset.notional)
                .div(market.totalLiquidity);
        }

        return (uint128(collateralClaim), uint128(futureCashClaim));
    }

    function _fetchFutureCashGroups(
        Common.Asset[] memory portfolio,
        IPortfoliosCallable Portfolios
    ) internal view returns (Common.FutureCashGroup[] memory, CashLadder[] memory) {
        uint8[] memory groupIds = new uint8[](portfolio.length);
        uint256 numGroups;

        groupIds[numGroups] = portfolio[0].futureCashGroupId;
        // Count the number of future cash groups in the portfolio, we will return a cash ladder for each.
        for (uint256 i = 1; i < portfolio.length; i++) {
            if (portfolio[i].futureCashGroupId != groupIds[numGroups]) {
                numGroups++;
                groupIds[numGroups] = portfolio[i].futureCashGroupId;
            }
        }

        uint8[] memory requestGroups = new uint8[](numGroups + 1);
        for (uint256 i; i < requestGroups.length; i++) {
            requestGroups[i] = groupIds[i];
        }

        Common.FutureCashGroup[] memory fgs = Portfolios.getFutureCashGroups(requestGroups);

        CashLadder[] memory ladders = new CashLadder[](fgs.length);
        for (uint256 i; i < ladders.length; i++) {
            ladders[i].id = requestGroups[i];
            ladders[i].currency = fgs[i].currency;
            ladders[i].cashLadder = new int256[](fgs[i].numPeriods);
        }

        return (fgs, ladders);
    }
}
