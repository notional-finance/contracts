pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./utils/Common.sol";
import "./utils/Governed.sol";

import "./interface/IERC1155.sol";
import "./interface/IERC1155TokenReceiver.sol";
import "./interface/IERC165.sol";


/**
 * @title ERC1155 Token Standard
 * @notice Implements the ERC1155 token standard for Swapnet. All swaps, future cash and liquidity tokens
 * in a portfolio can be represented by the ERC1155 standard.
 */
contract ERC1155Token is Governed, IERC1155, IERC165 {

    // bytes4(keccak256("onERC1155Received(address,address,uint256,uint256,bytes)"))
    bytes4 internal constant ERC1155_ACCEPTED = 0xf23a6e61;
    // bytes4(keccak256("onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)"))
    bytes4 internal constant ERC1155_BATCH_ACCEPTED = 0xbc197c81;
    bytes4 internal constant ERC1155_INTERFACE = 0xd9b67a26;

    mapping(address => mapping(address => bool)) public operators;

    /**
     * ERC165 compatibility for ERC1155
     */
    function supportsInterface(bytes4 interfaceId) external override view returns (bool) {
        if (interfaceId == ERC1155_INTERFACE) return true;
    }

    /**
     * @notice Transfers `_value` amount of an `id` from the `_from` address to the
     * `_to` address specified (with safety call).
     *
     * @dev Caller must be approved to manage the tokens being transferred out of the
     * `_from` account (see "Approval" section of the standard).
     * @param from    Source address
     * @param to      Target address
     * @param id      ID of the token type
     * @param value   Transfer amount
     * @param data    Additional data with no specified format, MUST be sent unaltered
     *     in call to `onERC1155Received` on `_to`
     */
    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external override {
        _transfer(from, to, id, value);
        emit TransferSingle(msg.sender, from, to, id, value);

        // If code size > 0 call onERC1155received
        uint256 codeSize;
        // solium-disable-next-line security/no-inline-assembly
        assembly {
            codeSize := extcodesize(to)
        }
        if (codeSize > 0) {
            require(
                IERC1155TokenReceiver(to).onERC1155Received(msg.sender, from, id, value, data) == ERC1155_ACCEPTED,
                $$(ErrorCode(ERC1155_NOT_ACCEPTED))
            );
        }
    }

    /**
     * @notice Transfers `_values` amount(s) of `_ids` from the `_from` address to
     * the `_to` address specified (with safety call).
     *
     * @dev Caller must be approved to manage the tokens being transferred out of the
     * `_from` account (see "Approval" section of the standard).
     * @param from    Source address
     * @param to      Target address
     * @param ids     IDs of each token type (order and length must match _values array)
     * @param values  Transfer amounts per token type (order and length must match _ids array)
     * @param data    Additional data with no specified format, MUST be sent unaltered in call
     *      to the `ERC1155TokenReceiver` hook(s) on `_to`
     */
    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external override {
        for (uint256 i; i < ids.length; i++) {
            _transfer(from, to, ids[i], values[i]);
        }

        emit TransferBatch(msg.sender, from, to, ids, values);

        // If code size > 0 call onERC1155received
        uint256 codeSize;
        // solium-disable-next-line security/no-inline-assembly
        assembly {
            codeSize := extcodesize(to)
        }
        if (codeSize > 0) {
            require(
                IERC1155TokenReceiver(to).onERC1155BatchReceived(msg.sender, from, ids, values, data) ==
                    ERC1155_BATCH_ACCEPTED,
                $$(ErrorCode(ERC1155_NOT_ACCEPTED))
            );
        }
    }

    /**
     * Internal method for validating and updating state within a transfer.
     * @dev batch updates can be made a lot more efficient by not looping through this
     * code and updating storage on each loop, we can do it in memory and then flush to
     * storage just once.
     *
     * @param from the token holder
     * @param to the new token holder
     * @param id the token id
     * @param _value the notional amount to transfer
     */
    function _transfer(address from, address to, uint256 id, uint256 _value) internal {
        require(to != address(0), $$(ErrorCode(INVALID_ADDRESS)));
        uint128 value = uint128(_value);
        require(uint256(value) == _value, $$(ErrorCode(INTEGER_OVERFLOW)));
        require(msg.sender == from || isApprovedForAll(from, msg.sender), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        bytes1 swapType = Common.getSwapType(id);
        // Transfers can only be entitlements to receive which are a net benefit.
        require(Common.isReceiver(swapType), $$(ErrorCode(CANNOT_TRANSFER_PAYER)));

        (uint8 instrumentGroupId, uint16 instrumentId, uint32 startBlock, uint32 duration) = Common.decodeTradeId(
            id
        );
        require(startBlock + duration > block.number, $$(ErrorCode(CANNOT_TRANSFER_MATURED_TRADE)));

        Portfolios().transferAccountTrade(
            from,
            to,
            swapType,
            instrumentGroupId,
            instrumentId,
            startBlock,
            duration,
            value
        );
    }

    /**
     * Get the balance of an account's tokens. This method is implemented for ERC1155 compatibility,
     * but is not very useful for most Swapnet functionality.
     *
     * @param account  The address of the token holder
     * @param id     ID of the token
     * @return        The account's balance of the token type requested
     */
    function balanceOf(address account, uint256 id) external view override returns (uint256) {
        bytes1 swapType = Common.getSwapType(id);

        (uint8 instrumentGroupId, uint16 instrumentId, uint32 startBlock, uint32 duration) = Common.decodeTradeId(
            id
        );
        (Common.Trade memory t, ) = Portfolios().searchAccountTrade(
            account,
            swapType,
            instrumentGroupId,
            instrumentId,
            startBlock,
            duration
        );

        return uint256(t.notional);
    }

    /**
     * Get the balance of multiple account/token pairs.
     *
     * @param accounts The addresses of the token holders
     * @param ids     ID of the tokens
     * @return         The account's balance of the token types requested (i.e. balance for each (owner, id) pair)
     */
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids)
        external
        view
        override
        returns (uint256[] memory)
    {
        uint256[] memory results = new uint256[](accounts.length);

        for (uint256 i; i < accounts.length; i++) {
            results[i] = this.balanceOf(accounts[i], ids[i]);
        }

        return results;
    }

    /**
     * @notice Encodes a set of identifying characteristics of a swap into an uint256 id
     *
     * @param trade the trade object to encode
     */
    function encodeTradeId(Common.Trade calldata trade) external pure returns (uint256) {
        return Common.encodeTradeId(trade);
    }

    /**
     * @notice Decodes an id into its subparts
     *
     * @param id the trade id to decode
     * @return (instrumentGroupId, instrumentId, startBlock, duration, swapType)
     */
    function decodeTradeId(
        uint256 id
    ) external pure returns (uint8, uint16, uint32, uint32, bytes1) {
        bytes1 swapType = Common.getSwapType(id);
        (uint8 instrumentGroupId, uint16 instrumentId, uint32 startBlock, uint32 duration) = Common.decodeTradeId(
            id
        );

        return (
            instrumentGroupId,
            instrumentId,
            startBlock,
            duration,
            swapType
        );
    }

    function setApprovalForAll(address operator, bool approved) external override {
        operators[msg.sender][operator] = approved;
    }

    function isApprovedForAll(address owner, address operator) public override view returns (bool) {
        return operators[owner][operator];
    }
}
