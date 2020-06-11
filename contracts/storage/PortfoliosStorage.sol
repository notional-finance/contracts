pragma solidity ^0.6.0;

import "../utils/Common.sol";

contract PortfoliosStorage {
    uint8 internal constant MAX_INSTRUMENT_GROUPS = 0xFE;

    // This is used when referencing a trade that does not exist.
    Common.Trade internal NULL_TRADE;

    // Mapping between accounts and their trades
    mapping(address => Common.Trade[]) internal _accountTrades;

    // Mapping between instrument group ids and instrument groups
    mapping(uint8 => Common.InstrumentGroup) public instrumentGroups;
    // The current instrument group id, 0 is unused
    uint8 public currentInstrumentGroupId;

    /****** Governance Parameters ******/

    // This is the max number of trades that can be in a portfolio. This is set so that we don't end up with massive
    // portfolios that can't be liquidated due to gas cost restrictions.
    uint256 public G_MAX_TRADES;
    // Number of currency groups, set by the Escrow account.
    uint16 public G_NUM_CURRENCIES;
    // The currency that is used to collateralize obligations. Used in free collateral and set by Escrow.
    uint16 public G_COLLATERAL_CURRENCY;

    /****** Governance Parameters ******/

}