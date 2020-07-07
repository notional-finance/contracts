# Escrow

Manages a account balances for the entire system including deposits, withdraws,
cash balances, collateral lockup for trading, cash transfers (settlement), and liquidation.


## Methods
- [`isValidCurrency(uint16 currency)`](#isValidCurrency)
- [`isTradableCurrency(uint16 currency)`](#isTradableCurrency)
- [`isDepositCurrency(uint16 currency)`](#isDepositCurrency)
- [`getExchangeRate(address base, address quote)`](#getExchangeRate)
- [`getNetBalances(address account)`](#getNetBalances)
- [`getNetBalanceOfCurrency(address account, uint16 currency)`](#getNetBalanceOfCurrency)
- [`convertBalancesToETH(uint128[] amounts)`](#convertBalancesToETH)
- [`depositEth()`](#depositEth)
- [`withdrawEth(uint128 amount)`](#withdrawEth)
- [`deposit(address token, uint256 amount)`](#deposit)
- [`withdraw(address token, uint256 amount)`](#withdraw)
- [`settleCashBalanceBatch(uint16 currency, uint16 depositCurrency, address[] payers, address[] receivers, uint128[] values)`](#settleCashBalanceBatch)
- [`settleCashBalance(uint16 currency, uint16 depositCurrency, address payer, address receiver, uint128 value)`](#settleCashBalance)
- [`liquidateBatch(address[] accounts, uint16 currency, uint16 depositCurrency)`](#liquidateBatch)
- [`liquidate(address account, uint16 currency, uint16 depositCurrency)`](#liquidate)

## Events
- [`NewTradableCurrency(address token)`](#NewTradableCurrency)
- [`NewDepositCurrency(address token)`](#NewDepositCurrency)
- [`UpdateExchangeRate(address baseToken, address quoteToken)`](#UpdateExchangeRate)
- [`Deposit(uint16 currency, address account, uint256 value)`](#Deposit)
- [`Withdraw(uint16 currency, address account, uint256 value)`](#Withdraw)
- [`Liquidate(uint16 currency, address account)`](#Liquidate)
- [`LiquidateBatch(uint16 currency, address[] accounts)`](#LiquidateBatch)
- [`SettleCash(uint16 currency, address payer, address receiver, uint128 settledAmount)`](#SettleCash)
- [`SettleCashBatch(uint16 currency, address[] payers, address[] receivers, uint128[] settledAmounts)`](#SettleCashBatch)

## Governance Methods
- [`setDiscounts(uint128 liquidation, uint128 settlement)`](#setDiscounts)
- [`setReserveAccount(address account)`](#setReserveAccount)
- [`listTradableCurrency(address token)`](#listTradableCurrency)
- [`listDepositCurrency(address token)`](#listDepositCurrency)
- [`addExchangeRate(uint16 base, uint16 quote, address rateOracle, address onChainExchange, uint128 haircut)`](#addExchangeRate)

# Methods
### `isValidCurrency`
> Evaluates whether or not a currency id is valid

#### Parameters:
- `currency`: currency id

#### Return Values:
- true if the currency is valid

***

### `isTradableCurrency`
> Evaluates whether or not a currency can be traded

#### Parameters:
- `currency`: currency id

#### Return Values:
- true if the currency is tradable

***

### `isDepositCurrency`
> Evaluates whether or not a currency can be used as collateral

#### Parameters:
- `currency`: currency id

#### Return Values:
- true if the currency is a deposit currency

***

### `getExchangeRate`
> Getter method for exchange rates

#### Parameters:
- `base`: token address for the base currency

- `quote`: token address for the quote currency

#### Return Values:
- ExchangeRate struct

***

### `getNetBalances`
> Returns the net balances of all the currencies owned by an account as
an array. Each index of the array refers to the currency id.

#### Parameters:
- `account`: the account to query

#### Return Values:
- the balance of each currency net of the account's cash position

***

### `getNetBalanceOfCurrency`
> Returns the net balance denominated in the currency for an account. This balance
may be less than zero due to negative cash balances.

#### Parameters:
- `account`: to get the balance for

- `currency`: currency id

#### Return Values:
- the net balance of the currency

***

### `convertBalancesToETH`
> Converts the balances given to ETH for the purposes of determining whether an account has
sufficient free collateral.

#### Parameters:
- `amounts`: the balance in each currency group as an array, each index refers to the currency group id.

#### Return Values:
- an array the same length as amounts with each balance denominated in ETH

***

### `depositEth`
> This is a special function to handle ETH deposits. Value of ETH to be deposited must be specified in `msg.value`

***

### `withdrawEth`
> Withdraw ETH from the contract.

#### Parameters:
- `amount`: the amount of eth to withdraw from the contract

***

### `deposit`
> Transfers a balance from an ERC20 token contract into the Escrow.

#### Parameters:
- `token`: token contract to send from

- `amount`: tokens to transfer

***

### `withdraw`
> Withdraws from an account's collateral holdings back to their account. Checks if the
account has sufficient free collateral after the withdraw or else it fails.

#### Parameters:
- `token`: collateral type to withdraw

- `amount`: total value to withdraw

***

### `settleCashBalanceBatch`
> Settles the cash balances between the payers and receivers in batch

#### Parameters:
- `currency`: the currency group to settle

- `payers`: the party that has a negative cash balance and will transfer collateral to the receiver

- `receivers`: the party that has a positive cash balance and will receive collateral from the payer

- `values`: the amount of collateral to transfer

***

### `settleCashBalance`
> Settles the cash balance between the payer and the receiver.

#### Parameters:
- `currency`: the currency group to settle

- `depositCurrency`: the deposit currency to sell to cover

- `payer`: the party that has a negative cash balance and will transfer collateral to the receiver

- `receiver`: the party that has a positive cash balance and will receive collateral from the payer

- `value`: the amount of collateral to transfer

***

### `liquidateBatch`
> Liquidates a batch of accounts in a specific currency.

#### Parameters:
- `accounts`: the account to liquidate

- `currency`: the currency that is undercollateralized

- `depositCurrency`: the deposit currency to exchange for `currency`

***

### `liquidate`
> Liquidates a single account if it is undercollateralized

#### Parameters:
- `account`: the account to liquidate

- `currency`: the currency that is undercollateralized

- `depositCurrency`: the deposit currency to exchange for `currency`

***


# Events
### `NewTradableCurrency`
> A new tradable currency

#### Parameters:
- `token`: address of the tradable token

***

### `NewDepositCurrency`
> A new deposit currency

#### Parameters:
- `token`: address of the deposit token

***

### `UpdateExchangeRate`
> A new exchange rate between two currencies

#### Parameters:
- `baseToken`: address of the base token

- `quoteToken`: address of the quote token

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
- `currency`: currency id that was liquidated

- `account`: the account that was liquidated

***

### `LiquidateBatch`
> Notice of a successful batch liquidation. `msg.sender` will be the liquidator.

#### Parameters:
- `currency`: currency id that was liquidated

- `accounts`: the accounts that were liquidated

***

### `SettleCash`
> Notice of a successful cash settlement. `msg.sender` will be the settler.

#### Parameters:
- `currency`: currency id that was settled

- `payer`: the account that paid in the settlement

- `receiver`: the account that received in the settlement

- `settledAmount`: the amount settled between the parties

***

### `SettleCashBatch`
> Notice of a successful batch cash settlement. `msg.sender` will be the settler.

#### Parameters:
- `currency`: currency id that was settled

- `payers`: the accounts that paid in the settlement

- `receivers`: the accounts that received in the settlement

- `settledAmounts`: the amounts settled between the parties

***


# Governance Methods
### `setDiscounts`
> Sets discounts applied when purchasing collateral during liquidation or settlement

#### Parameters:
- `liquidation`: discount applied to liquidation

- `settlement`: discount applied to settlement

***
### `setReserveAccount`
> Sets the reserve account used to settle against for insolvent accounts

#### Parameters:
- `account`: address of reserve account

***
### `listTradableCurrency`
> Lists a new currency that can be traded in future cash markets

#### Parameters:
- `token`: address of the ERC20 or ERC777 token

***
### `listDepositCurrency`
> Lists a new currency that can only be used to collateralize `CASH_PAYER` tokens

#### Parameters:
- `token`: address of the ERC20 or ERC777 token

***
### `addExchangeRate`
> Creates an exchange rate between two currencies.

#### Parameters:
- `base`: the base currency

- `quote`: the quote currency

- `rateOracle`: the oracle that will give the exchange rate between the two

- `onChainExchange`: uniswap exchange for trustless exchange

- `haircut`: multiple to apply to the exchange rate that sets the collateralization ratio

***
