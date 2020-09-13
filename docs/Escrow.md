# Escrow

Manages a account balances for the entire system including deposits, withdraws,
cash balances, collateral lockup for trading, cash transfers (settlement), and liquidation.


## Methods
- [`isValidCurrency(uint16 currency)`](#isValidCurrency)
- [`getExchangeRate(uint16 base, uint16 quote)`](#getExchangeRate)
- [`getBalances(address account)`](#getBalances)
- [`convertBalancesToETH(int256[] amounts)`](#convertBalancesToETH)
- [`depositEth()`](#depositEth)
- [`withdrawEth(uint128 amount)`](#withdrawEth)
- [`deposit(address token, uint128 amount)`](#deposit)
- [`withdraw(address token, uint128 amount)`](#withdraw)
- [`settleCashBalanceBatch(uint16 currency, uint16 collateralCurrency, address[] payers, uint128[] values)`](#settleCashBalanceBatch)
- [`settleCashBalance(uint16 currency, uint16 collateralCurrency, address payer, uint128 value)`](#settleCashBalance)
- [`liquidateBatch(address[] accounts, uint16 currency, uint16 collateralCurrency)`](#liquidateBatch)
- [`liquidate(address account, uint16 currency, uint16 collateralCurrency)`](#liquidate)

## Events
- [`NewCurrency(address token)`](#NewCurrency)
- [`UpdateExchangeRate(uint16 base, uint16 quote)`](#UpdateExchangeRate)
- [`Deposit(uint16 currency, address account, uint256 value)`](#Deposit)
- [`Withdraw(uint16 currency, address account, uint256 value)`](#Withdraw)
- [`Liquidate(uint16 localCurrency, uint16 collateralCurrency, address account, uint128 amountLiquidated)`](#Liquidate)
- [`LiquidateBatch(uint16 localCurrency, uint16 collateralCurrency, address[] accounts, uint128[] amountLiquidated)`](#LiquidateBatch)
- [`SettleCash(uint16 localCurrency, uint16 collateralCurrency, address payer, uint128 settledAmount)`](#SettleCash)
- [`SettleCashBatch(uint16 localCurrency, uint16 collateralCurrency, address[] payers, uint128[] settledAmounts)`](#SettleCashBatch)
- [`SetDiscounts(uint128 liquidationDiscount, uint128 settlementDiscount, uint128 repoIncentive)`](#SetDiscounts)
- [`SetReserve(address reserveAccount)`](#SetReserve)

## Governance Methods
- [`setDiscounts(uint128 liquidation, uint128 settlement, uint128 repoIncentive)`](#setDiscounts)
- [`setReserveAccount(address account)`](#setReserveAccount)
- [`listCurrency(address token, struct EscrowStorage.TokenOptions options)`](#listCurrency)
- [`addExchangeRate(uint16 base, uint16 quote, address rateOracle, uint128 buffer, uint128 rateDecimals, bool mustInvert)`](#addExchangeRate)

# Methods
### `isValidCurrency`
> Evaluates whether or not a currency id is valid
#### Parameters:
- `currency`: currency id
#### Return Values:
- true if the currency is valid


***

### `getExchangeRate`
> Getter method for exchange rates
#### Parameters:
- `base`: token address for the base currency
- `quote`: token address for the quote currency
#### Return Values:
- ExchangeRate struct


***

### `getBalances`
> Returns the net balances of all the currencies owned by an account as
an array. Each index of the array refers to the currency id.
#### Parameters:
- `account`: the account to query
#### Return Values:
- the balance of each currency net of the account's cash position


***

### `convertBalancesToETH`
> Converts the balances given to ETH for the purposes of determining whether an account has
sufficient free collateral.
#### Parameters:
- `amounts`: the balance in each currency group as an array, each index refers to the currency group id.
#### Return Values:
- an array the same length as amounts with each balance denominated in ETH

#### Error Codes:
- INVALID_CURRENCY: length of the amounts array must match the total number of currencies
- INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0

***

### `depositEth`
> This is a special function to handle ETH deposits. Value of ETH to be deposited must be specified in `msg.value`

#### Error Codes:
- OVER_MAX_ETH_BALANCE: balance of deposit cannot overflow uint128

***

### `withdrawEth`
> Withdraw ETH from the contract.
#### Parameters:
- `amount`: the amount of eth to withdraw from the contract

#### Error Codes:
- INSUFFICIENT_BALANCE: not enough balance in account
- INSUFFICIENT_FREE_COLLATERAL: not enough free collateral to withdraw
- TRANSFER_FAILED: eth transfer did not return success

***

### `deposit`
> Transfers a balance from an ERC20 token contract into the Escrow. Do not call this for ERC777 transfers, use
the `send` method instead.
#### Parameters:
- `token`: token contract to send from
- `amount`: tokens to transfer

#### Error Codes:
- INVALID_CURRENCY: token address supplied is not a valid currency

***

### `withdraw`
> Withdraws from an account's collateral holdings back to their account. Checks if the
account has sufficient free collateral after the withdraw or else it fails.
#### Parameters:
- `token`: collateral type to withdraw
- `amount`: total value to withdraw

#### Error Codes:
- INSUFFICIENT_BALANCE: not enough balance in account
- INVALID_CURRENCY: token address supplied is not a valid currency
- INSUFFICIENT_FREE_COLLATERAL: not enough free collateral to withdraw

***

### `settleCashBalanceBatch`
> Settles the cash balances of payers in batch
#### Parameters:
- `currency`: the currency group to settle
- `payers`: the party that has a negative cash balance and will transfer collateral to the receiver
- `values`: the amount of collateral to transfer

#### Error Codes:
- INVALID_CURRENCY: currency specified is invalid
- INCORRECT_CASH_BALANCE: payer does not have sufficient cash balance to settle
- INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0
- NO_EXCHANGE_LISTED_FOR_PAIR: cannot settle cash because no exchange is listed for the pair
- INSUFFICIENT_COLLATERAL_FOR_SETTLEMENT: not enough collateral to settle on the exchange
- RESERVE_ACCOUNT_HAS_INSUFFICIENT_BALANCE: settling requires the reserve account, but there is insufficient
balance to do so
- INSUFFICIENT_COLLATERAL_BALANCE: account does not hold enough collateral to settle, they will have
additional collateral in a different currency if they are collateralized
- INSUFFICIENT_FREE_COLLATERAL_SETTLER: calling account to settle cash does not have sufficient free collateral
after settling payers and receivers

***

### `settleCashBalance`
> Settles the cash balance between the payer and the receiver.
#### Parameters:
- `currency`: the currency group to settle
- `collateralCurrency`: the collateral currency to sell to cover
- `payer`: the party that has a negative cash balance and will transfer collateral to the receiver
- `value`: the amount of collateral to transfer

#### Error Codes:
- INCORRECT_CASH_BALANCE: payer or receiver does not have sufficient cash balance to settle
- INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0
- NO_EXCHANGE_LISTED_FOR_PAIR: cannot settle cash because no exchange is listed for the pair
- INSUFFICIENT_COLLATERAL_FOR_SETTLEMENT: not enough collateral to settle on the exchange
- RESERVE_ACCOUNT_HAS_INSUFFICIENT_BALANCE: settling requires the reserve account, but there is insufficient
balance to do so
- INSUFFICIENT_COLLATERAL_BALANCE: account does not hold enough collateral to settle, they will have
- INSUFFICIENT_FREE_COLLATERAL_SETTLER: calling account to settle cash does not have sufficient free collateral
after settling payers and receivers

***

### `liquidateBatch`
> Liquidates a batch of accounts in a specific currency.
#### Parameters:
- `accounts`: the account to liquidate
- `currency`: the currency that is undercollateralized
- `collateralCurrency`: the collateral currency to exchange for `currency`

#### Error Codes:
- CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL: account has positive free collateral and cannot be liquidated
- CANNOT_LIQUIDATE_SELF: liquidator cannot equal the liquidated account
- INSUFFICIENT_FREE_COLLATERAL_LIQUIDATOR: liquidator does not have sufficient free collateral after liquidating
accounts

***

### `liquidate`
> Liquidates a single account if it is undercollateralized
#### Parameters:
- `account`: the account to liquidate
- `currency`: the currency that is undercollateralized
- `collateralCurrency`: the collateral currency to exchange for `currency`

#### Error Codes:
- CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL: account has positive free collateral and cannot be liquidated
- CANNOT_LIQUIDATE_SELF: liquidator cannot equal the liquidated account
- INSUFFICIENT_FREE_COLLATERAL_LIQUIDATOR: liquidator does not have sufficient free collateral after liquidating
accounts
- CANNOT_LIQUIDATE_TO_WORSE_FREE_COLLATERAL: we cannot liquidate an account and have it end up in a worse free
collateral position than when it started. This is possible if collateralCurrency has a larger haircut than currency.

***


# Events
### `NewCurrency`
> A new currency
#### Parameters:
- `token`: address of the tradable token

***

### `UpdateExchangeRate`
> A new exchange rate between two currencies
#### Parameters:
- `base`: id of the base currency
- `quote`: id of the quote currency

***

### `Deposit`
> Notice of a deposit made to an account
#### Parameters:
- `currency`: currency id of the deposit
- `account`: address of the account where the deposit was made
- `value`: amount of tokens deposited

***

### `Withdraw`
> Notice of a withdraw from an account
#### Parameters:
- `currency`: currency id of the withdraw
- `account`: address of the account where the withdraw was made
- `value`: amount of tokens withdrawn

***

### `Liquidate`
> Notice of a successful liquidation. `msg.sender` will be the liquidator.
#### Parameters:
- `localCurrency`: currency that was liquidated
- `collateralCurrency`: currency that was exchanged for the local currency
- `account`: the account that was liquidated

***

### `LiquidateBatch`
> Notice of a successful batch liquidation. `msg.sender` will be the liquidator.
#### Parameters:
- `localCurrency`: currency that was liquidated
- `collateralCurrency`: currency that was exchanged for the local currency
- `accounts`: the accounts that were liquidated

***

### `SettleCash`
> Notice of a successful cash settlement. `msg.sender` will be the settler.
#### Parameters:
- `localCurrency`: currency that was settled
- `collateralCurrency`: currency that was exchanged for the local currency
- `payer`: the account that paid in the settlement
- `settledAmount`: the amount settled between the parties

***

### `SettleCashBatch`
> Notice of a successful batch cash settlement. `msg.sender` will be the settler.
#### Parameters:
- `localCurrency`: currency that was settled
- `collateralCurrency`: currency that was exchanged for the local currency
- `payers`: the accounts that paid in the settlement
- `settledAmounts`: the amounts settled between the parties

***

### `SetDiscounts`
> Emitted when liquidation and settlement discounts are set
#### Parameters:
- `liquidationDiscount`: discount given to liquidators when purchasing collateral
- `settlementDiscount`: discount given to settlers when purchasing collateral
- `repoIncentive`: incentive given to liquidators for pulling liquidity tokens to recollateralize an account

***

### `SetReserve`
> Emitted when reserve account is set
#### Parameters:
- `reserveAccount`: account that holds balances in reserve

***


# Governance Methods
### `setDiscounts`
> Sets discounts applied when purchasing collateral during liquidation or settlement. Discounts are
represented as percentages multiplied by 1e18. For example, a 5% discount for liquidators will be set as
1.05e18
#### Parameters:
- `liquidation`: discount applied to liquidation
- `settlement`: discount applied to settlement
- `repoIncentive`: incentive to repo liquidity tokens

***
### `setReserveAccount`
> Sets the reserve account used to settle against for insolvent accounts
#### Parameters:
- `account`: address of reserve account

***
### `listCurrency`
> Lists a new currency for deposits
#### Parameters:
- `token`: address of ERC20 or ERC777 token to list
- `options`: a set of booleans that describe the token

***
### `addExchangeRate`
> Creates an exchange rate between two currencies.
#### Parameters:
- `base`: the base currency
- `quote`: the quote currency
- `rateOracle`: the oracle that will give the exchange rate between the two
- `buffer`: multiple to apply to the exchange rate that sets the collateralization ratio
- `rateDecimals`: decimals of precision that the rate oracle uses
- `mustInvert`: true if the chainlink oracle must be inverted

***
