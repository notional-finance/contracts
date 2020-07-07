# FutureCash

Marketplace for trading future cash tokens to create fixed rate entitlements or obligations.


## Methods
- [`addLiquidity(uint32 maturity, uint128 minCollateral, uint128 maxFutureCash, uint32 maxBlock)`](#addLiquidity)
- [`removeLiquidity(uint32 maturity, uint128 amount, uint32 maxBlock)`](#removeLiquidity)
- [`getFutureCashToCollateral(uint32 maturity, uint128 futureCashAmount)`](#getFutureCashToCollateral)
- [`getFutureCashToCollateralBlock(uint32 maturity, uint128 futureCashAmount, uint32 blockNum)`](#getFutureCashToCollateralBlock)
- [`takeCollateral(uint32 maturity, uint128 futureCashAmount, uint32 maxBlock, uint32 maxImpliedRate)`](#takeCollateral)
- [`getCollateralToFutureCash(uint32 maturity, uint128 futureCashAmount)`](#getCollateralToFutureCash)
- [`getCollateralToFutureCashBlock(uint32 maturity, uint128 futureCashAmount, uint32 blockNum)`](#getCollateralToFutureCashBlock)
- [`takeFutureCash(uint32 maturity, uint128 futureCashAmount, uint32 maxBlock, uint128 minImpliedRate)`](#takeFutureCash)
- [`getRate(uint32 maturity)`](#getRate)
- [`getMarketRates()`](#getMarketRates)
- [`getActiveMaturities()`](#getActiveMaturities)

## Events
- [`UpdateRateFactors(uint32 rateAnchor, uint16 rateScalar)`](#UpdateRateFactors)
- [`UpdateMaxTradeSize(uint128 maxTradeSize)`](#UpdateMaxTradeSize)
- [`UpdateFees(uint32 liquidityFee, uint128 transactionFee)`](#UpdateFees)
- [`AddLiquidity(address account, uint32 maturity, uint128 tokens, uint128 futureCash, uint128 collateral)`](#AddLiquidity)
- [`RemoveLiquidity(address account, uint32 maturity, uint128 tokens, uint128 futureCash, uint128 collateral)`](#RemoveLiquidity)
- [`TakeCollateral(address account, uint32 maturity, uint128 futureCash, uint128 collateral, uint128 fee)`](#TakeCollateral)
- [`TakeFutureCash(address account, uint32 maturity, uint128 futureCash, uint128 collateral, uint128 fee)`](#TakeFutureCash)

## Governance Methods
- [`setRateFactors(uint32 rateAnchor, uint16 rateScalar)`](#setRateFactors)
- [`setMaxTradeSize(uint128 amount)`](#setMaxTradeSize)
- [`setFee(uint32 liquidityFee, uint128 transactionFee)`](#setFee)

# Methods
### `addLiquidity`
> Adds some amount of collateral to the liquidity pool up to the corresponding amount defined by
`maxFutureCash`. Mints liquidity tokens back to the sender.

#### Parameters:
- `maturity`: the period to add liquidity to

- `minCollateral`: the amount of collateral to add to the pool

- `maxFutureCash`: the maximum amount of future cash to add to the pool

- `maxBlock`: after this block the trade will fail

***

### `removeLiquidity`
> Removes liquidity from the future cash market. The sender's liquidity tokens are burned and they
are credited back with future cash and collateral at the prevailing exchange rate. This function
only works when removing liquidity from an active market. For markets that are matured, the sender
must settle their liquidity token via `Portfolios().settleAccount()`.

#### Parameters:
- `maturity`: the period to remove liquidity from

- `amount`: the amount of liquidity tokens to burn

- `maxBlock`: after this block the trade will fail

***

### `getFutureCashToCollateral`
> Given the amount of future cash put into a market, how much collateral this would
purchase at the current block.

#### Parameters:
- `maturity`: the maturity of the future cash

- `futureCashAmount`: the amount of future cash to input

#### Return Values:
- the amount of collateral this would purchase, returns 0 if the trade will fail

***

### `getFutureCashToCollateralBlock`
> Given the amount of future cash put into a market, how much collateral this would
purchase at the given block. Future cash exchange rates change as we go towards maturity.

#### Parameters:
- `maturity`: the maturity of the future cash

- `futureCashAmount`: the amount of future cash to input

- `blockNum`: the specified block number

#### Return Values:
- the amount of collateral this would purchase, returns 0 if the trade will fail

***

### `takeCollateral`
> Receive collateral in exchange for a future cash obligation. Equivalent to borrowing
collateral at a fixed rate.

#### Parameters:
- `maturity`: the maturity block of the future cash being exchange for current cash

- `futureCashAmount`: the amount of future cash to deposit, will convert this amount to current cash
at the prevailing exchange rate

- `maxBlock`: after this block the trade will not settle

- `maxImpliedRate`: the maximum implied period rate that the borrower will accept

#### Return Values:
- the amount of collateral purchased

***

### `getCollateralToFutureCash`
> Given the amount of future cash to purchase, returns the amount of collateral this would cost at the current
block.

#### Parameters:
- `maturity`: the maturity of the future cash

- `futureCashAmount`: the amount of future cash to purchase

#### Return Values:
- the amount of collateral this would cost, returns 0 on trade failure

***

### `getCollateralToFutureCashBlock`
> Given the amount of future cash to purchase, returns the amount of collateral this would cost.

#### Parameters:
- `maturity`: the maturity of the future cash

- `futureCashAmount`: the amount of future cash to purchase

- `blockNum`: the block to calculate the price at

#### Return Values:
- the amount of collateral this would cost, returns 0 on trade failure

***

### `takeFutureCash`
> Deposit collateral in return for the right to receive cash at the specified maturity. Equivalent to lending
your collateral at a fixed rate.

#### Parameters:
- `maturity`: the period to receive future cash in

- `futureCashAmount`: the amount of future cash to purchase

- `maxBlock`: after this block the trade will not settle

- `minImpliedRate`: the minimum implied rate that the lender will accept

#### Return Values:
- the amount of collateral deposited to the market

***

### `getRate`
> Returns the current discount rate for the market. Will not return negative interest rates

#### Parameters:
- `maturity`: the maturity to get the rate for

#### Return Values:
- a tuple where the first value is the simple discount rate and the second value is a boolean indicating
whether or not the maturity has passed

***

### `getMarketRates`
> Gets the rates for all the active markets.

#### Return Values:
- an array of rates starting from the most current maturity to the furthest maturity

***

### `getActiveMaturities`
> Gets the maturities for all the active markets.

#### Return Values:
- an array of blocks where the currently active markets will mature at

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

- `futureCash`: amount of future cash tokens added

- `collateral`: amount of collateral tokens added

***

### `RemoveLiquidity`
> Emitted when liquidity is removed from a maturity

#### Parameters:
- `account`: the account that performed the trade

- `maturity`: the maturity that this trade affects

- `tokens`: amount of liquidity tokens burned

- `futureCash`: amount of future cash tokens removed

- `collateral`: amount of collateral tokens removed

***

### `TakeCollateral`
> Emitted when collateral is taken from a maturity

#### Parameters:
- `account`: the account that performed the trade

- `maturity`: the maturity that this trade affects

- `futureCash`: amount of future cash tokens added

- `collateral`: amount of collateral tokens removed

- `fee`: amount of transaction fee charged

***

### `TakeFutureCash`
> Emitted when future cash is taken from a maturity

#### Parameters:
- `account`: the account that performed the trade

- `maturity`: the maturity that this trade affects

- `futureCash`: amount of future cash tokens removed

- `collateral`: amount of collateral tokens added

- `fee`: amount of transaction fee charged

***


# Governance Methods
### `setRateFactors`
> Sets rate factors that will determine the liquidity curve

#### Parameters:
- `rateAnchor`: the offset of the liquidity curve

- `rateScalar`: the sensitivity of the liquidity curve to changes

***
### `setMaxTradeSize`
> Sets the maximum amount that can be traded in a single trade

#### Parameters:
- `amount`: the max trade size

***
### `setFee`
> Sets fee parameters for the market

#### Parameters:
- `liquidityFee`: a change in the traded exchange rate paid to liquidity providers

- `transactionFee`: percentage of a transaction that accrues to the reserve account

***
