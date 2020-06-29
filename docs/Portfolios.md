# Portfolios

Manages account portfolios which includes all future cash positions and liquidity tokens.


## Methods
- [`getTrades(address account)`](#getTrades)
- [`getTrade(address account, uint256 index)`](#getTrade)
- [`getInstrumentGroup(uint8 instrumentGroupId)`](#getInstrumentGroup)
- [`getInstrumentGroups(uint8[] groupIds)`](#getInstrumentGroups)
- [`searchAccountTrade(address account, bytes1 swapType, uint8 instrumentGroupId, uint16 instrumentId, uint32 startBlock, uint32 duration)`](#searchAccountTrade)
- [`freeCollateral(address account)`](#freeCollateral)
- [`freeCollateralView(address account)`](#freeCollateralView)
- [`settleAccount(address account)`](#settleAccount)
- [`settleAccountBatch(address[] accounts)`](#settleAccountBatch)

## Events
- [`SettleAccount(address operator, address account)`](#SettleAccount)
- [`SettleAccountBatch(address operator, address[] account)`](#SettleAccountBatch)
- [`NewInstrumentGroup(uint8 instrumentGroupId)`](#NewInstrumentGroup)
- [`UpdateInstrumentGroup(uint8 instrumentGroupId)`](#UpdateInstrumentGroup)

## Governance Methods
- [`setMaxTrades(uint256 maxTrades)`](#setMaxTrades)
- [`createInstrumentGroup(uint32 numPeriods, uint32 periodSize, uint32 precision, uint16 currency, address futureCashMarket, address riskFormula)`](#createInstrumentGroup)
- [`updateInstrumentGroup(uint8 instrumentGroupId, uint32 numPeriods, uint32 periodSize, uint32 precision, uint16 currency, address futureCashMarket, address riskFormula)`](#updateInstrumentGroup)

# Methods
### getTrades
> Returns the trades of an account

#### Parameters:
- `account`: to retrieve

#### Return Values:
- an array representing the account's portfolio

***

### getTrade
> Returns a particular trade via index

#### Parameters:
- `account`: to retrieve

- `index`: of trade

#### Return Values:
- a single trade by index in the portfolio

***

### getInstrumentGroup
> Returns a particular instrument group

#### Parameters:
- `instrumentGroupId`: to retrieve

#### Return Values:
- the given instrument group

***

### getInstrumentGroups
> Returns a batch of instrument groups

#### Parameters:
- `groupIds`: array of instrument group ids to retrieve

#### Return Values:
- an array of instrument group objects

***

### searchAccountTrade
> Public method for searching for a trade in an account.

#### Parameters:
- `account`: account to search

- `swapType`: the type of swap to search for

- `instrumentGroupId`: the instrument group id

- `instrumentId`: the instrument id

- `startBlock`: the starting block

- `duration`: the duration of the swap

#### Return Values:
- index of trade)

***

### freeCollateral
> Stateful version of free collateral, first settles all trades in the account before returning
the free collateral parameters. Generally, external developers should not need to call this function. It is used
internally to both check free collateral and ensure that the portfolio does not have any matured trades.
Call `freeCollateralView` if you require a view function.

#### Parameters:
- `account`: address of account to get free collateral for

#### Return Values:
- net free collateral position, an array of the currency requirements)

***

### freeCollateralView
> Returns the free collateral balance for an account as a view functon.

#### Parameters:
- `account`: account in question

#### Return Values:
- net free collateral position, an array of the currency requirements)

***

### settleAccount
> Settles all matured cash trades and liquidity tokens in a user's portfolio. This method is
unauthenticated, anyone may settle the trades in any account. This is required for accounts that
have negative cash and counterparties need to settle against them. Generally, external developers
should not need to call this function. We ensure that accounts are settled on every free collateral
check, cash settlement, and liquidation.

#### Parameters:
- `account`: the account referenced

***

### settleAccountBatch
> Settle a batch of accounts. See note for `settleAccount`, external developers should not need
to call this function.

#### Parameters:
- `accounts`: an array of accounts to settle

***


# Events
### `SettleAccount`
No description

***

### `SettleAccountBatch`
No description

***

### `NewInstrumentGroup`
No description

***

### `UpdateInstrumentGroup`
No description

***


# Governance Methods
### setMaxTrades
> Set the max trades that a portfolio can hold

#### Parameters:
- `maxTrades`: new max trade number

***
### createInstrumentGroup
> An instrument group defines a collection of similar instruments where the risk ladders can be netted
against each other. The identifier is only 1 byte so we can only have 255 instrument groups, 0 is unused.

#### Parameters:
- `numPeriods`: the total number of periods

- `periodSize`: the baseline period length (in blocks) for periodic swaps in this instrument.

- `precision`: the discount rate precision

- `currency`: the token address of the currenty this instrument settles in

- `futureCashMarket`: the rate oracle that defines the discount rate

***
### updateInstrumentGroup
> Updates instrument groups. Be very careful when calling this function! When changing periods and
period sizes the markets must be updated as well.

#### Parameters:
- `instrumentGroupId`: the group id to update

- `numPeriods`: this is safe to update as long as the discount rate oracle is not shared

- `periodSize`: this is only safe to update when there are no trades left

- `precision`: this is only safe to update when there are no trades left

- `currency`: this is safe to update if there are no trades or the new currency is equivalent

- `futureCashMarket`: this is safe to update once the oracle is established

***
