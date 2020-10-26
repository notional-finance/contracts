// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.6.0;


library SafeUInt128 {
    function add(uint128 a, uint128 b) internal pure returns (uint128) {
        uint128 c = a + b;
        require(c >= a, $$(ErrorCode(UINT128_ADDITION_OVERFLOW)));
        return c;
    }

    /**
     * @notice x-y. You can use add(x,-y) instead.
     * @dev Tests covered by add(x,y)
     */
    function sub(uint128 a, uint128 b) internal pure returns (uint128) {
        uint128 c = a - b;
        require(c <= a, $$(ErrorCode(UINT128_SUBTRACTION_UNDERFLOW)));
        return c;
    }

    function mul(uint128 x, uint128 y) internal pure returns (uint128) {
        if (x == 0) {
            return 0;
        }

        uint128 z = x * y;
        require(z / x == y, $$(ErrorCode(UINT128_MULTIPLICATION_OVERFLOW)));

        return z;
    }

    function div(uint128 x, uint128 y) internal pure returns (uint128) {
        require(y > 0, $$(ErrorCode(UINT128_DIVIDE_BY_ZERO)));
        return x / y;
    }
}
