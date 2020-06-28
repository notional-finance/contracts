pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../utils/Common.sol";

interface IPortfoliosCallable {
    function getTrades(address account) external view returns (Common.Trade[] memory);
    function getInstrumentGroup(uint8 instrumentGroupId) external view returns (Common.InstrumentGroup memory);
    function getInstrumentGroups(uint8[] calldata groupIds) external view returns (Common.InstrumentGroup[] memory);
    function settleAccount(address account) external;
    function settleAccountBatch(address[] calldata account) external;
    function upsertAccountTrade(address account, Common.Trade calldata trades) external;
    function upsertAccountTradeBatch(address account, Common.Trade[] calldata trades) external;
    function freeCollateral(address account) external returns (int256, uint128[] memory);
    function setNumCurrencies(uint16 numCurrencies) external;

    function transferAccountTrade(
        address from,
        address to,
        bytes1 swapType,
        uint8 instrumentGroupId,
        uint16 instrumentId,
        uint32 startBlock,
        uint32 duration,
        uint128 value
    ) external;

    function searchAccountTrade(
        address account,
        bytes1 swapType,
        uint8 instrumentGroupId,
        uint16 instrumentId,
        uint32 startBlock,
        uint32 duration
    ) external view returns (Common.Trade memory, uint256);

    function raiseCollateralViaLiquidityToken(
        address account,
        uint16 currency,
        uint128 amount
    ) external returns (uint128);

    function raiseCollateralViaCashReceiver(
        address account,
        uint16 currency,
        uint128 amount
    ) external returns (uint128);

    function repayCashPayer(
        address account,
        uint16 currency,
        uint128 amount
    ) external returns (uint128);
}
