# RiskFramework

Calculates the currency requirements for a portfolio.


## Methods
- [`getRequirement(struct Common.Asset[] portfolio)`](#getRequirement)


## Governance Methods
- [`setHaircut(uint128 haircut)`](#setHaircut)

# Methods
### `getRequirement`
> Given a portfolio of assets, returns a set of requirements in every currency represented.

#### Parameters:
- `portfolio`: a portfolio of assets

#### Return Values:
- a set of requirements in every currency represented by the portfolio


***



# Governance Methods
### `setHaircut`
> Sets the haircut amount for the portfolio

#### Parameters:
- `haircut`: amount of negative haircut applied to debt

***
