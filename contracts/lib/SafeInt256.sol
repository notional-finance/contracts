pragma solidity ^0.6.0;


library SafeInt256 {
    /**
     * @notice x+y. If any operator is higher than maxFixedAdd() it
     * might overflow.
     * In solidity maxInt256 + 1 = minInt256 and viceversa.
     * @dev
     * Test add(maxFixedAdd(),maxFixedAdd()) returns maxInt256()-1
     * Test add(maxFixedAdd()+1,maxFixedAdd()+1) fails
     * Test add(-maxFixedSub(),-maxFixedSub()) returns minInt256()
     * Test add(-maxFixedSub()-1,-maxFixedSub()-1) fails
     * Test add(maxInt256(),maxInt256()) fails
     * Test add(minInt256(),minInt256()) fails
     */
    function add(int256 x, int256 y) internal pure returns (int256) {
        int256 z = x + y;
        if (x > 0 && y > 0) require(z > x && z > y, $$(ErrorCode(INT256_ADDITION_OVERFLOW)));
        if (x < 0 && y < 0) require(z < x && z < y, $$(ErrorCode(INT256_ADDITION_OVERFLOW)));
        return z;
    }

    /**
     * @notice x-y. You can use add(x,-y) instead.
     * @dev Tests covered by add(x,y)
     */
    function sub(int256 x, int256 y) internal pure returns (int256) {
        return add(x, neg(y));
    }

    function mul(int256 x, int256 y) internal pure returns (int256) {
        if (x == 0) {
            return 0;
        }

        int256 z = x * y;
        require(z / x == y, $$(ErrorCode(INT256_MULTIPLICATION_OVERFLOW)));

        return z;
    }

    function div(int256 x, int256 y) internal pure returns (int256) {
        require(y > 0, $$(ErrorCode(INT256_DIVIDE_BY_ZERO)));
        return x / y;
    }

    function abs(int256 x) internal pure returns (int256) {
        if (x < 0) return -x;
        else return x;
    }

    function neg(int256 x) internal pure returns (int256) {
        require(x != (-2**255), $$(ErrorCode(INT256_NEGATE_MIN_INT)));
        return -x;
    }
}
