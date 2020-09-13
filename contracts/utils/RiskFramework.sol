pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../lib/SafeInt256.sol";
import "../lib/SafeMath.sol";

import "../utils/Governed.sol";
import "../utils/Common.sol";
import "../interface/IPortfoliosCallable.sol";

import "../CashMarket.sol";

import "@openzeppelin/contracts/utils/SafeCast.sol";

/**
 * @title Risk Framework
 * @notice Calculates the currency requirements for a portfolio.
 */
library RiskFramework {
    using SafeMath for uint256;
    using SafeInt256 for int256;

    /** The cash ladder for a single instrument or cash group */
    struct CashLadder {
        // The cash group id for this cash ladder
        uint16 id;
        // The currency group id for this cash ladder
        uint16 currency;
        // The cash ladder for the maturities of this cash group
        int256[] cashLadder;
    }

    /**
     * @notice Given a portfolio of assets, returns a set of requirements in every currency represented.
     * @param portfolio a portfolio of assets
     * @return a set of requirements in every cash group represented by the portfolio
     */
    function getRequirement(
        Common.Asset[] memory portfolio,
        uint128 liquidityHaircut,
        address Portfolios
    ) public view returns (Common.Requirement[] memory) {
        Common._sortPortfolio(portfolio);

        // Each position in this array will hold the value of the portfolio in each maturity.
        (Common.CashGroup[] memory cashGroups, CashLadder[] memory ladders) = _fetchCashGroups(
            portfolio,
            IPortfoliosCallable(Portfolios)
        );

        int256[] memory npv = _getCashLadders(portfolio, cashGroups, ladders, liquidityHaircut);

        // We now take the per cash group cash ladder and summarize it into a single requirement. The future
        // cash group requirements will be aggregated into a single currency requirement in the free collateral function
        Common.Requirement[] memory requirements = new Common.Requirement[](ladders.length);

        for (uint256 i; i < ladders.length; i++) {
            requirements[i].currency = ladders[i].currency;
            requirements[i].npv = npv[i];

            for (uint256 j; j < ladders[i].cashLadder.length; j++) {
                if (ladders[i].cashLadder[j] < 0) {
                    requirements[i].requirement = requirements[i].requirement.add(ladders[i].cashLadder[j].neg());
                }
            }
        }

        return requirements;
    }

    /**
     * @notice Calculates the cash ladders for every cash group in a portfolio.
     *
     * @param portfolio a portfolio of assets
     * @return an array of cash ladders and an npv figure for every cash group
     */
    function _getCashLadders(
        Common.Asset[] memory portfolio,
        Common.CashGroup[] memory cashGroups,
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
            if (portfolio[i].cashGroupId != ladders[groupIndex].id) {
                // This is the start of a new group
                groupIndex++;
            }

            (int256 cashAmount, int256 npvAmount) = _calculateAssetValue(
                portfolio[i],
                cashGroups[groupIndex],
                blockTime,
                liquidityHaircut
            );

            npv[groupIndex] = npv[groupIndex].add(npvAmount);
            if (portfolio[i].maturity <= blockTime) {
                // If asset has matured then all the fCash is considered NPV
                npv[groupIndex] = npv[groupIndex].add(cashAmount);
            } else {
                uint256 offset = (portfolio[i].maturity - blockTime) / cashGroups[groupIndex].maturityLength;

                if (cashGroups[groupIndex].cashMarket == address(0)) {
                    // We do not allow positive fCash to net out negative fCash for idiosyncratic trades
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
        Common.CashGroup memory cg,
        uint32 blockTime,
        uint128 liquidityHaircut
    ) internal view returns (int256, int256) {
        // This is the offset in the cash ladder
        int256 npv;
        int256 fCash;

        if (Common.isLiquidityToken(asset.assetType)) {
            (npv, fCash) = _calculateLiquidityTokenClaims(asset, cg.cashMarket, blockTime, liquidityHaircut);
        } else if (Common.isCash(asset.assetType)) {
            fCash = Common.isPayer(asset.assetType) ? int256(asset.notional).neg() : asset.notional;
        }

        return (fCash, npv);
    }

    function _calculateLiquidityTokenClaims(
        Common.Asset memory asset,
        address cashMarket,
        uint32 blockTime,
        uint128 liquidityHaircut
    ) internal view returns (uint128, uint128) {
        CashMarket.Market memory market = CashMarket(cashMarket).getMarket(asset.maturity);

        uint256 collateralClaim;
        uint256 fCashClaim;

        if (blockTime < asset.maturity) {
            // We haircut these amounts because it is uncertain how much claim either of these will actually have
            // when it comes to reclaim the liquidity token. For example, there may be less collateral in the pool
            // relative to fCash due to trades that have happened between the initial free collateral check
            // and the liquidation.
            collateralClaim = uint256(market.totalCurrentCash)
                .mul(asset.notional)
                .mul(liquidityHaircut)
                .div(Common.DECIMALS)
                .div(market.totalLiquidity);

            fCashClaim = uint256(market.totalfCash)
                .mul(asset.notional)
                .mul(liquidityHaircut)
                .div(Common.DECIMALS)
                .div(market.totalLiquidity);
        } else {
            collateralClaim = uint256(market.totalCurrentCash)
                .mul(asset.notional)
                .div(market.totalLiquidity);

            fCashClaim = uint256(market.totalfCash)
                .mul(asset.notional)
                .div(market.totalLiquidity);
        }

        return (SafeCast.toUint128(collateralClaim), SafeCast.toUint128(fCashClaim));
    }

    function _fetchCashGroups(
        Common.Asset[] memory portfolio,
        IPortfoliosCallable Portfolios
    ) internal view returns (Common.CashGroup[] memory, CashLadder[] memory) {
        uint8[] memory groupIds = new uint8[](portfolio.length);
        uint256 numGroups;

        groupIds[numGroups] = portfolio[0].cashGroupId;
        // Count the number of cash groups in the portfolio, we will return a cash ladder for each.
        for (uint256 i = 1; i < portfolio.length; i++) {
            if (portfolio[i].cashGroupId != groupIds[numGroups]) {
                numGroups++;
                groupIds[numGroups] = portfolio[i].cashGroupId;
            }
        }

        uint8[] memory requestGroups = new uint8[](numGroups + 1);
        for (uint256 i; i < requestGroups.length; i++) {
            requestGroups[i] = groupIds[i];
        }

        Common.CashGroup[] memory cgs = Portfolios.getCashGroups(requestGroups);

        CashLadder[] memory ladders = new CashLadder[](cgs.length);
        for (uint256 i; i < ladders.length; i++) {
            ladders[i].id = requestGroups[i];
            ladders[i].currency = cgs[i].currency;
            ladders[i].cashLadder = new int256[](cgs[i].numMaturities);
        }

        return (cgs, ladders);
    }
}
