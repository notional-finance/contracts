pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./utils/Common.sol";
import "./utils/Governed.sol";

import "./interface/IERC1155.sol";
import "./interface/IERC1155TokenReceiver.sol";

import "./Portfolios.sol";
import "./Escrow.sol";

import "@openzeppelin/contracts/introspection/IERC165.sol";


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
     * @param _from    Source address
     * @param _to      Target address
     * @param _id      ID of the token type
     * @param _value   Transfer amount
     * @param _data    Additional data with no specified format, MUST be sent unaltered
     *     in call to `onERC1155Received` on `_to`
     */
    function safeTransferFrom(
        address _from,
        address _to,
        uint256 _id,
        uint256 _value,
        bytes calldata _data
    ) external override {
        require(_to != address(0), $$(ErrorCode(INVALID_ADDRESS)));

        _transfer(_from, _to, _id, _value);
        emit TransferSingle(msg.sender, _from, _to, _id, _value);

        // If code size > 0 call onERC1155received
        uint256 codeSize;
        // solium-disable-next-line security/no-inline-assembly
        assembly {
            codeSize := extcodesize(_to)
        }
        if (codeSize > 0) {
            require(
                IERC1155TokenReceiver(_to).onERC1155Received(msg.sender, _from, _id, _value, _data) == ERC1155_ACCEPTED,
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
     * @param _from    Source address
     * @param _to      Target address
     * @param _ids     IDs of each token type (order and length must match _values array)
     * @param _values  Transfer amounts per token type (order and length must match _ids array)
     * @param _data    Additional data with no specified format, MUST be sent unaltered in call
     *      to the `ERC1155TokenReceiver` hook(s) on `_to`
     */
    function safeBatchTransferFrom(
        address _from,
        address _to,
        uint256[] calldata _ids,
        uint256[] calldata _values,
        bytes calldata _data
    ) external override {
        require(_to != address(0), $$(ErrorCode(INVALID_ADDRESS)));

        for (uint256 i; i < _ids.length; i++) {
            _transfer(_from, _to, _ids[i], _values[i]);
        }

        emit TransferBatch(msg.sender, _from, _to, _ids, _values);

        // If code size > 0 call onERC1155received
        uint256 codeSize;
        // solium-disable-next-line security/no-inline-assembly
        assembly {
            codeSize := extcodesize(_to)
        }
        if (codeSize > 0) {
            require(
                IERC1155TokenReceiver(_to).onERC1155BatchReceived(msg.sender, _from, _ids, _values, _data) ==
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
     * @param _from the token holder
     * @param _to the new token holder
     * @param _id the token id
     * @param _value the notional amount to transfer
     */
    function _transfer(address _from, address _to, uint256 _id, uint256 _value) internal {
        uint128 value = uint128(_value);
        require(uint256(value) == _value, $$(ErrorCode(INTEGER_OVERFLOW)));
        // We do not support operators at thispoint.
        require(msg.sender == _from, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        bytes1 swapType = Common.getSwapType(_id);
        // Transfers can only be entitlements to receive which are a net benefit.
        require(Common.isReceiver(swapType), $$(ErrorCode(CANNOT_TRANSFER_PAYER)));

        (uint8 instrumentGroupId, uint16 instrumentId, uint32 startBlock, uint32 duration) = Common.decodeTradeId(
            _id
        );

        Portfolios(contracts[uint256(CoreContracts.Portfolios)]).transferAccountTrade(
            _from,
            _to,
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
     * @param _id     ID of the token
     * @return        The account's balance of the token type requested
     */
    function balanceOf(address account, uint256 _id) external view override returns (uint256) {
        bytes1 swapType = Common.getSwapType(_id);

        ( uint8 instrumentGroupId, uint16 instrumentId, uint32 startBlock, uint32 duration) = Common.decodeTradeId(
            _id
        );
        (Common.Trade memory t, ) = Portfolios(contracts[uint256(CoreContracts.Portfolios)]).searchAccountTrade(
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
     * @param _ids     ID of the tokens
     * @return         The account's balance of the token types requested (i.e. balance for each (owner, id) pair)
     */
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata _ids)
        external
        view
        override
        returns (uint256[] memory)
    {
        uint256[] memory results = new uint256[](accounts.length);

        for (uint256 i; i < accounts.length; i++) {
            results[i] = this.balanceOf(accounts[i], _ids[i]);
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

    function setApprovalForAll(address _operator, bool _approved) external override {
        revert($$(ErrorCode(UNIMPLEMENTED)));
    }

    function isApprovedForAll(address _owner, address _operator) external override view returns (bool) {
        return false;
    }
}
