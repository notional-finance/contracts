pragma solidity ^0.6.0;

import "../utils/Common.sol";

contract PortfoliosStorage {
    uint8 internal constant MAX_FUTURE_CASH_GROUPS = 0xFE;

    // This is used when referencing a asset that does not exist.
    Common.Asset internal NULL_ASSET;

    // Mapping between accounts and their assets
    mapping(address => Common.Asset[]) internal _accountAssets;

    // Mapping between future cash group ids and future cash groups
    mapping(uint8 => Common.FutureCashGroup) public futureCashGroups;
    // The current future cash group id, 0 is unused
    uint8 public currentFutureCashGroupId;

    /****** Governance Parameters ******/

    // Number of currency groups, set by the Escrow account.
    uint16 public G_NUM_CURRENCIES;
    // This is the max number of assets that can be in a portfolio. This is to prevent idiosyncratic assets from
    // building up in portfolios such that they can't be liquidated due to gas cost restrictions.
    uint256 public G_MAX_ASSETS;

    /****** Governance Parameters ******/

}