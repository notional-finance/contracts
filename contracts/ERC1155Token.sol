pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./utils/Common.sol";
import "./utils/Governed.sol";

import "./interface/IERC1155.sol";
import "./interface/IERC1155TokenReceiver.sol";
import "./interface/IERC165.sol";


/**
 * @notice Implements the ERC1155 token standard for transferring future cash tokens within Swapnet. ERC1155 ids
 * encode an identifier that represents trades that are fungible with each other. For example, two future cash tokens
 * that trade in the same market and mature on the same block are fungible with each other and therefore will have the
 * same id. `CASH_PAYER` tokens are not transferrable because they have negative value.
 */
contract ERC1155Token is Governed, IERC1155, IERC165 {

    // bytes4(keccak256("onERC1155Received(address,address,uint256,uint256,bytes)"))
    bytes4 internal constant ERC1155_ACCEPTED = 0xf23a6e61;
    // bytes4(keccak256("onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)"))
    bytes4 internal constant ERC1155_BATCH_ACCEPTED = 0xbc197c81;
    bytes4 internal constant ERC1155_INTERFACE = 0xd9b67a26;

    mapping(address => mapping(address => bool)) public operators;

    /**
     * @notice ERC165 compatibility for ERC1155
     * @dev skip
     * @param interfaceId the hash signature of the interface id
     */
    function supportsInterface(bytes4 interfaceId) external override view returns (bool) {
        if (interfaceId == ERC1155_INTERFACE) return true;
    }

    /**
     * @notice Transfers tokens between from and to addresses.
     * @dev - INVALID_ADDRESS: destination address cannot be 0
     *  - INTEGER_OVERFLOW: value cannot overflow uint128
     *  - CANNOT_TRANSFER_PAYER: cannot transfer assets that confer obligations
     *  - CANNOT_TRANSFER_MATURED_TRADE: cannot transfer trade that has matured
     *  - INSUFFICIENT_BALANCE: from account does not have sufficient tokens
     *  - ERC1155_NOT_ACCEPTED: to contract must accept the transfer
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
     * @notice Transfers tokens between from and to addresses in batch.
     * @dev - INVALID_ADDRESS: destination address cannot be 0
     *  - INTEGER_OVERFLOW: value cannot overflow uint128
     *  - CANNOT_TRANSFER_PAYER: cannot transfer assets that confer obligations
     *  - CANNOT_TRANSFER_MATURED_TRADE: cannot transfer trade that has matured
     *  - INSUFFICIENT_BALANCE: from account does not have sufficient tokens
     *  - ERC1155_NOT_ACCEPTED: to contract must accept the transfer
     * @param from Source address
     * @param to Target address
     * @param ids IDs of each token type (order and length must match _values array)
     * @param values Transfer amounts per token type (order and length must match _ids array)
     * @param data Additional data with no specified format, unused by this contract but forwarded unaltered
     * to the ERC1155TokenReceiver.
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
     * @notice Get the balance of an account's tokens. For a more complete picture of an account's
     * portfolio, see the method `Portfolios.getTrades()`
     * @param account The address of the token holder
     * @param id ID of the token
     * @return The account's balance of the token type requested
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
     * @notice Get the balance of multiple account/token pairs. For a more complete picture of an account's
     * portfolio, see the method `Portfolios.getTrades()`
     * @param accounts The addresses of the token holders
     * @param ids ID of the tokens
     * @return The account's balance of the token types requested (i.e. balance for each (owner, id) pair)
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
     * @notice Encodes a trade object into a uint256 id for ERC1155 compatibility
     * @param trade the trade object to encode
     * @return a uint256 id that is representative of a matching fungible token
     */
    function encodeTradeId(Common.Trade calldata trade) external pure returns (uint256) {
        return Common.encodeTradeId(trade);
    }

    /**
     * @notice Decodes an ERC1155 id into its attributes
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

    /**
     * @notice Sets approval for an operator to transfer tokens on the sender's behalf
     * @param operator address of the operator
     * @param approved true for complete appoval, false otherwise
     */
    function setApprovalForAll(address operator, bool approved) external override {
        operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    /**
     * @notice Determines if the operator is approved for the owner's account
     * @param owner address of the token holder
     * @param operator address of the operator
     * @return true for complete appoval, false otherwise
     */
    function isApprovedForAll(address owner, address operator) public override view returns (bool) {
        return operators[owner][operator];
    }
}
