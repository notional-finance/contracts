pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../utils/Common.sol";

/**
 * @title Swapnet risk and valuation framework
 * Note: The ERC-165 identifier for this interface is <TODO>
 */
interface IRiskFramework /* is IERC165 */ {

    /**
     * Calculates the collateral requirements given a list of trades.
     *
     * @param trades a list of positions
     * @return an array of requirements, one per collateral type
     */
    function getRequirement(Common.Trade[] calldata trades) external view returns (Common.Requirement[] memory);

}