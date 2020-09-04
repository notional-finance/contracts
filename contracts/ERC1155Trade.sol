pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./utils/Common.sol";
import "./utils/ERC1155Base.sol";

import "./interface/IERC1155.sol";
import "./interface/IERC1155TokenReceiver.sol";

import "./FutureCash.sol";

/**
 * @notice Implements the ERC1155 token standard for transferring future cash tokens within Swapnet. ERC1155 ids
 * encode an identifier that represents assets that are fungible with each other. For example, two future cash tokens
 * that asset in the same market and mature at the same time are fungible with each other and therefore will have the
 * same id. `CASH_PAYER` tokens are not transferrable because they have negative value.
 */
contract ERC1155Trade is ERC1155Base {
    address public BRIDGE_PROXY;

    struct TradeRecord {
        uint16 currencyId;
        Common.TradeType tradeType;
        uint128 collateral;
    }

    /**
     * @notice Notice that a batch operation occured
     * @param account the account that was affected by the operation
     * @param operator the operator that sent the transaction
     */
    event BatchOperation(address indexed account, address indexed operator);

    /**
     * @notice Sets the address of the 0x bridgeProxy that is allowed to mint future cash pairs.
     * @dev governance
     * @param bridgeProxy address of the 0x ERC1155AssetProxy
     */
    function setBridgeProxy(address bridgeProxy) external onlyOwner {
        BRIDGE_PROXY = bridgeProxy;
    }

    /**
     * @notice Allows batch operations of deposits and trades. Approved operators are allowed to call this function
     * on behalf of accounts.
     * @dev - TRADE_FAILED_MAX_TIME: the operation will fail due to the set timeout
     * - UNAUTHORIZED_CALLER: operator is not authorized for the account
     * - INVALID_CURRENCY: currency specified in deposits is invalid
     * - MARKET_INACTIVE: maturity is not a valid one
     * - INSUFFICIENT_BALANCE: insufficient collateral balance (or token balance when removing liquidity)
     * - INSUFFICIENT_FREE_COLLATERAL: account does not have enough free collateral to place the trade
     * - OVER_MAX_FUTURE_CASH: [addLiquidity] future cash amount required exceeds supplied maxFutureCash
     * - OUT_OF_IMPLIED_RATE_BOUNDS: [addLiquidity] depositing collateral would require more future cash than specified
     * - TRADE_FAILED_TOO_LARGE: [takeCollateral, takeFutureCash] trade is larger than allowed by the governance settings
     * - TRADE_FAILED_LACK_OF_LIQUIDITY: [takeCollateral, takeFutureCash] there is insufficient liquidity in this maturity to handle the trade
     * - TRADE_FAILED_SLIPPAGE: [takeCollateral, takeFutureCash] trade is greater than the max implied rate set
     * @param account account for which the operation will take place
     * @param maxTime after this time the operation will fail
     * @param deposits a list of deposits into the Escrow contract, ERC20 allowance must be in place for the Escrow contract
     * or these deposits will fail.
     * @param trades a list of trades to place on future cash markets
     */
    function batchOperation(
        address account,
        uint32 maxTime,
        Common.Deposit[] memory deposits,
        Common.Trade[] memory trades
    ) public payable {
        uint32 blockTime = uint32(block.timestamp);
        require(blockTime <= maxTime, $$(ErrorCode(TRADE_FAILED_MAX_TIME)));
        require(msg.sender == account || isApprovedForAll(account, msg.sender), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        if (deposits.length > 0 || msg.value != 0) Escrow().depositsOnBehalf{value: msg.value}(account, deposits);
        if (trades.length > 0) _batchTrade(account, trades);

        (int256 fc, /* int256[] memory */, /* int256[] memory */) = Portfolios().freeCollateral(account);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        emit BatchOperation(account, msg.sender);
    }

    /**
     * @notice Allows batch operations of deposits, trades and withdraws. Approved operators are allowed to call this function
     * on behalf of accounts.
     * @dev - TRADE_FAILED_MAX_TIME: the operation will fail due to the set timeout
     * - UNAUTHORIZED_CALLER: operator is not authorized for the account
     * - INVALID_CURRENCY: currency specified in deposits is invalid
     * - MARKET_INACTIVE: maturity is not a valid one
     * - INSUFFICIENT_BALANCE: insufficient collateral balance (or token balance when removing liquidity)
     * - INSUFFICIENT_FREE_COLLATERAL: account does not have enough free collateral to place the trade
     * - OVER_MAX_FUTURE_CASH: [addLiquidity] future cash amount required exceeds supplied maxFutureCash
     * - OUT_OF_IMPLIED_RATE_BOUNDS: [addLiquidity] depositing collateral would require more future cash than specified
     * - TRADE_FAILED_TOO_LARGE: [takeCollateral, takeFutureCash] trade is larger than allowed by the governance settings
     * - TRADE_FAILED_LACK_OF_LIQUIDITY: [takeCollateral, takeFutureCash] there is insufficient liquidity in this maturity to handle the trade
     * - TRADE_FAILED_SLIPPAGE: [takeCollateral, takeFutureCash] trade is greater than the max implied rate set
     * @param account account for which the operation will take place
     * @param maxTime after this time the operation will fail
     * @param deposits a list of deposits into the Escrow contract, ERC20 allowance must be in place for the Escrow contract
     * or these deposits will fail.
     * @param trades a list of trades to place on future cash markets
     * @param withdraws a list of withdraws, if amount is set to zero will attempt to withdraw the account's entire balance
     * of the specified currency. This is useful for borrowing when the exact exchange rate is not known ahead of time.
     */
    function batchOperationWithdraw(
        address account,
        uint32 maxTime,
        Common.Deposit[] memory deposits,
        Common.Trade[] memory trades,
        Common.Withdraw[] memory withdraws
    ) public payable {
        uint32 blockTime = uint32(block.timestamp);
        require(blockTime <= maxTime, $$(ErrorCode(TRADE_FAILED_MAX_TIME)));
        require(msg.sender == account || isApprovedForAll(account, msg.sender), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        TradeRecord[] memory tradeRecord;
        if (deposits.length > 0 || msg.value != 0) Escrow().depositsOnBehalf{value: msg.value}(account, deposits);
        if (trades.length > 0) tradeRecord = _batchTrade(account, trades);
        if (withdraws.length > 0) {
            if (tradeRecord.length > 0 && (deposits.length > 0 || msg.value != 0)) {
                _updateWithdrawsWithTradeRecord(tradeRecord, deposits, withdraws);
            }

            Escrow().withdrawsOnBehalf(account, withdraws);
        }

        (int256 fc, /* int256[] memory */, /* int256[] memory */) = Portfolios().freeCollateral(account);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        emit BatchOperation(account, msg.sender);
    }

    /**
     * @notice Transfers tokens between from and to addresses.
     * @dev - UNAUTHORIZED_CALLER: calling contract must be approved by both from / to addresses or be the 0x proxy
     * - OVER_MAX_UINT128_AMOUNT: amount specified cannot be greater than MAX_UINT128
     * - INVALID_SWAP: the asset id specified can only be of CASH_PAYER or CASH_RECEIVER types
     * - INVALID_CURRENCY: the currency id specified is invalid
     * - INVALID_CURRENCY: the currency id specified is invalid
     * @param from Source address
     * @param to Target address
     * @param id ID of the token type
     * @param value Transfer amount
     * @param data Additional data with no specified format, unused by this contract but forwarded unaltered
     * to the ERC1155TokenReceiver.
     */
    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external override {
        require(
            msg.sender == BRIDGE_PROXY ||
            (from == msg.sender && isApprovedForAll(to, from)) ||
            (isApprovedForAll(from, msg.sender) && isApprovedForAll(to, msg.sender)),
            $$(ErrorCode(UNAUTHORIZED_CALLER))
        );
        require(value <= Common.MAX_UINT_128, $$(ErrorCode(OVER_MAX_UINT128_AMOUNT)));


        Common.Deposit[] memory deposits;
        if (data.length > 0) deposits = abi.decode(data, (Common.Deposit[]));

        bytes1 swapType = Common.getSwapType(id);
        (uint8 futureCashGroupId, /* uint16 */ , uint32 maturity) = Common.decodeAssetId(id);

        if (Common.isCashPayer(swapType)) {
            // (payer, receiver) = (to, from);
            if (data.length > 0) Escrow().depositsOnBehalf(to, deposits);

            // This does a free collateral check inside.
            Portfolios().mintFutureCashPair(to, from, futureCashGroupId, maturity, uint128(value));
        } else if (Common.isCashReceiver(swapType)) {
            // (payer, receiver) = (from, to);
            if (data.length > 0) Escrow().depositsOnBehalf(from, deposits);

            // This does a free collateral check inside.
            Portfolios().mintFutureCashPair(from, to, futureCashGroupId, maturity, uint128(value));
        } else {
            revert($$(ErrorCode(INVALID_SWAP)));
        }

        emit TransferSingle(msg.sender, from, to, id, value);
    }

    function safeBatchTransferFrom(
        address /* _from */,
        address /* _to */,
        uint256[] calldata /* _ids */,
        uint256[] calldata /* _values */,
        bytes calldata /* _data */
    ) external override {
        revert($$(ErrorCode(UNIMPLEMENTED)));
    }

    /**
     * @notice Decodes the slippage data parameter and places trades on the future cash groups
     */
    function _batchTrade(address account, Common.Trade[] memory trades) internal returns (TradeRecord[] memory) {
        TradeRecord[] memory tradeRecord = new TradeRecord[](trades.length);

        for (uint256 i; i < trades.length; i++) {
            Common.FutureCashGroup memory fcg = Portfolios().getFutureCashGroup(trades[i].futureCashGroup);
            FutureCash fc = FutureCash(fcg.futureCashMarket);

            if (trades[i].tradeType == Common.TradeType.TakeCollateral) {
                uint32 maxRate;
                if (trades[i].slippageData.length == 32) {
                    maxRate = abi.decode(trades[i].slippageData, (uint32));
                } else {
                    maxRate = Common.MAX_UINT_32;
                }

                tradeRecord[i].currencyId = fcg.currency;
                tradeRecord[i].tradeType = Common.TradeType.TakeCollateral;
                tradeRecord[i].collateral = fc.takeCollateralOnBehalf(account, trades[i].maturity, trades[i].amount, maxRate);
            } else if (trades[i].tradeType == Common.TradeType.TakeFutureCash) {
                uint32 minRate;
                if (trades[i].slippageData.length == 32) {
                    minRate = abi.decode(trades[i].slippageData, (uint32));
                }

                tradeRecord[i].currencyId = fcg.currency;
                tradeRecord[i].tradeType = Common.TradeType.TakeFutureCash;
                tradeRecord[i].collateral = fc.takeFutureCashOnBehalf(account, trades[i].maturity, trades[i].amount, minRate);
            } else if (trades[i].tradeType == Common.TradeType.AddLiquidity) {
                uint32 minRate;
                uint32 maxRate;
                uint128 maxFutureCash;
                if (trades[i].slippageData.length == 64) {
                    (minRate, maxRate) = abi.decode(trades[i].slippageData, (uint32, uint32));
                    maxFutureCash = Common.MAX_UINT_128;
                } else if (trades[i].slippageData.length == 96) {
                    (minRate, maxRate, maxFutureCash) = abi.decode(trades[i].slippageData, (uint32, uint32, uint128));
                } else {
                    maxRate = Common.MAX_UINT_32;
                    maxFutureCash = Common.MAX_UINT_128;
                }

                // Add Liquidity always adds the specified amount of collateral or it fails out so we don't create a trade
                // record here.
                tradeRecord[i].currencyId = fcg.currency;
                tradeRecord[i].tradeType = Common.TradeType.AddLiquidity;
                fc.addLiquidityOnBehalf(account, trades[i].maturity, trades[i].amount, maxFutureCash, minRate, maxRate);
            } else if (trades[i].tradeType == Common.TradeType.RemoveLiquidity) {
                tradeRecord[i].currencyId = fcg.currency;
                tradeRecord[i].tradeType = Common.TradeType.RemoveLiquidity;
                tradeRecord[i].collateral = fc.removeLiquidityOnBehalf(account, trades[i].maturity, trades[i].amount);
            }
        }

        return tradeRecord;
    }

    function _updateWithdrawsWithTradeRecord(
        TradeRecord[] memory tradeRecord,
        Common.Deposit[] memory deposits,
        Common.Withdraw[] memory withdraws
    ) internal pure {
        // We look for records of withdraw.amount == 0 in order to update the amount for the
        // residuals from the trade record.
        for (uint256 i; i < withdraws.length; i++) {
            if (withdraws[i].amount == 0) {
                withdraws[i].amount = _calculateWithdrawAmount(
                    withdraws[i].currencyId,
                    tradeRecord,
                    deposits
                );
            }
        }
    }

    function _calculateWithdrawAmount(
        uint16 currencyId,
        TradeRecord[] memory tradeRecord,
        Common.Deposit[] memory deposits
    ) internal pure returns (uint128) {
        uint128 depositResidual;
        uint128 withdrawAmount;

        for (uint256 i; i < deposits.length; i++) {
            if (deposits[i].currencyId == currencyId) {
                // First seek the deposit array to find the deposit residual
                depositResidual = deposits[i].amount;
                break;
            }
        }

        for (uint256 i; i < tradeRecord.length; i++) {
            if (tradeRecord[i].currencyId != currencyId) continue;

            if (tradeRecord[i].tradeType == Common.TradeType.TakeCollateral
                || tradeRecord[i].tradeType == Common.TradeType.RemoveLiquidity) {
                // This is the amount of collateral that was taken from the market
                withdrawAmount = withdrawAmount + tradeRecord[i].collateral;
            } else if (tradeRecord[i].tradeType == Common.TradeType.TakeFutureCash) {
                // This is the residual from the deposit that was not put into the market. We floor this value at
                // zero to avoid an overflow.
                depositResidual = depositResidual < tradeRecord[i].collateral ? 0 : depositResidual - tradeRecord[i].collateral;
            }
        }

        return withdrawAmount + depositResidual;
    }
}
