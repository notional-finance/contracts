# Portfolios

Manages account portfolios which includes all fCash positions and liquidity tokens.


## Methods
- [`getAssets(address account)`](#getAssets)
- [`getAsset(address account, uint256 index)`](#getAsset)
- [`getCashGroup(uint8 cashGroupId)`](#getCashGroup)
- [`getCashGroups(uint8[] groupIds)`](#getCashGroups)
- [`searchAccountAsset(address account, bytes1 assetType, uint8 cashGroupId, uint16 instrumentId, uint32 maturity)`](#searchAccountAsset)
- [`freeCollateral(address account)`](#freeCollateral)
- [`freeCollateralAggregateOnly(address account)`](#freeCollateralAggregateOnly)
- [`freeCollateralView(address account)`](#freeCollateralView)
- [`settleMaturedAssets(address account)`](#settleMaturedAssets)
- [`settleMaturedAssetsBatch(address[] accounts)`](#settleMaturedAssetsBatch)

## Events
- [`SettleAccount(address account)`](#SettleAccount)
- [`SettleAccountBatch(address[] accounts)`](#SettleAccountBatch)
- [`NewCashGroup(uint8 cashGroupId)`](#NewCashGroup)
- [`UpdateCashGroup(uint8 cashGroupId)`](#UpdateCashGroup)
- [`SetMaxAssets(uint256 maxAssets)`](#SetMaxAssets)
- [`SetLiquidityHaircut(uint128 liquidityHaircut)`](#SetLiquidityHaircut)

## Governance Methods
- [`setHaircut(uint128 haircut)`](#setHaircut)
- [`setMaxAssets(uint256 maxAssets)`](#setMaxAssets)
- [`createCashGroup(uint32 numMaturities, uint32 maturityLength, uint32 precision, uint16 currency, address cashMarket)`](#createCashGroup)
- [`updateCashGroup(uint8 cashGroupId, uint32 numMaturities, uint32 maturityLength, uint32 precision, uint16 currency, address cashMarket)`](#updateCashGroup)

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

### `getCashGroup`
> Returns a particular cash group
#### Parameters:
- `cashGroupId`: to retrieve
#### Return Values:
- the given cash group


***

### `getCashGroups`
> Returns a batch of cash groups
#### Parameters:
- `groupIds`: array of cash group ids to retrieve
#### Return Values:
- an array of cash group objects


***

### `searchAccountAsset`
> Public method for searching for a asset in an account.
#### Parameters:
- `account`: account to search
- `assetType`: the type of asset to search for
- `cashGroupId`: the cash group id
- `instrumentId`: the instrument id
- `maturity`: the maturity timestamp of the asset
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
- net free collateral position, an array of the net currency available)


***

### `freeCollateralAggregateOnly`
> No description


***

### `freeCollateralView`
> Returns the free collateral balance for an account as a view functon.
#### Parameters:
- `account`: account in question
#### Return Values:
- net free collateral position, an array of the net currency available)

#### Error Codes:
- INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0

***

### `settleMaturedAssets`
> Settles all matured cash assets and liquidity tokens in a user's portfolio. This method is
unauthenticated, anyone may settle the assets in any account. This is required for accounts that
have negative cash and counterparties need to settle against them. Generally, external developers
should not need to call this function. We ensure that accounts are settled on every free collateral
check, cash settlement, and liquidation.
#### Parameters:
- `account`: the account referenced


***

### `settleMaturedAssetsBatch`
> Settle a batch of accounts. See note for `settleMaturedAssets`, external developers should not need
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

### `NewCashGroup`
> Emitted when a new cash group is listed
#### Parameters:
- `cashGroupId`: id of the new cash group

***

### `UpdateCashGroup`
> Emitted when a new cash group is updated
#### Parameters:
- `cashGroupId`: id of the updated cash group

***

### `SetMaxAssets`
> Emitted when max assets is set
#### Parameters:
- `maxAssets`: the max assets a portfolio can hold

***

### `SetLiquidityHaircut`
> Notice for setting haircut amount for liquidity tokens
#### Parameters:
- `liquidityHaircut`: amount of haircut applied to liquidity token claims

***


# Governance Methods
### `setHaircut`
> Sets the haircut amount for liquidity token claims, this is set to a percentage
less than 1e18, for example, a 5% haircut will be set to 0.95e18.
#### Parameters:
- `haircut`: amount of negative haircut applied to debt

***
### `setMaxAssets`
> Set the max assets that a portfolio can hold. The default will be initialized to something
like 10 assets, but this will be increased as new markets are created.
#### Parameters:
- `maxAssets`: new max asset number

***
### `createCashGroup`
> An cash group defines a collection of similar fCashs where the risk ladders can be netted
against each other. The identifier is only 1 byte so we can only have 255 cash groups, 0 is unused.
#### Parameters:
- `numMaturities`: the total number of maturitys
- `maturityLength`: the maturity length (in seconds)
- `precision`: the discount rate precision
- `currency`: the token address of the currenty this fCash settles in
- `cashMarket`: the rate oracle that defines the discount rate

***
### `updateCashGroup`
> Updates cash groups. Be very careful when calling this function! When changing maturities and
maturity sizes the markets must be updated as well.
#### Parameters:
- `cashGroupId`: the group id to update
- `numMaturities`: this is safe to update as long as the discount rate oracle is not shared
- `maturityLength`: this is only safe to update when there are no assets left
- `precision`: this is only safe to update when there are no assets left
- `currency`: this is safe to update if there are no assets or the new currency is equivalent
- `cashMarket`: this is safe to update once the oracle is established

***
