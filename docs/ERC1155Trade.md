# ERC1155Trade

Implements the ERC1155 token standard for trading OTC and batch operations over Notional markets.


## Methods
- [`constructor(address directory)`](#constructor)
- [`batchOperation(address account, uint32 maxTime, struct Common.Deposit[] deposits, struct Common.Trade[] trades)`](#batchOperation)
- [`batchOperationWithdraw(address account, uint32 maxTime, struct Common.Deposit[] deposits, struct Common.Trade[] trades, struct Common.Withdraw[] withdraws)`](#batchOperationWithdraw)
- [`safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)`](#safeTransferFrom)
- [`safeBatchTransferFrom(address, address, uint256[], uint256[], bytes)`](#safeBatchTransferFrom)

## Events
- [`BatchOperation(address account, address operator)`](#BatchOperation)

## Governance Methods
- [`setBridgeProxy(address bridgeProxy)`](#setBridgeProxy)

# Methods
### `constructor`
> No description


***

### `batchOperation`
> Allows batch operations of deposits and trades. Approved operators are allowed to call this function
on behalf of accounts.
#### Parameters:
- `account`: account for which the operation will take place
- `maxTime`: after this time the operation will fail
- `deposits`: a list of deposits into the Escrow contract, ERC20 allowance must be in place for the Escrow contract
or these deposits will fail.
- `trades`: a list of trades to place on fCash markets

#### Error Codes:
- TRADE_FAILED_MAX_TIME: the operation will fail due to the set timeout
- UNAUTHORIZED_CALLER: operator is not authorized for the account
- INVALID_CURRENCY: currency specified in deposits is invalid
- MARKET_INACTIVE: maturity is not a valid one
- INSUFFICIENT_BALANCE: insufficient collateral balance (or token balance when removing liquidity)
- INSUFFICIENT_FREE_COLLATERAL: account does not have enough free collateral to place the trade
- OVER_MAX_FCASH: [addLiquidity] fCash amount required exceeds supplied maxfCash
- OUT_OF_IMPLIED_RATE_BOUNDS: [addLiquidity] depositing collateral would require more fCash than specified
- TRADE_FAILED_TOO_LARGE: [takeCurrentCash, takefCash] trade is larger than allowed by the governance settings
- TRADE_FAILED_LACK_OF_LIQUIDITY: [takeCurrentCash, takefCash] there is insufficient liquidity in this maturity to handle the trade
- TRADE_FAILED_SLIPPAGE: [takeCurrentCash, takefCash] trade is greater than the max implied rate set

***

### `batchOperationWithdraw`
> Allows batch operations of deposits, trades and withdraws. Approved operators are allowed to call this function
on behalf of accounts.
#### Parameters:
- `account`: account for which the operation will take place
- `maxTime`: after this time the operation will fail
- `deposits`: a list of deposits into the Escrow contract, ERC20 allowance must be in place for the Escrow contract
or these deposits will fail.
- `trades`: a list of trades to place on fCash markets
- `withdraws`: a list of withdraws, if amount is set to zero will attempt to withdraw the account's entire balance
of the specified currency. This is useful for borrowing when the exact exchange rate is not known ahead of time.

#### Error Codes:
- TRADE_FAILED_MAX_TIME: the operation will fail due to the set timeout
- UNAUTHORIZED_CALLER: operator is not authorized for the account
- INVALID_CURRENCY: currency specified in deposits is invalid
- MARKET_INACTIVE: maturity is not a valid one
- INSUFFICIENT_BALANCE: insufficient collateral balance (or token balance when removing liquidity)
- INSUFFICIENT_FREE_COLLATERAL: account does not have enough free collateral to place the trade
- OVER_MAX_FCASH: [addLiquidity] fCash amount required exceeds supplied maxfCash
- OUT_OF_IMPLIED_RATE_BOUNDS: [addLiquidity] depositing collateral would require more fCash than specified
- TRADE_FAILED_TOO_LARGE: [takeCurrentCash, takefCash] trade is larger than allowed by the governance settings
- TRADE_FAILED_LACK_OF_LIQUIDITY: [takeCurrentCash, takefCash] there is insufficient liquidity in this maturity to handle the trade
- TRADE_FAILED_SLIPPAGE: [takeCurrentCash, takefCash] trade is greater than the max implied rate set

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
- UNAUTHORIZED_CALLER: calling contract must be approved by both from / to addresses or be the 0x proxy
- OVER_MAX_UINT128_AMOUNT: amount specified cannot be greater than MAX_UINT128
- INVALID_SWAP: the asset id specified can only be of CASH_PAYER or CASH_RECEIVER types
- INVALID_CURRENCY: the currency id specified is invalid
- INVALID_CURRENCY: the currency id specified is invalid

***

### `safeBatchTransferFrom`
> No description


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
> Sets the address of the 0x bridgeProxy that is allowed to mint fCash pairs.
#### Parameters:
- `bridgeProxy`: address of the 0x ERC1155AssetProxy

***
