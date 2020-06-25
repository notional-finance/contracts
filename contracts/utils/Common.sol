pragma solidity ^0.6.4;
pragma experimental ABIEncoderV2;

import "../lib/SafeMath.sol";


/**
 * @notice Contains all the structs and convenience methods for Swapnet contracts.
 */
library Common {
    using SafeMath for uint256;

    bytes1 internal constant MASK_POOL = 0x01;      // 0000 0001
    bytes1 internal constant MASK_NET = 0x02;       // 0000 0010
    bytes1 internal constant MASK_ORDER = 0x04;     // 0000 0100
    bytes1 internal constant MASK_CASH = 0x08;      // 0000 1000

    bytes1 internal constant MASK_PAYER = 0x10;     // 0001 0000
    bytes1 internal constant MASK_RECEIVER = 0x20;  // 0010 0000
    bytes1 internal constant MASK_PERIODIC = 0x80;  // 1000 0000

    int256 internal constant RATE_DECIMALS = 1e9;
    uint128 internal constant DECIMALS = 1e18;
    uint128 internal constant MAX_UINT_128 = (2**128)-1;

    /**
     * The collateral requirement per currency in the portfolio. Only used as an
     * in memory object between the RiskFramework and the freeCollateral calculation.
     */
    struct Requirement {
        // The currency group id that this requirement is for
        uint16 currency;
        // The required collateral in this currency
        int256 requirement;
        // The net present value of the assets in the portfolio in this currency
        int256 npv;
        // The cash ladder for this currency
        int256[] cashLadder;
    }

    /**
     * Each trade object is a 32 byte word stored in the portfolio.
     */
    struct Trade {
        // The instrument group id for this trade
        uint8 instrumentGroupId;
        // The instrument id for this trade
        uint16 instrumentId;
        // The block where this trade will begin to take effect
        uint32 startBlock;
        // The duration of this trade
        uint32 duration;
        // A 1 byte bitfield defined above that contains instrument agnostic
        // information about a trade (i.e. payer or receiver, periodic or nonperiodic)
        bytes1 swapType;
        // The rate for this trade
        uint32 rate;
        // The notional for this trade
        uint128 notional;
    }

    /**
     * Describes a group of instruments that are closely related enough for their risk ladders to net
     * against each other. Also defines the other parameters that will apply to all the instruments in
     * the group such that their risk ladders can net against each other.
     *
     * Each risk ladder is defined by its maturity cadence which maps to an underlying future cash market,
     * therefore each Instrument Group will map to a future cash market called `futureCashMarket`.
     */
    struct InstrumentGroup {
        // The maximum number of future periods that instruments in this group will trade
        uint32 numPeriods;
        // The size of periods (in blocks) for all instruments in this group
        uint32 periodSize;
        // The precision of the discount rate oracle
        uint32 precision;
        // The currency group identifier for this instrument group
        uint16 currency;
        // The discount rate oracle that applies to all instruments in this group
        address futureCashMarket;
        // The address where the risk formula is stored
        address riskFormula;
    }

    struct AccountBalance {
        // Balance of currency net of cash
        int256 netBalance;
        // If the currency can only be used as deposits and cannot be traded
        bool isDepositCurrency;
    }

    /**
     * Checks if a trade is a periodic trade, i.e. it matures on the cadence
     * defined by its Instrument Group.
     */
    function isPeriodic(bytes1 swapType) internal pure returns (bool) {
        return ((swapType & MASK_PERIODIC) == MASK_PERIODIC);
    }

    /**
     * Checks if a trade is a payer, meaning that the trade is an obligation
     * to pay cash when the trade matures.
     */
    function isPayer(bytes1 swapType) internal pure returns (bool) {
        return ((swapType & MASK_PAYER) == MASK_PAYER);
    }

    /**
     * Checks if a trade is a receiver, meaning that the trade is an entitlement
     * to recieve cash when trade matures.
     */
    function isReceiver(bytes1 swapType) internal pure returns (bool) {
        return ((swapType & MASK_RECEIVER) == MASK_RECEIVER);
    }

    /**
     * Checks if a trade is a liquidity token, which represents a claim on collateral
     * and future cash in a future cash market. The liquidity token can only be stored
     * as a receiver in the portfolio, but it can be marked as a payer in memory when
     * the contracts remove liquidity.
     */
    function isLiquidityToken(bytes1 swapType) internal pure returns (bool) {
        return ((swapType & MASK_ORDER) == MASK_ORDER && (swapType & MASK_CASH) == MASK_CASH);
    }

    /**
     * Checks if an object is a future cash token.
     */
    function isCash(bytes1 swapType) internal pure returns (bool) {
        return ((swapType & MASK_ORDER) == 0x00 && (swapType & MASK_CASH) == MASK_CASH);
    }

    function isCashPayer(bytes1 swapType) internal pure returns (bool) {
        return isCash(swapType) && isPayer(swapType);
    }

    function isCashReceiver(bytes1 swapType) internal pure returns (bool) {
        return isCash(swapType) && isReceiver(swapType) && !isLiquidityToken(swapType);
    }

    /**
     * Changes a trade into its counterparty trade.
     */
    function makeCounterparty(bytes1 swapType) internal pure returns (bytes1) {
        if (isPayer(swapType)) {
            return ((swapType & ~(MASK_PAYER)) | MASK_RECEIVER);
        } else {
            return ((swapType & ~(MASK_RECEIVER)) | MASK_PAYER);
        }
    }

    /**
     * Calculates the maturity of a trade.
     */
    function getMaturity(Trade memory trade) internal pure returns (uint32) {
        return trade.startBlock + trade.duration;
    }

    /**
     * Returns a liquidity token swap type, this is marked as receiver that
     * will be stored in the portfolio.
     */
    function getLiquidityToken() internal pure returns (bytes1) {
        return MASK_RECEIVER | MASK_CASH | MASK_PERIODIC | MASK_ORDER;
    }

    function getCashPayer() internal pure returns (bytes1) {
        return MASK_PAYER | MASK_CASH | MASK_PERIODIC;
    }

    function getCashReceiver() internal pure returns (bytes1) {
        return MASK_RECEIVER | MASK_CASH | MASK_PERIODIC;
    }

    /**
     * Returns the swap type from an encoded trade id.
     */
    function getSwapType(uint256 id) internal pure returns (bytes1) {
        return bytes1(bytes32(id) << 248);
    }

    /**
     * Creates a 32 byte trade id from a trade object. This is used to represent the trade in
     * the ERC1155 token standard. The actual id is located in the least significant 12 bytes
     * of the id. The ordering of the elements in the id are important because they define how
     * a portfolio will be sorted by `Common._sortPortfolio`.
     */
    function encodeTradeId(Trade memory trade) internal pure returns (uint256) {
        bytes12 id = (bytes12(bytes1(trade.instrumentGroupId)) & 0xFF0000000000000000000000) |
            ((bytes12(bytes2(trade.instrumentId)) >> 8) & 0x00FFFF000000000000000000) |
            ((bytes12(bytes4(trade.startBlock)) >> 24) & 0x000000FFFFFFFF0000000000) |
            ((bytes12(bytes4(trade.duration)) >> 56) & 0x00000000000000FFFFFFFF00) |
            ((bytes12(trade.swapType) >> 88) & 0x0000000000000000000000FF);

        return uint256(bytes32(id) >> 160);
    }

    /**
     * Decodes a uint256 id for a trade
     *
     * @param _id a uint256 trade id
     * @return (instrumentGroupId, instrumentId, startBlock, duration)
     */
    function decodeTradeId(uint256 _id) internal pure returns (uint8, uint16, uint32, uint32) {
        bytes12 id = bytes12(bytes32(_id) << 160);
        return (
            // Instrument Group Id
            uint8(bytes1((id & 0xFF0000000000000000000000))),
            // Instrument Id
            uint16(bytes2((id & 0x00FFFF000000000000000000) << 8)),
            // Start Block
            uint32(bytes4((id & 0x000000FFFFFFFF0000000000) << 24)),
            // Duration
            uint32(bytes4((id & 0x00000000000000FFFFFFFF00) << 56))
        );
    }

    /**
     * Does a quicksort of the portfolio by the 256 bit id. This sorting is used in a few
     * algorithms to ensure that they work properly.
     * @dev TODO: change this to a heapsort or mergesort
     *
     * @param data the in memory portfolio to sort
     */
    function _sortPortfolio(Trade[] memory data) internal pure returns (Trade[] memory) {
        if (data.length > 0) {
            _quickSort(data, int256(0), int256(data.length - 1));
        }
        return data;
    }

    function _quickSort(Trade[] memory data, int256 left, int256 right) internal pure {
        if (left == right) return;
        int256 i = left;
        int256 j = right;

        uint256 pivot = encodeTradeId(data[uint256(left + (right - left) / 2)]);
        while (i <= j) {
            while (encodeTradeId(data[uint256(i)]) < pivot) i++;
            while (pivot < encodeTradeId(data[uint256(j)])) j--;
            if (i <= j) {
                // Swap positions
                (data[uint256(i)], data[uint256(j)]) = (data[uint256(j)], data[uint256(i)]);
                i++;
                j--;
            }
        }

        if (left < j) _quickSort(data, left, j);
        if (i < right) _quickSort(data, i, right);
    }
}
