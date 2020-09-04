pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../utils/Common.sol";

/**
 * @title Swapnet risk and valuation framework
 */
interface IRiskFramework /* is IERC165 */ {

    /**
     * Calculates the collateral requirements given a list of assets.
     *
     * @param assets a list of positions
     * @return an array of requirements, one per collateral type
     */
    function getRequirement(Common.Asset[] calldata assets) external view returns (Common.Requirement[] memory);

}