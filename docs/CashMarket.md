# CashMarket

Marketplace for trading cash to fCash tokens. Implements a specialized AMM for trading such assets.


## Methods
- [`addLiquidity(uint32 maturity, uint128 cash, uint128 maxfCash, uint32 minImpliedRate, uint32 maxImpliedRate, uint32 maxTime)`](#addLiquidity)
- [`removeLiquidity(uint32 maturity, uint128 amount, uint32 maxTime)`](#removeLiquidity)
- [`getfCashToCurrentCash(uint32 maturity, uint128 fCashAmount)`](#getfCashToCurrentCash)
- [`getfCashToCurrentCashAtTime(uint32 maturity, uint128 fCashAmount, uint32 blockTime)`](#getfCashToCurrentCashAtTime)
- [`takeCurrentCash(uint32 maturity, uint128 fCashAmount, uint32 maxTime, uint32 maxImpliedRate)`](#takeCurrentCash)
- [`getCurrentCashTofCash(uint32 maturity, uint128 fCashAmount)`](#getCurrentCashTofCash)
- [`getCurrentCashTofCashAtTime(uint32 maturity, uint128 fCashAmount, uint32 blockTime)`](#getCurrentCashTofCashAtTime)
- [`takefCash(uint32 maturity, uint128 fCashAmount, uint32 maxTime, uint128 minImpliedRate)`](#takefCash)
- [`getMarket(uint32 maturity)`](#getMarket)
- [`getRate(uint32 maturity)`](#getRate)
- [`getMarketRates()`](#getMarketRates)
- [`getActiveMaturities()`](#getActiveMaturities)

## Events
- [`UpdateRateFactors(uint32 rateAnchor, uint16 rateScalar)`](#UpdateRateFactors)
- [`UpdateMaxTradeSize(uint128 maxTradeSize)`](#UpdateMaxTradeSize)
- [`UpdateFees(uint32 liquidityFee, uint128 transactionFee)`](#UpdateFees)
- [`AddLiquidity(address account, uint32 maturity, uint128 tokens, uint128 fCash, uint128 cash)`](#AddLiquidity)
- [`RemoveLiquidity(address account, uint32 maturity, uint128 tokens, uint128 fCash, uint128 cash)`](#RemoveLiquidity)
- [`TakeCurrentCash(address account, uint32 maturity, uint128 fCash, uint128 cash, uint128 fee)`](#TakeCurrentCash)
- [`TakefCash(address account, uint32 maturity, uint128 fCash, uint128 cash, uint128 fee)`](#TakefCash)

## Governance Methods
- [`setRateFactors(uint32 rateAnchor, uint16 rateScalar)`](#setRateFactors)
- [`setMaxTradeSize(uint128 amount)`](#setMaxTradeSize)
- [`setFee(uint32 liquidityFee, uint128 transactionFee)`](#setFee)

# Methods
### `addLiquidity`
> Adds some amount of cash to the liquidity pool up to the corresponding amount defined by
`maxfCash`. Mints liquidity tokens back to the sender.
#### Parameters:
- `maturity`: the maturity to add liquidity to
- `cash`: the amount of cash to add to the pool
- `maxfCash`: the max amount of fCash to add to the pool. When initializing a pool this is the
amount of fCash that will be added.
- `minImpliedRate`: the minimum implied rate that we will add liquidity at
- `maxImpliedRate`: the maximum implied rate that we will add liquidity at
- `maxTime`: after this time the trade will fail

#### Error Codes:
- TRADE_FAILED_MAX_TIME: maturity specified is not yet active
- MARKET_INACTIVE: maturity is not a valid one
- OVER_MAX_FCASH: fCash amount required exceeds supplied maxfCash
- OUT_OF_IMPLIED_RATE_BOUNDS: depositing cash would require more fCash than specified
- INSUFFICIENT_BALANCE: insufficient cash to deposit into market

***

### `removeLiquidity`
> Removes liquidity from the fCash market. The sender's liquidity tokens are burned and they
are credited back with fCash and cash at the prevailing exchange rate. This function
only works when removing liquidity from an active market. For markets that are matured, the sender
must settle their liquidity token via `Portfolios.settleMaturedAssets`.
#### Parameters:
- `maturity`: the maturity to remove liquidity from
- `amount`: the amount of liquidity tokens to burn
- `maxTime`: after this block the trade will fail
#### Return Values:
- the amount of cash claim the removed liquidity tokens have

#### Error Codes:
- TRADE_FAILED_MAX_TIME: maturity specified is not yet active
- MARKET_INACTIVE: maturity is not a valid one
- INSUFFICIENT_BALANCE: account does not have sufficient tokens to remove

***

### `getfCashToCurrentCash`
> Given the amount of fCash put into a market, how much cash this would
purchase at the current block.
#### Parameters:
- `maturity`: the maturity of the fCash
- `fCashAmount`: the amount of fCash to input
#### Return Values:
- the amount of cash this would purchase, returns 0 if the trade will fail


***

### `getfCashToCurrentCashAtTime`
> Given the amount of fCash put into a market, how much cash this would
purchase at the given time. fCash exchange rates change as we go towards maturity.
#### Parameters:
- `maturity`: the maturity of the fCash
- `fCashAmount`: the amount of fCash to input
- `blockTime`: the specified block time
#### Return Values:
- the amount of cash this would purchase, returns 0 if the trade will fail

#### Error Codes:
- CANNOT_GET_PRICE_FOR_MATURITY: can only get prices before the maturity

***

### `takeCurrentCash`
> Receive cash in exchange for a fCash obligation. Equivalent to borrowing
cash at a fixed rate.
#### Parameters:
- `maturity`: the maturity of the fCash being exchanged for current cash
- `fCashAmount`: the amount of fCash to sell, will convert this amount to current cash
at the prevailing exchange rate.
- `maxTime`: after this time the trade will not settle
- `maxImpliedRate`: the maximum implied maturity rate that the borrower will accept
#### Return Values:
- the amount of cash purchased, `fCashAmount - cash` determines the fixed interested owed.

#### Error Codes:
- TRADE_FAILED_MAX_TIME: maturity specified is not yet active
- MARKET_INACTIVE: maturity is not a valid one
- TRADE_FAILED_TOO_LARGE: trade is larger than allowed by the governance settings
- TRADE_FAILED_LACK_OF_LIQUIDITY: there is insufficient liquidity in this maturity to handle the trade
- TRADE_FAILED_SLIPPAGE: trade is greater than the max implied rate set
- INSUFFICIENT_FREE_COLLATERAL: insufficient free collateral to take on the debt

***

### `getCurrentCashTofCash`
> Given the amount of fCash to purchase, returns the amount of cash this would cost at the current
block.
#### Parameters:
- `maturity`: the maturity of the fCash
- `fCashAmount`: the amount of fCash to purchase
#### Return Values:
- the amount of cash this would cost, returns 0 on trade failure


***

### `getCurrentCashTofCashAtTime`
> Given the amount of fCash to purchase, returns the amount of cash this would cost.
#### Parameters:
- `maturity`: the maturity of the fCash
- `fCashAmount`: the amount of fCash to purchase
- `blockTime`: the time to calculate the price at
#### Return Values:
- the amount of cash this would cost, returns 0 on trade failure

#### Error Codes:
- CANNOT_GET_PRICE_FOR_MATURITY: can only get prices before the maturity

***

### `takefCash`
> Deposit cash in return for the right to receive cash at the specified maturity. Equivalent to lending
cash at a fixed rate.
#### Parameters:
- `maturity`: the maturity to receive fCash in
- `fCashAmount`: the amount of fCash to purchase
- `maxTime`: after this time the trade will not settle
- `minImpliedRate`: the minimum implied rate that the lender will accept
#### Return Values:
- the amount of cash deposited to the market, `fCashAmount - cash` is the interest to be received

#### Error Codes:
- TRADE_FAILED_MAX_TIME: maturity specified is not yet active
- MARKET_INACTIVE: maturity is not a valid one
- TRADE_FAILED_TOO_LARGE: trade is larger than allowed by the governance settings
- TRADE_FAILED_LACK_OF_LIQUIDITY: there is insufficient liquidity in this maturity to handle the trade
- TRADE_FAILED_SLIPPAGE: trade is lower than the min implied rate set
- INSUFFICIENT_BALANCE: not enough cash to complete this trade

***

### `getMarket`
> Returns the market object at the specified maturity
#### Parameters:
- `maturity`: the maturity of the market
#### Return Values:
- A market object with these values:
- `totalfCash`: total amount of fCash available at the maturity
- `totalLiquidity`: total amount of liquidity tokens
- `totalCurrentCash`: total amount of current cash available at maturity
- `rateScalar`: determines the slippage rate during trading
- `rateAnchor`: determines the base rate at market instantiation
- `lastImpliedRate`: the last rate that the market traded at, used to smooth rates between periods of
trading inactivity.


***

### `getRate`
> Returns the current mid exchange rate of cash to fCash. This is NOT the rate that users will be able to trade it, those
calculations depend on trade size and you must use the `getCurrentCashTofCash` or `getfCashToCurrentCash` methods.
#### Parameters:
- `maturity`: the maturity to get the rate for
#### Return Values:
- a tuple where the first value is the exchange rate and the second value is a boolean indicating
whether or not the maturity is active


***

### `getMarketRates`
> Gets the exchange rates for all the active markets.
#### Return Values:
- an array of rates starting from the most current maturity to the furthest maturity


***

### `getActiveMaturities`
> Gets the maturities for all the active markets.
#### Return Values:
- an array of timestamps of the currently active maturities


***


# Events
### `UpdateRateFactors`
> Emitted when rate factors are updated, will take effect at the next maturity
#### Parameters:
- `rateAnchor`: the new rate anchor
- `rateScalar`: the new rate scalar

***

### `UpdateMaxTradeSize`
> Emitted when max trade size is updated, takes effect immediately
#### Parameters:
- `maxTradeSize`: the new max trade size

***

### `UpdateFees`
> Emitted when fees are updated, takes effect immediately
#### Parameters:
- `liquidityFee`: the new liquidity fee
- `transactionFee`: the new transaction fee

***

### `AddLiquidity`
> Emitted when liquidity is added to a maturity
#### Parameters:
- `account`: the account that performed the trade
- `maturity`: the maturity that this trade affects
- `tokens`: amount of liquidity tokens issued
- `fCash`: amount of fCash tokens added
- `cash`: amount of cash tokens added

***

### `RemoveLiquidity`
> Emitted when liquidity is removed from a maturity
#### Parameters:
- `account`: the account that performed the trade
- `maturity`: the maturity that this trade affects
- `tokens`: amount of liquidity tokens burned
- `fCash`: amount of fCash tokens removed
- `cash`: amount of cash tokens removed

***

### `TakeCurrentCash`
> Emitted when cash is taken from a maturity
#### Parameters:
- `account`: the account that performed the trade
- `maturity`: the maturity that this trade affects
- `fCash`: amount of fCash tokens added
- `cash`: amount of cash tokens removed
- `fee`: amount of transaction fee charged

***

### `TakefCash`
> Emitted when fCash is taken from a maturity
#### Parameters:
- `account`: the account that performed the trade
- `maturity`: the maturity that this trade affects
- `fCash`: amount of fCash tokens removed
- `cash`: amount of cash tokens added
- `fee`: amount of transaction fee charged

***


# Governance Methods
### `setRateFactors`
> Sets rate factors that will determine the liquidity curve. Rate Anchor is set as the target annualized exchange
rate so 1.10 * INSTRUMENT_PRECISION represents a target annualized rate of 10%. Rate anchor will be scaled accordingly
when a fCash market is initialized. As a general default, INSTRUMENT_PRECISION will be set to 1e9.
#### Parameters:
- `rateAnchor`: the offset of the liquidity curve
- `rateScalar`: the sensitivity of the liquidity curve to changes

***
### `setMaxTradeSize`
> Sets the maximum amount that can be traded in a single trade.
#### Parameters:
- `amount`: the max trade size

***
### `setFee`
> Sets fee parameters for the market. Liquidity Fees are set as basis points and shift the traded
exchange rate. A basis point is the equivalent of 1e5 if INSTRUMENT_PRECISION is set to 1e9.
Transaction fees are set as a percentage shifted by 1e18. For example a 1% transaction fee will be set
as 1.01e18.
#### Parameters:
- `liquidityFee`: a change in the traded exchange rate paid to liquidity providers
- `transactionFee`: percentage of a transaction that accrues to the reserve account

***
