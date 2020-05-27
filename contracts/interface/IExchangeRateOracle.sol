pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;


interface IExchangeRateOracle {
    function convert(uint256 value) external view returns (uint256);
}
