pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./lib/SafeInt256.sol";
import "./lib/SafeMath.sol";
import "./lib/SafeMath.sol";

import "./utils/Governed.sol";
import "./utils/Common.sol";

import "./interface/IRiskFramework.sol";

import "./FutureCash.sol";

contract RiskFramework is IRiskFramework, Governed {
    using SafeMath for uint256;
    using SafeInt256 for int256;

    uint128 public G_PORTFOLIO_HAIRCUT;
    function setHaircut(uint128 haircut) public onlyOwner {
        G_PORTFOLIO_HAIRCUT = haircut;
    }

    /** The cash ladder for a single instrument or instrument group */
    struct CashLadder {
        // The instrument group id for this cash ladder
        uint16 id;
        // The currency group id for this cash ladder
        uint16 currency;
        // The cash ladder for the periods of this instrument group
        int256[] cashLadder;
    }

    /**
     * Given a portfolio of trades, returns a set of requirements in every currency represented.
     *
     * @param portfolio a portfolio of trades
     * @return a set of requirements in every currency represented by the portfolio
     */
    function getRequirement(Common.Trade[] memory portfolio) public override view returns (Common.Requirement[] memory) {
        (CashLadder[] memory ladders, int256[] memory npv) = getCashLadders(portfolio);

        // We now take the per instrument group cash ladder and summarize it into per currency requirements. In the
        // future we may have multiple instrument groups per currency but that is not the case right now so we can
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
                        ladders[i].cashLadder[j]
                            .neg()
                            .mul(G_PORTFOLIO_HAIRCUT)
                            .div(Common.DECIMALS)
                    );
                    requirements[i].requirement = requirements[i].requirement.add(postHaircut);
                }
            }
        }

        return requirements;
    }


    /**
     * @notice Calculates the cash ladders for every instrument group in a portfolio.
     *
     * @param portfolio a portfolio of trades
     * @return an array of cash ladders and an npv figure for every instrument group
     */
    function getCashLadders(Common.Trade[] memory portfolio) internal view returns (CashLadder[] memory, int256[] memory) {
        Common._sortPortfolio(portfolio);
        uint32 blockNum = uint32(block.number);

        // Each position in this array will hold the value of the portfolio in each maturity.
        (
            Common.InstrumentGroup[] memory instrumentGroups,
            CashLadder[] memory ladders
        ) = _fetchInstrumentGroups(portfolio);

        // This will hold the current collateral balance.
        int256[] memory npv = new int256[](ladders.length);

        // Set up the first group's cash ladder before we iterate
        uint256 groupIndex;
        // In this loop we know that the portfolio are sorted and none of them have matured. We always call
        // settleAccountTrade before we enter the risk framework.
        for (uint256 i; i < portfolio.length; i++) {
            if (portfolio[i].instrumentGroupId != ladders[groupIndex].id) {
                // This is the start of a new group
                groupIndex++;
            }

            uint32 maturity = portfolio[i].startBlock + portfolio[i].duration;

            (int256 cashAmount, int256 npvAmount) = _updateCashLadder(
                portfolio[i],
                instrumentGroups[groupIndex],
                maturity
            );

            npv[groupIndex] = npv[groupIndex].add(npvAmount);
            if (maturity <= blockNum) {
                // If trade has matured then all the future cash is considered NPV
                npv[groupIndex] = npv[groupIndex].add(cashAmount);
            } else {
                uint256 offset = (maturity - blockNum) / instrumentGroups[groupIndex].periodSize;
                ladders[groupIndex].cashLadder[offset] = ladders[groupIndex].cashLadder[offset].add(cashAmount);
            }
        }

        return (ladders, npv);
    }

    function _updateCashLadder(
        Common.Trade memory trade,
        Common.InstrumentGroup memory ig,
        uint32 maturity
    ) internal view returns (int256, int256) {
        // This is the offset in the cash ladder
        int256 npv;
        int256 futureCash;

        if (Common.isLiquidityToken(trade.swapType)) {
            (npv, futureCash) = _calculateLiquidityTokenClaims(trade, ig.futureCashMarket, maturity);
        } else if (Common.isCash(trade.swapType)) {
            futureCash = Common.isPayer(trade.swapType) ? int256(trade.notional).neg() : trade.notional;
        }

        return (futureCash, npv);
    }

    function _calculateLiquidityTokenClaims(
        Common.Trade memory trade,
        address futureCashMarket,
        uint32 maturity
    ) internal view returns (uint128, uint128) {
        (
            uint128 totalFutureCash,
            uint128 totalLiquidity,
            uint128 totalCollateral,
            /* */, /* */, /* */
        ) = FutureCash(futureCashMarket).markets(maturity);

        // These are the claims on the collateral and future cash in the markets. The collateral claim
        // goes to npv. This is important to note since we will use this collateralClaim to settle negative
        // cash balances if required.
        uint128 collateralClaim = uint128(
            uint256(totalCollateral).mul(trade.notional).div(totalLiquidity)
        );
        uint128 futureCashClaim = uint128(uint256(totalFutureCash).mul(trade.notional).div(totalLiquidity));

        return (collateralClaim, futureCashClaim);
    }

    // TODO: can we remove this code by using delegatecall?
    function _fetchInstrumentGroups(
        Common.Trade[] memory portfolio
    ) internal view returns (
        Common.InstrumentGroup[] memory,
        CashLadder[] memory
    ) {
        uint8[] memory groupIds = new uint8[](portfolio.length);
        uint256 numGroups;

        groupIds[numGroups] = portfolio[0].instrumentGroupId;
        // Count the number of instrument groups in the portfolio, we will return a cash ladder for each. For
        // now, each instrument group corresponds to one currency group.
        for (uint256 i = 1; i < portfolio.length; i++) {
            if (portfolio[i].instrumentGroupId != groupIds[numGroups]) {
                numGroups++;
                groupIds[numGroups] = portfolio[i].instrumentGroupId;
            }
        }

        uint8[] memory requestGroups = new uint8[](numGroups + 1);
        for (uint256 i; i < requestGroups.length; i++) {
            requestGroups[i] = groupIds[i];
        }

        Common.InstrumentGroup[] memory igs = Portfolios().getInstrumentGroups(requestGroups);

        CashLadder[] memory ladders = new CashLadder[](igs.length);
        for (uint256 i; i < ladders.length; i++) {
            ladders[i].id = requestGroups[i];
            ladders[i].currency = igs[i].currency;
            ladders[i].cashLadder = new int256[](igs[i].numPeriods);
        }

        return (igs, ladders);
    }
}