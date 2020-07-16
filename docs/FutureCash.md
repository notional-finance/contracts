# FutureCash

Marketplace for trading future cash tokens to create fixed rate entitlements or obligations.

## Methods

-   [`addLiquidity(uint32 maturity, uint128 minCollateral, uint128 maxFutureCash, uint32 maxTime)`](#addLiquidity)
-   [`removeLiquidity(uint32 maturity, uint128 amount, uint32 maxTime)`](#removeLiquidity)
-   [`getFutureCashToCollateral(uint32 maturity, uint128 futureCashAmount)`](#getFutureCashToCollateral)
-   [`getFutureCashToCollateralAtTime(uint32 maturity, uint128 futureCashAmount, uint32 blockTime)`](#getFutureCashToCollateralAtTime)
-   [`takeCollateral(uint32 maturity, uint128 futureCashAmount, uint32 maxTime, uint32 maxImpliedRate)`](#takeCollateral)
-   [`getCollateralToFutureCash(uint32 maturity, uint128 futureCashAmount)`](#getCollateralToFutureCash)
-   [`getCollateralToFutureCashAtTime(uint32 maturity, uint128 futureCashAmount, uint32 blockTime)`](#getCollateralToFutureCashAtTime)
-   [`takeFutureCash(uint32 maturity, uint128 futureCashAmount, uint32 maxTime, uint128 minImpliedRate)`](#takeFutureCash)
-   [`getRate(uint32 maturity)`](#getRate)
-   [`getMarketRates()`](#getMarketRates)
-   [`getActiveMaturities()`](#getActiveMaturities)

## Events

-   [`UpdateRateFactors(uint32 rateAnchor, uint16 rateScalar)`](#UpdateRateFactors)
-   [`UpdateMaxTradeSize(uint128 maxTradeSize)`](#UpdateMaxTradeSize)
-   [`UpdateFees(uint32 liquidityFee, uint128 transactionFee)`](#UpdateFees)
-   [`AddLiquidity(address account, uint32 maturity, uint128 tokens, uint128 futureCash, uint128 collateral)`](#AddLiquidity)
-   [`RemoveLiquidity(address account, uint32 maturity, uint128 tokens, uint128 futureCash, uint128 collateral)`](#RemoveLiquidity)
-   [`TakeCollateral(address account, uint32 maturity, uint128 futureCash, uint128 collateral, uint128 fee)`](#TakeCollateral)
-   [`TakeFutureCash(address account, uint32 maturity, uint128 futureCash, uint128 collateral, uint128 fee)`](#TakeFutureCash)

## Governance Methods

-   [`setRateFactors(uint32 rateAnchor, uint16 rateScalar)`](#setRateFactors)
-   [`setMaxTradeSize(uint128 amount)`](#setMaxTradeSize)
-   [`setFee(uint32 liquidityFee, uint128 transactionFee)`](#setFee)

# Methods

### `addLiquidity`

> Adds some amount of collateral to the liquidity pool up to the corresponding amount defined by
> `maxFutureCash`. Mints liquidity tokens back to the sender.

#### Parameters:

-   `maturity`: the period to add liquidity to
-   `minCollateral`: the amount of collateral to add to the pool
-   `maxFutureCash`: the maximum amount of future cash to add to the pool
-   `maxTime`: after this time the trade will fail

#### Error Codes:

-   TRADE_FAILED_MAX_TIME: maturity specified is not yet active
-   MARKET_INACTIVE: maturity is not a valid one
-   OVER_MAX_FUTURE_CASH: depositing collateral would require more future cash than specified
-   INSUFFICIENT_BALANCE: insufficient collateral to deposit into market

---

### `removeLiquidity`

> Removes liquidity from the future cash market. The sender's liquidity tokens are burned and they
> are credited back with future cash and collateral at the prevailing exchange rate. This function
> only works when removing liquidity from an active market. For markets that are matured, the sender
> must settle their liquidity token via `Portfolios().settleAccount()`.

#### Parameters:

-   `maturity`: the period to remove liquidity from
-   `amount`: the amount of liquidity tokens to burn
-   `maxTime`: after this block the trade will fail

#### Error Codes:

-   TRADE_FAILED_MAX_TIME: maturity specified is not yet active
-   MARKET_INACTIVE: maturity is not a valid one
-   INSUFFICIENT_BALANCE: account does not have sufficient tokens to remove

---

### `getFutureCashToCollateral`

> Given the amount of future cash put into a market, how much collateral this would
> purchase at the current block.

#### Parameters:

-   `maturity`: the maturity of the future cash
-   `futureCashAmount`: the amount of future cash to input

#### Return Values:

-   the amount of collateral this would purchase, returns 0 if the trade will fail

---

### `getFutureCashToCollateralAtTime`

> Given the amount of future cash put into a market, how much collateral this would
> purchase at the given time. Future cash exchange rates change as we go towards maturity.

#### Parameters:

-   `maturity`: the maturity of the future cash
-   `futureCashAmount`: the amount of future cash to input
-   `blockTime`: the specified block time

#### Return Values:

-   the amount of collateral this would purchase, returns 0 if the trade will fail

#### Error Codes:

-   CANNOT_GET_PRICE_FOR_MATURITY: can only get prices before the maturity

---

### `takeCollateral`

> Receive collateral in exchange for a future cash obligation. Equivalent to borrowing
> collateral at a fixed rate.

#### Parameters:

-   `maturity`: the maturity of the future cash being exchange for current cash
-   `futureCashAmount`: the amount of future cash to deposit, will convert this amount to current cash
    at the prevailing exchange rate
-   `maxTime`: after this time the trade will not settle
-   `maxImpliedRate`: the maximum implied period rate that the borrower will accept

#### Return Values:

-   the amount of collateral purchased

#### Error Codes:

-   TRADE_FAILED_MAX_TIME: maturity specified is not yet active
-   MARKET_INACTIVE: maturity is not a valid one
-   TRADE_FAILED_TOO_LARGE: trade is larger than allowed by the governance settings
-   TRADE_FAILED_LACK_OF_LIQUIDITY: there is insufficient liquidity in this maturity to handle the trade
-   TRADE_FAILED_SLIPPAGE: trade is greater than the max implied rate set
-   INSUFFICIENT_FREE_COLLATERAL: insufficient free collateral to take on the debt

---

### `getCollateralToFutureCash`

> Given the amount of future cash to purchase, returns the amount of collateral this would cost at the current
> block.

#### Parameters:

-   `maturity`: the maturity of the future cash
-   `futureCashAmount`: the amount of future cash to purchase

#### Return Values:

-   the amount of collateral this would cost, returns 0 on trade failure

---

### `getCollateralToFutureCashAtTime`

> Given the amount of future cash to purchase, returns the amount of collateral this would cost.

#### Parameters:

-   `maturity`: the maturity of the future cash
-   `futureCashAmount`: the amount of future cash to purchase
-   `blockTime`: the time to calculate the price at

#### Return Values:

-   the amount of collateral this would cost, returns 0 on trade failure

#### Error Codes:

-   CANNOT_GET_PRICE_FOR_MATURITY: can only get prices before the maturity

---

### `takeFutureCash`

> Deposit collateral in return for the right to receive cash at the specified maturity. Equivalent to lending
> your collateral at a fixed rate.

#### Parameters:

-   `maturity`: the period to receive future cash in
-   `futureCashAmount`: the amount of future cash to purchase
-   `maxTime`: after this time the trade will not settle
-   `minImpliedRate`: the minimum implied rate that the lender will accept

#### Return Values:

-   the amount of collateral deposited to the market

#### Error Codes:

-   TRADE_FAILED_MAX_TIME: maturity specified is not yet active
-   MARKET_INACTIVE: maturity is not a valid one
-   TRADE_FAILED_TOO_LARGE: trade is larger than allowed by the governance settings
-   TRADE_FAILED_LACK_OF_LIQUIDITY: there is insufficient liquidity in this maturity to handle the trade
-   TRADE_FAILED_SLIPPAGE: trade is lower than the min implied rate set
-   INSUFFICIENT_BALANCE: not enough collateral to complete this trade

---

### `getRate`

> Returns the current discount rate for the market. Will not return negative interest rates

#### Parameters:

-   `maturity`: the maturity to get the rate for

#### Return Values:

-   a tuple where the first value is the simple discount rate and the second value is a boolean indicating
    whether or not the maturity has passed

---

### `getMarketRates`

> Gets the rates for all the active markets.

#### Return Values:

-   an array of rates starting from the most current maturity to the furthest maturity

---

### `getActiveMaturities`

> Gets the maturities for all the active markets.

#### Return Values:

-   an array of blocks where the currently active markets will mature at

---

# Events

### `UpdateRateFactors`

> Emitted when rate factors are updated, will take effect at the next maturity

#### Parameters:

-   `rateAnchor`: the new rate anchor
-   `rateScalar`: the new rate scalar

---

### `UpdateMaxTradeSize`

> Emitted when max trade size is updated, takes effect immediately

#### Parameters:

-   `maxTradeSize`: the new max trade size

---

### `UpdateFees`

> Emitted when fees are updated, takes effect immediately

#### Parameters:

-   `liquidityFee`: the new liquidity fee
-   `transactionFee`: the new transaction fee

---

### `AddLiquidity`

> Emitted when liquidity is added to a maturity

#### Parameters:

-   `account`: the account that performed the trade
-   `maturity`: the maturity that this trade affects
-   `tokens`: amount of liquidity tokens issued
-   `futureCash`: amount of future cash tokens added
-   `collateral`: amount of collateral tokens added

---

### `RemoveLiquidity`

> Emitted when liquidity is removed from a maturity

#### Parameters:

-   `account`: the account that performed the trade
-   `maturity`: the maturity that this trade affects
-   `tokens`: amount of liquidity tokens burned
-   `futureCash`: amount of future cash tokens removed
-   `collateral`: amount of collateral tokens removed

---

### `TakeCollateral`

> Emitted when collateral is taken from a maturity

#### Parameters:

-   `account`: the account that performed the trade
-   `maturity`: the maturity that this trade affects
-   `futureCash`: amount of future cash tokens added
-   `collateral`: amount of collateral tokens removed
-   `fee`: amount of transaction fee charged

---

### `TakeFutureCash`

> Emitted when future cash is taken from a maturity

#### Parameters:

-   `account`: the account that performed the trade
-   `maturity`: the maturity that this trade affects
-   `futureCash`: amount of future cash tokens removed
-   `collateral`: amount of collateral tokens added
-   `fee`: amount of transaction fee charged

---

# Governance Methods

### `setRateFactors`

> Sets rate factors that will determine the liquidity curve

#### Parameters:

-   `rateAnchor`: the offset of the liquidity curve
-   `rateScalar`: the sensitivity of the liquidity curve to changes

---

### `setMaxTradeSize`

> Sets the maximum amount that can be traded in a single trade

#### Parameters:

-   `amount`: the max trade size

---

### `setFee`

> Sets fee parameters for the market

#### Parameters:

-   `liquidityFee`: a change in the traded exchange rate paid to liquidity providers
-   `transactionFee`: percentage of a transaction that accrues to the reserve account

---
