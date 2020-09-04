pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../utils/Common.sol";

interface IPortfoliosCallable {
    function getAssets(address account) external view returns (Common.Asset[] memory);

    function getFutureCashGroup(uint8 futureCashGroupId) external view returns (Common.FutureCashGroup memory);

    function getFutureCashGroups(uint8[] calldata groupIds) external view returns (Common.FutureCashGroup[] memory);

    function settleMaturedAssets(address account) external;

    function settleMaturedAssetsBatch(address[] calldata account) external;

    function upsertAccountAsset(address account, Common.Asset calldata assets, bool checkFreeCollateral) external;

    function upsertAccountAssetBatch(address account, Common.Asset[] calldata assets, bool checkFreeCollateral) external;

    function mintFutureCashPair(address payer, address receiver, uint8 futureCashGroupId, uint32 maturity, uint128 notional) external;

    function freeCollateral(address account) external returns (int256, int256[] memory, int256[] memory);

    function freeCollateralNoEmit(address account) external returns (int256, int256[] memory, int256[] memory);

    function freeCollateralView(address account) external view returns (int256, int256[] memory, int256[] memory);

    function setNumCurrencies(uint16 numCurrencies) external;

    function transferAccountAsset(
        address from,
        address to,
        bytes1 swapType,
        uint8 futureCashGroupId,
        uint16 instrumentId,
        uint32 maturity,
        uint128 value
    ) external;

    function searchAccountAsset(
        address account,
        bytes1 swapType,
        uint8 futureCashGroupId,
        uint16 instrumentId,
        uint32 maturity
    ) external view returns (Common.Asset memory, uint256);

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
}
