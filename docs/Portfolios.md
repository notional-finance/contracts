# Portfolios

Manages account portfolios which includes all future cash positions and liquidity tokens.


## Methods
- [`getAssets(address account)`](#getAssets)
- [`getAsset(address account, uint256 index)`](#getAsset)
- [`getFutureCashGroup(uint8 futureCashGroupId)`](#getFutureCashGroup)
- [`getFutureCashGroups(uint8[] groupIds)`](#getFutureCashGroups)
- [`searchAccountAsset(address account, bytes1 swapType, uint8 futureCashGroupId, uint16 instrumentId, uint32 startTime, uint32 duration)`](#searchAccountAsset)
- [`freeCollateral(address account)`](#freeCollateral)
- [`freeCollateralView(address account)`](#freeCollateralView)
- [`settleAccount(address account)`](#settleAccount)
- [`settleAccountBatch(address[] accounts)`](#settleAccountBatch)

## Events
- [`SettleAccount(address account)`](#SettleAccount)
- [`SettleAccountBatch(address[] accounts)`](#SettleAccountBatch)
- [`NewFutureCashGroup(uint8 futureCashGroupId)`](#NewFutureCashGroup)
- [`UpdateFutureCashGroup(uint8 futureCashGroupId)`](#UpdateFutureCashGroup)

## Governance Methods
- [`createFutureCashGroup(uint32 numPeriods, uint32 periodSize, uint32 precision, uint16 currency, address futureCashMarket, address riskFormula)`](#createFutureCashGroup)
- [`updateFutureCashGroup(uint8 futureCashGroupId, uint32 numPeriods, uint32 periodSize, uint32 precision, uint16 currency, address futureCashMarket, address riskFormula)`](#updateFutureCashGroup)

# Methods
### `getAssets`
> Returns the assets of an account
#### Parameters:
- `account`: to retrieve
#### Return Values:
- an array representing the account's portfolio


***

### `getAsset`
> Returns a particular asset via index
#### Parameters:
- `account`: to retrieve
- `index`: of asset
#### Return Values:
- a single asset by index in the portfolio


***

### `getFutureCashGroup`
> Returns a particular future cash group
#### Parameters:
- `futureCashGroupId`: to retrieve
#### Return Values:
- the given future cash group


***

### `getFutureCashGroups`
> Returns a batch of future cash groups
#### Parameters:
- `groupIds`: array of future cash group ids to retrieve
#### Return Values:
- an array of future cash group objects


***

### `searchAccountAsset`
> Public method for searching for a asset in an account.
#### Parameters:
- `account`: account to search
- `swapType`: the type of swap to search for
- `futureCashGroupId`: the future cash group id
- `instrumentId`: the instrument id
- `startTime`: the starting timestamp of the period in seconds
- `duration`: the duration of the swap
#### Return Values:
- index of asset)


***

### `freeCollateral`
> Stateful version of free collateral, first settles all assets in the account before returning
the free collateral parameters. Generally, external developers should not need to call this function. It is used
internally to both check free collateral and ensure that the portfolio does not have any matured assets.
Call `freeCollateralView` if you require a view function.
#### Parameters:
- `account`: address of account to get free collateral for
#### Return Values:
- net free collateral position, an array of the currency requirements)


***

### `freeCollateralView`
> Returns the free collateral balance for an account as a view functon.
#### Parameters:
- `account`: account in question
#### Return Values:
- net free collateral position, an array of the currency requirements)

#### Error Codes:
- INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0

***

### `settleAccount`
> Settles all matured cash assets and liquidity tokens in a user's portfolio. This method is
unauthenticated, anyone may settle the assets in any account. This is required for accounts that
have negative cash and counterparties need to settle against them. Generally, external developers
should not need to call this function. We ensure that accounts are settled on every free collateral
check, cash settlement, and liquidation.
#### Parameters:
- `account`: the account referenced


***

### `settleAccountBatch`
> Settle a batch of accounts. See note for `settleAccount`, external developers should not need
to call this function.
#### Parameters:
- `accounts`: an array of accounts to settle


***


# Events
### `SettleAccount`
> Emitted when an account has its portfolio settled, only emitted if the portfolio has changed
#### Parameters:
- `account`: the account that had its porfolio modified

***

### `SettleAccountBatch`
> Emitted when an account has its portfolio settled, all accounts are emitted in the batch
#### Parameters:
- `accounts`: batch of accounts that *may* have been settled

***

### `NewFutureCashGroup`
> Emitted when a new future cash group is listed
#### Parameters:
- `futureCashGroupId`: id of the new future cash group

***

### `UpdateFutureCashGroup`
> Emitted when a new future cash group is updated
#### Parameters:
- `futureCashGroupId`: id of the updated future cash group

***


# Governance Methods
### `createFutureCashGroup`
> An future cash group defines a collection of similar future cashs where the risk ladders can be netted
against each other. The identifier is only 1 byte so we can only have 255 future cash groups, 0 is unused.
#### Parameters:
- `numPeriods`: the total number of periods
- `periodSize`: the baseline period length (in seconds) for periodic swaps in this future cash.
- `precision`: the discount rate precision
- `currency`: the token address of the currenty this future cash settles in
- `futureCashMarket`: the rate oracle that defines the discount rate

***
### `updateFutureCashGroup`
> Updates future cash groups. Be very careful when calling this function! When changing periods and
period sizes the markets must be updated as well.
#### Parameters:
- `futureCashGroupId`: the group id to update
- `numPeriods`: this is safe to update as long as the discount rate oracle is not shared
- `periodSize`: this is only safe to update when there are no assets left
- `precision`: this is only safe to update when there are no assets left
- `currency`: this is safe to update if there are no assets or the new currency is equivalent
- `futureCashMarket`: this is safe to update once the oracle is established

***
