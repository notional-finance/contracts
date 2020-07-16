pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./lib/SafeInt256.sol";
import "./lib/SafeMath.sol";
import "./lib/SafeMath.sol";

import "./utils/Governed.sol";
import "./utils/Common.sol";

import "./interface/IRiskFramework.sol";

import "./FutureCash.sol";

/**
 * @title Risk Framework
 * @notice Calculates the currency requirements for a portfolio.
 */
contract RiskFramework is IRiskFramework, Governed {
    using SafeMath for uint256;
    using SafeInt256 for int256;

    uint128 public G_PORTFOLIO_HAIRCUT;

    /**
     * @notice Notice for setting haircut amount for the portfolio
     * @param portfolioHaircut amount of negative haircut applied to debt
     */
    event SetPortfolioHaircut(uint128 portfolioHaircut);

    /**
     * @notice Sets the haircut amount for the portfolio
     * @dev governance
     * @param haircut amount of negative haircut applied to debt
     */
    function setHaircut(uint128 haircut) public onlyOwner {
        G_PORTFOLIO_HAIRCUT = haircut;

        emit SetPortfolioHaircut(haircut);
    }

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
     * @return a set of requirements in every currency represented by the portfolio
     */
    function getRequirement(Common.Asset[] memory portfolio)
        public
        override
        view
        returns (Common.Requirement[] memory)
    {
        (CashLadder[] memory ladders, int256[] memory npv) = _getCashLadders(portfolio);

        // We now take the per future cash group cash ladder and summarize it into per currency requirements. In the
        // future we may have multiple future cash groups per currency but that is not the case right now so we can
        // just simplify this code by looking at the length of cash ladder.
        Common.Requirement[] memory requirements = new Common.Requirement[](ladders.length);

        for (uint256 i; i < ladders.length; i++) {
            requirements[i].currency = ladders[i].currency;
            requirements[i].npv = npv[i];
            requirements[i].cashLadder = ladders[i].cashLadder;

            for (uint256 j; j < ladders[i].cashLadder.length; j++) {
                // Loop through each period in the cash ladder and add negative balances to the required
                // collateral along with a negative haircut.
                if (ladders[i].cashLadder[j] < 0) {
                    // We do a negative haircut on cash ladder balances.
                    uint128 postHaircut = uint128(
                        ladders[i].cashLadder[j].neg().mul(G_PORTFOLIO_HAIRCUT).div(Common.DECIMALS)
                    );
                    requirements[i].requirement = requirements[i].requirement.add(postHaircut);
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
    function _getCashLadders(Common.Asset[] memory portfolio)
        internal
        view
        returns (CashLadder[] memory, int256[] memory)
    {
        Common._sortPortfolio(portfolio);
        uint32 blockTime = uint32(block.timestamp);

        // Each position in this array will hold the value of the portfolio in each maturity.
        (Common.FutureCashGroup[] memory futureCashGroups, CashLadder[] memory ladders) = _fetchFutureCashGroups(
            portfolio
        );

        // This will hold the current collateral balance.
        int256[] memory npv = new int256[](ladders.length);

        // Set up the first group's cash ladder before we iterate
        uint256 groupIndex;
        // In this loop we know that the portfolio are sorted and none of them have matured. We always call
        // settleAccount before we enter the risk framework.
        for (uint256 i; i < portfolio.length; i++) {
            if (portfolio[i].futureCashGroupId != ladders[groupIndex].id) {
                // This is the start of a new group
                groupIndex++;
            }

            uint32 maturity = portfolio[i].startTime + portfolio[i].duration;

            (int256 cashAmount, int256 npvAmount) = _updateCashLadder(
                portfolio[i],
                futureCashGroups[groupIndex],
                maturity
            );

            npv[groupIndex] = npv[groupIndex].add(npvAmount);
            if (maturity <= blockTime) {
                // If asset has matured then all the future cash is considered NPV
                npv[groupIndex] = npv[groupIndex].add(cashAmount);
            } else {
                uint256 offset = (maturity - blockTime) / futureCashGroups[groupIndex].periodSize;
                ladders[groupIndex].cashLadder[offset] = ladders[groupIndex].cashLadder[offset].add(cashAmount);
            }
        }

        return (ladders, npv);
    }

    function _updateCashLadder(
        Common.Asset memory asset,
        Common.FutureCashGroup memory fg,
        uint32 maturity
    ) internal view returns (int256, int256) {
        // This is the offset in the cash ladder
        int256 npv;
        int256 futureCash;

        if (Common.isLiquidityToken(asset.swapType)) {
            (npv, futureCash) = _calculateLiquidityTokenClaims(asset, fg.futureCashMarket, maturity);
        } else if (Common.isCash(asset.swapType)) {
            futureCash = Common.isPayer(asset.swapType) ? int256(asset.notional).neg() : asset.notional;
        }

        return (futureCash, npv);
    }

    function _calculateLiquidityTokenClaims(
        Common.Asset memory asset,
        address futureCashMarket,
        uint32 maturity
    ) internal view returns (uint128, uint128) {
        (
            uint128 totalFutureCash,
            uint128 totalLiquidity,
            uint128 totalCollateral, /* */ /* */
            ,
            ,

        ) = /* */
        FutureCash(futureCashMarket).markets(maturity);

        // These are the claims on the collateral and future cash in the markets. The collateral claim
        // goes to npv. This is important to note since we will use this collateralClaim to settle negative
        // cash balances if required.
        uint128 collateralClaim = uint128(uint256(totalCollateral).mul(asset.notional).div(totalLiquidity));
        uint128 futureCashClaim = uint128(uint256(totalFutureCash).mul(asset.notional).div(totalLiquidity));

        return (collateralClaim, futureCashClaim);
    }

    // TODO: can we remove this code by using delegatecall?
    function _fetchFutureCashGroups(Common.Asset[] memory portfolio)
        internal
        view
        returns (Common.FutureCashGroup[] memory, CashLadder[] memory)
    {
        uint8[] memory groupIds = new uint8[](portfolio.length);
        uint256 numGroups;

        groupIds[numGroups] = portfolio[0].futureCashGroupId;
        // Count the number of future cash groups in the portfolio, we will return a cash ladder for each. For
        // now, each future cash group corresponds to one currency group.
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

        Common.FutureCashGroup[] memory fgs = Portfolios().getFutureCashGroups(requestGroups);

        CashLadder[] memory ladders = new CashLadder[](fgs.length);
        for (uint256 i; i < ladders.length; i++) {
            ladders[i].id = requestGroups[i];
            ladders[i].currency = fgs[i].currency;
            ladders[i].cashLadder = new int256[](fgs[i].numPeriods);
        }

        return (fgs, ladders);
    }
}
