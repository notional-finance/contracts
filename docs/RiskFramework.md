# RiskFramework

Calculates the currency requirements for a portfolio.


## Methods
- [`getRequirement(struct Common.Asset[] portfolio)`](#getRequirement)

## Events
- [`SetLiquidityHaircut(uint128 liquidityHaircut)`](#SetLiquidityHaircut)

## Governance Methods
- [`setHaircut(uint128 haircut)`](#setHaircut)

# Methods
### `getRequirement`
> Given a portfolio of assets, returns a set of requirements in every currency represented.
#### Parameters:
- `portfolio`: a portfolio of assets
#### Return Values:
- a set of requirements in every future cash group represented by the portfolio


***


# Events
### `SetLiquidityHaircut`
> Notice for setting haircut amount for liquidity tokens
#### Parameters:
- `liquidityHaircut`: amount of haircut applied to liquidity token claims

***


# Governance Methods
### `setHaircut`
> Sets the haircut amount for liquidity token claims, this is assumed to be a decimal number
multiplied by 1e18. A 5% haircut would be set as 1.05e18.
#### Parameters:
- `haircut`: amount of negative haircut applied to debt

***
