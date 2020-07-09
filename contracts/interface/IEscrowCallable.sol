pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../utils/Common.sol";

interface IEscrowCallable {
    function isTradableCurrency(uint16 currency) external view returns (bool);
    function getNetBalances(address account) external view returns (Common.AccountBalance[] memory);
    function convertBalancesToETH(uint128[] calldata amounts) external view returns (uint128[] memory);
    function portfolioSettleCash(address account, int256[] calldata settledCash) external;
    function unlockCollateral(uint16 currency, address futureCashMarket, int256 amount) external;

    function depositIntoMarket(
        address account,
        address collateralToken,
        uint8 futureCashGroupId,
        uint128 value,
        uint128 fee
    ) external;
    function withdrawFromMarket(
        address account,
        address collateralToken,
        uint8 futureCashGroupId,
        uint128 value,
        uint128 fee
    ) external;
}