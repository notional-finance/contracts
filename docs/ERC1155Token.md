# ERC1155Token

Implements the ERC1155 token standard for transferring future cash tokens within Swapnet. ERC1155 ids
encode an identifier that represents assets that are fungible with each other. For example, two future cash tokens
that asset in the same market and mature at the same time are fungible with each other and therefore will have the
same id. `CASH_PAYER` tokens are not transferrable because they have negative value.


## Methods
- [`batchOperation(address account, uint32 maxTime, struct Common.Deposit[] deposits, struct Common.Trade[] trades)`](#batchOperation)
- [`batchOperationWithdraw(address account, uint32 maxTime, struct Common.Deposit[] deposits, struct Common.Trade[] trades, struct Common.Withdraw[] withdraws)`](#batchOperationWithdraw)
- [`safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)`](#safeTransferFrom)
- [`safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] values, bytes data)`](#safeBatchTransferFrom)
- [`balanceOf(address account, uint256 id)`](#balanceOf)
- [`balanceOfBatch(address[] accounts, uint256[] ids)`](#balanceOfBatch)
- [`encodeAssetId(struct Common.Asset asset)`](#encodeAssetId)
- [`encodeAssetId(uint8 futureCashGroupId, uint16 instrumentId, uint32 startTime, uint32 duration, bytes1 swapType)`](#encodeAssetId)
- [`decodeAssetId(uint256 id)`](#decodeAssetId)
- [`setApprovalForAll(address operator, bool approved)`](#setApprovalForAll)
- [`isApprovedForAll(address owner, address operator)`](#isApprovedForAll)

## Events
- [`BatchOperation(address account, address operator)`](#BatchOperation)

## Governance Methods
- [`setBridgeProxy(address bridgeProxy)`](#setBridgeProxy)

# Methods
### `batchOperation`
> Allows batch operations of deposits and trades. Approved operators are allowed to call this function
on behalf of accounts.
#### Parameters:
- `account`: account for which the operation will take place
- `maxTime`: after this time the operation will fail
- `deposits`: a list of deposits into the Escrow contract, ERC20 allowance must be in place for the Escrow contract
or these deposits will fail.
- `trades`: a list of trades to place on future cash markets

#### Error Codes:
- TRADE_FAILED_MAX_TIME: the operation will fail due to the set timeout
- UNAUTHORIZED_CALLER: operator is not authorized for the account
- INVALID_CURRENCY: currency specified in deposits is invalid
- MARKET_INACTIVE: maturity is not a valid one
- INSUFFICIENT_BALANCE: insufficient collateral balance (or token balance when removing liquidity)
- INSUFFICIENT_FREE_COLLATERAL: account does not have enough free collateral to place the trade
- OVER_MAX_FUTURE_CASH: [addLiquidity] future cash amount required exceeds supplied maxFutureCash
- OUT_OF_IMPLIED_RATE_BOUNDS: [addLiquidity] depositing collateral would require more future cash than specified
- TRADE_FAILED_TOO_LARGE: [takeCollateral, takeFutureCash] trade is larger than allowed by the governance settings
- TRADE_FAILED_LACK_OF_LIQUIDITY: [takeCollateral, takeFutureCash] there is insufficient liquidity in this maturity to handle the trade
- TRADE_FAILED_SLIPPAGE: [takeCollateral, takeFutureCash] trade is greater than the max implied rate set

***

### `batchOperationWithdraw`
> Allows batch operations of deposits, trades and withdraws. Approved operators are allowed to call this function
on behalf of accounts.
#### Parameters:
- `account`: account for which the operation will take place
- `maxTime`: after this time the operation will fail
- `deposits`: a list of deposits into the Escrow contract, ERC20 allowance must be in place for the Escrow contract
or these deposits will fail.
- `trades`: a list of trades to place on future cash markets
- `withdraws`: a list of withdraws, if amount is set to zero will attempt to withdraw the account's entire balance
of the specified currency. This is useful for borrowing when the exact exchange rate is not known ahead of time.

#### Error Codes:
- TRADE_FAILED_MAX_TIME: the operation will fail due to the set timeout
- UNAUTHORIZED_CALLER: operator is not authorized for the account
- INVALID_CURRENCY: currency specified in deposits is invalid
- MARKET_INACTIVE: maturity is not a valid one
- INSUFFICIENT_BALANCE: insufficient collateral balance (or token balance when removing liquidity)
- INSUFFICIENT_FREE_COLLATERAL: account does not have enough free collateral to place the trade
- OVER_MAX_FUTURE_CASH: [addLiquidity] future cash amount required exceeds supplied maxFutureCash
- OUT_OF_IMPLIED_RATE_BOUNDS: [addLiquidity] depositing collateral would require more future cash than specified
- TRADE_FAILED_TOO_LARGE: [takeCollateral, takeFutureCash] trade is larger than allowed by the governance settings
- TRADE_FAILED_LACK_OF_LIQUIDITY: [takeCollateral, takeFutureCash] there is insufficient liquidity in this maturity to handle the trade
- TRADE_FAILED_SLIPPAGE: [takeCollateral, takeFutureCash] trade is greater than the max implied rate set

***

### `safeTransferFrom`
> Transfers tokens between from and to addresses.
#### Parameters:
- `from`: Source address
- `to`: Target address
- `id`: ID of the token type
- `value`: Transfer amount
- `data`: Additional data with no specified format, unused by this contract but forwarded unaltered
to the ERC1155TokenReceiver.

#### Error Codes:
- INVALID_ADDRESS: destination address cannot be 0
- INTEGER_OVERFLOW: value cannot overflow uint128
- CANNOT_TRANSFER_PAYER: cannot transfer assets that confer obligations
- CANNOT_TRANSFER_MATURED_ASSET: cannot transfer asset that has matured
- INSUFFICIENT_BALANCE: from account does not have sufficient tokens
- ERC1155_NOT_ACCEPTED: to contract must accept the transfer

***

### `safeBatchTransferFrom`
> Transfers tokens between from and to addresses in batch.
#### Parameters:
- `from`: Source address
- `to`: Target address
- `ids`: IDs of each token type (order and length must match _values array)
- `values`: Transfer amounts per token type (order and length must match _ids array)
- `data`: Additional data with no specified format, unused by this contract but forwarded unaltered
to the ERC1155TokenReceiver.

#### Error Codes:
- INVALID_ADDRESS: destination address cannot be 0
- INTEGER_OVERFLOW: value cannot overflow uint128
- CANNOT_TRANSFER_PAYER: cannot transfer assets that confer obligations
- CANNOT_TRANSFER_MATURED_ASSET: cannot transfer asset that has matured
- INSUFFICIENT_BALANCE: from account does not have sufficient tokens
- ERC1155_NOT_ACCEPTED: to contract must accept the transfer

***

### `balanceOf`
> Get the balance of an account's tokens. For a more complete picture of an account's
portfolio, see the method `Portfolios.getAssets()`
#### Parameters:
- `account`: The address of the token holder
- `id`: ID of the token
#### Return Values:
- The account's balance of the token type requested


***

### `balanceOfBatch`
> Get the balance of multiple account/token pairs. For a more complete picture of an account's
portfolio, see the method `Portfolios.getAssets()`
#### Parameters:
- `accounts`: The addresses of the token holders
- `ids`: ID of the tokens
#### Return Values:
- The account's balance of the token types requested (i.e. balance for each (owner, id) pair)


***

### `encodeAssetId`
> Encodes a asset object into a uint256 id for ERC1155 compatibility
#### Parameters:
- `asset`: the asset object to encode
#### Return Values:
- a uint256 id that is representative of a matching fungible token


***

### `encodeAssetId`
> Encodes a asset object into a uint256 id for ERC1155 compatibility
#### Parameters:
- `futureCashGroupId`: future cash group id
- `instrumentId`: instrument id
- `startTime`: start time
- `duration`: duration in seconds
- `swapType`: swap type identifier
#### Return Values:
- a uint256 id that is representative of a matching fungible token


***

### `decodeAssetId`
> Decodes an ERC1155 id into its attributes
#### Parameters:
- `id`: the asset id to decode


***

### `setApprovalForAll`
> Sets approval for an operator to transfer tokens on the sender's behalf
#### Parameters:
- `operator`: address of the operator
- `approved`: true for complete appoval, false otherwise


***

### `isApprovedForAll`
> Determines if the operator is approved for the owner's account
#### Parameters:
- `owner`: address of the token holder
- `operator`: address of the operator
#### Return Values:
- true for complete appoval, false otherwise


***


# Events
### `BatchOperation`
> Notice that a batch operation occured
#### Parameters:
- `account`: the account that was affected by the operation
- `operator`: the operator that sent the transaction

***


# Governance Methods
### `setBridgeProxy`
> Sets the address of the 0x bridgeProxy that is allowed to mint future cash pairs.
#### Parameters:
- `bridgeProxy`: address of the 0x ERC1155AssetProxy

***
