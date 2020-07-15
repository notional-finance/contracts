pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./utils/Common.sol";
import "./utils/Governed.sol";

import "./lib/SafeMath.sol";
import "./lib/SafeInt256.sol";
import "./lib/SafeUInt128.sol";

import "./interface/IRateOracle.sol";
import "./interface/IPortfoliosCallable.sol";

import "./storage/PortfoliosStorage.sol";
import "./FutureCash.sol";

/**
 * @title Portfolios
 * @notice Manages account portfolios which includes all future cash positions and liquidity tokens.
 */
contract Portfolios is PortfoliosStorage, IPortfoliosCallable, Governed {
    using SafeMath for uint256;
    using SafeInt256 for int256;
    using SafeUInt128 for uint128;

    struct TradePortfolioState {
        uint128 amountRemaining;
        uint256 indexCount;
        int256 unlockedCollateral;
        Common.Asset[] portfolioChanges;
    }

    /**
     * @notice Emitted when an account has its portfolio settled, only emitted if the portfolio has changed
     * @param account the account that had its porfolio modified
     */
    event SettleAccount(address account);

    /**
     * @notice Emitted when an account has its portfolio settled, all accounts are emitted in the batch
     * @param accounts batch of accounts that *may* have been settled
     */
    event SettleAccountBatch(address[] accounts);

    /**
     * @notice Emitted when a new future cash group is listed
     * @param futureCashGroupId id of the new future cash group
     */
    event NewFutureCashGroup(uint8 indexed futureCashGroupId);

    /**
     * @notice Emitted when a new future cash group is updated
     * @param futureCashGroupId id of the updated future cash group
     */
    event UpdateFutureCashGroup(uint8 indexed futureCashGroupId);

    /**
     * @dev skip
     * @param directory holds contract addresses for dependencies
     * @param numCurrencies initializes the number of currencies listed on the escrow contract
     */
    function initialize(address directory, uint16 numCurrencies) public initializer {
        Governed.initialize(directory);

        // We must initialize this here because it cannot be a constant.
        NULL_ASSET = Common.Asset(0, 0, 0, 0, 0, 0, 0);
        G_NUM_CURRENCIES = numCurrencies;
    }

    /****** Governance Parameters ******/

    /**
     * @dev skip
     * @param numCurrencies the total number of currencies set by escrow
     */
    function setNumCurrencies(uint16 numCurrencies) public override {
        require(calledByEscrow(), $$(ErrorCode(UNAUTHORIZED_CALLER)));
        G_NUM_CURRENCIES = numCurrencies;
    }

    /**
     * @notice An future cash group defines a collection of similar future cashs where the risk ladders can be netted
     * against each other. The identifier is only 1 byte so we can only have 255 future cash groups, 0 is unused.
     * @dev governance
     * @param numPeriods the total number of periods
     * @param periodSize the baseline period length (in blocks) for periodic swaps in this future cash.
     * @param precision the discount rate precision
     * @param currency the token address of the currenty this future cash settles in
     * @param futureCashMarket the rate oracle that defines the discount rate
     */
    function createFutureCashGroup(
        uint32 numPeriods,
        uint32 periodSize,
        uint32 precision,
        uint16 currency,
        address futureCashMarket,
        address riskFormula
    ) external onlyOwner {
        require(currentFutureCashGroupId <= MAX_FUTURE_CASH_GROUPS, $$(ErrorCode(OVER_FUTURE_CASH_GROUP_LIMIT)));
        require(Escrow().isTradableCurrency(currency), $$(ErrorCode(INVALID_CURRENCY)));

        currentFutureCashGroupId++;
        futureCashGroups[currentFutureCashGroupId] = Common.FutureCashGroup(
            numPeriods,
            periodSize,
            precision,
            currency,
            futureCashMarket,
            riskFormula
        );

        // The future cash is set to 0 for discount rate oracles and there is no max rate as well.
        IRateOracle(futureCashMarket).setParameters(
            currentFutureCashGroupId,
            0,
            precision,
            periodSize,
            numPeriods,
            0
        );

        emit NewFutureCashGroup(currentFutureCashGroupId);
    }

    /**
     * @notice Updates future cash groups. Be very careful when calling this function! When changing periods and
     * period sizes the markets must be updated as well.
     * @dev governance
     * @param futureCashGroupId the group id to update
     * @param numPeriods this is safe to update as long as the discount rate oracle is not shared
     * @param periodSize this is only safe to update when there are no assets left
     * @param precision this is only safe to update when there are no assets left
     * @param currency this is safe to update if there are no assets or the new currency is equivalent
     * @param futureCashMarket this is safe to update once the oracle is established
     */
    function updateFutureCashGroup(
        uint8 futureCashGroupId,
        uint32 numPeriods,
        uint32 periodSize,
        uint32 precision,
        uint16 currency,
        address futureCashMarket,
        address riskFormula
    ) external onlyOwner {
        require(
            futureCashGroupId != 0 && futureCashGroupId <= currentFutureCashGroupId,
            $$(ErrorCode(INVALID_FUTURE_CASH_GROUP))
        );
        require(Escrow().isTradableCurrency(currency), $$(ErrorCode(INVALID_CURRENCY)));

        Common.FutureCashGroup storage i = futureCashGroups[futureCashGroupId];
        if (i.numPeriods != numPeriods) i.numPeriods = numPeriods;
        if (i.periodSize != periodSize) i.periodSize = periodSize;
        if (i.precision != precision) i.precision = precision;
        if (i.currency != currency) i.currency = currency;
        if (i.futureCashMarket != futureCashMarket) i.futureCashMarket = futureCashMarket;
        if (i.riskFormula != riskFormula) i.riskFormula = riskFormula;

        // The future cash is set to 0 for discount rate oracles and there is no max rate as well.
        IRateOracle(futureCashMarket).setParameters(
            futureCashGroupId,
            0,
            precision,
            periodSize,
            numPeriods,
            0
        );

        emit UpdateFutureCashGroup(futureCashGroupId);
    }
    /****** Governance Parameters ******/

    /***** Public View Methods *****/

    /**
     * @notice Returns the assets of an account
     * @param account to retrieve
     * @return an array representing the account's portfolio
     */
    function getAssets(address account) public override view returns (Common.Asset[] memory) {
        return _accountAssets[account];
    }

    /**
     * @notice Returns a particular asset via index
     * @param account to retrieve
     * @param index of asset
     * @return a single asset by index in the portfolio
     */
    function getAsset(address account, uint256 index) public view returns (Common.Asset memory) {
        return _accountAssets[account][index];
    }

    /**
     * @notice Returns a particular future cash group
     * @param futureCashGroupId to retrieve
     * @return the given future cash group
     */
    function getFutureCashGroup(
        uint8 futureCashGroupId
    ) public view override returns (Common.FutureCashGroup memory) {
        return futureCashGroups[futureCashGroupId];
    }

    /**
     * @notice Returns a batch of future cash groups
     * @param groupIds array of future cash group ids to retrieve
     * @return an array of future cash group objects
     */
    function getFutureCashGroups(
        uint8[] memory groupIds
    ) public view override returns (Common.FutureCashGroup[] memory) {
        Common.FutureCashGroup[] memory results = new Common.FutureCashGroup[](groupIds.length);

        for (uint256 i; i < groupIds.length; i++) {
            results[i] = futureCashGroups[groupIds[i]];
        }

        return results;
    }

    /**
     * @notice Public method for searching for a asset in an account.
     * @param account account to search
     * @param swapType the type of swap to search for
     * @param futureCashGroupId the future cash group id
     * @param instrumentId the instrument id
     * @param startBlock the starting block
     * @param duration the duration of the swap
     * @return (asset, index of asset)
     */
    function searchAccountAsset(
        address account,
        bytes1 swapType,
        uint8 futureCashGroupId,
        uint16 instrumentId,
        uint32 startBlock,
        uint32 duration
    ) public override view returns (Common.Asset memory, uint256) {
        Common.Asset[] storage portfolio = _accountAssets[account];
        (Common.Asset memory asset, uint256 index, /* bool */) = _searchAsset(
            portfolio,
            swapType,
            futureCashGroupId,
            instrumentId,
            startBlock,
            duration,
            false
        );

        return (asset, index);
    }

    /**
     * @notice Stateful version of free collateral, first settles all assets in the account before returning
     * the free collateral parameters. Generally, external developers should not need to call this function. It is used
     * internally to both check free collateral and ensure that the portfolio does not have any matured assets.
     * Call `freeCollateralView` if you require a view function.
     * @param account address of account to get free collateral for
     * @return (net free collateral position, an array of the currency requirements)
     */
    function freeCollateral(address account) public override returns (int256, uint128[] memory) {
        // This will emit an event, which is the correct action here.
        settleAccount(account);

        return freeCollateralView(account);
    }

    /**
     * @notice Stateful version of free collateral that does not emit a SettleAccount event, used during
     * liquidation to ensure that off chain syncing with the graph protocol does not have race conditions
     * due to two events proclaiming changes to an account.
     * @dev skip
     * @param account address of account to get free collateral for
     * @return (net free collateral position, an array of the currency requirements)
     */
    function freeCollateralNoEmit(address account) public override returns (int256, uint128[] memory) {
        require(calledByEscrow(), $$(ErrorCode(UNAUTHORIZED_CALLER)));
        // This will emit an event, which is the correct action here.
        _settleAccount(account);

        return freeCollateralView(account);
    }

    /**
     * @notice Returns the free collateral balance for an account as a view functon.
     * @dev - INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0
     * @param account account in question
     * @return (net free collateral position, an array of the currency requirements)
     */
    function freeCollateralView(address account) public override view returns (int256, uint128[] memory) {
        Common.Asset[] memory portfolio = _accountAssets[account];
        // This is the net balance after cash of each currency
        Common.AccountBalance[] memory balances = Escrow().getNetBalances(account);

        if (portfolio.length > 0) {
            // This returns the net requirement in each currency held by the portfolio.
            Common.Requirement[] memory requirements = RiskFramework().getRequirement(portfolio);

            // Net out the cash that and requirements provided by the risk framework.
            for (uint256 i; i < requirements.length; i++) {
                uint256 currency = uint256(requirements[i].currency);
                // This new cash balance represents any net collateral position after taking the portfolio
                // into account.
                balances[currency].netBalance = balances[currency].netBalance
                    .add(requirements[i].npv)
                    .sub(requirements[i].requirement);
            }
        }

        // We do this in a separate loop in case the portfolio is empty and the account just holds
        // a negative cash balance. We still need to ensure that it is collateralized.
        uint128[] memory currencyRequirements = new uint128[](balances.length);
        for (uint256 i; i < balances.length; i++) {
            if (balances[i].netBalance < 0) {
                currencyRequirements[i] = uint128(balances[i].netBalance.neg());
            } else if (balances[i].isDepositCurrency) {
                currencyRequirements[i] = uint128(balances[i].netBalance);
            }
        }

        // Collateral requirements are denominated in ETH and positive.
        uint128[] memory ethBalances = Escrow().convertBalancesToETH(currencyRequirements);

        // Sum up the required balances in ETH and then net it out with the balance that
        // the account holds
        int256 fc;
        for (uint256 i; i < balances.length; i++) {
            if (balances[i].isDepositCurrency) {
                fc = fc.add(ethBalances[i]);
                currencyRequirements[i] = 0;
            } else {
                fc = fc.sub(ethBalances[i]);
            }
        }

        return (fc, currencyRequirements);
    }

    /***** Public Authenticated Methods *****/

    /**
     * @notice Updates the portfolio of an account with a asset, merging it into the rest of the
     * portfolio if necessary.
     * @dev skip
     * @param account to insert the asset to
     * @param asset asset to insert into the account
     */
    function upsertAccountAsset(address account, Common.Asset memory asset) public override {
        // Only the future cash market can insert assets into a portfolio
        address futureCashMarket = futureCashGroups[asset.futureCashGroupId].futureCashMarket;
        require(msg.sender == futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Asset[] storage portfolio = _accountAssets[account];
        _upsertAsset(portfolio, asset);
        (int256 fc, /* uint128[] memory */) = freeCollateral(account);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
    }

    /**
     * @notice Updates the portfolio of an account with a batch of assets, merging it into the rest of the
     * portfolio if necessary.
     * @dev skip
     * @param account to insert the assets into
     * @param assets array of assets to insert into the account
     */
    function upsertAccountAssetBatch(
        address account,
        Common.Asset[] memory assets
    ) public override {
        if (assets.length == 0) {
            return;
        }

        // Here we check that all the future cash group ids are the same if the liquidation auction
        // is not calling this function. If this is not the case then we have an issue. Cash markets
        // should only ever call this function with the same future cash group id for all the assets
        // they submit.
        uint16 id = assets[0].futureCashGroupId;
        for (uint256 i = 1; i < assets.length; i++) {
            require(assets[i].futureCashGroupId == id, $$(ErrorCode(UNAUTHORIZED_CALLER)));
        }

        address futureCashMarket = futureCashGroups[assets[0].futureCashGroupId].futureCashMarket;
        require(msg.sender == futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Asset[] storage portfolio = _accountAssets[account];
        for (uint256 i; i < assets.length; i++) {
            _upsertAsset(portfolio, assets[i]);
        }

        (int256 fc, /* uint128[] memory */) = freeCollateral(account);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
    }

    /**
     * @notice Transfers a asset from one account to another.
     * @dev skip
     * @param from account to transfer from
     * @param to account to transfer to
     * @param swapType the type of swap to search for
     * @param futureCashGroupId the future cash group id
     * @param instrumentId the instrument id
     * @param startBlock the starting block
     * @param duration the duration of the swap
     * @param value the amount of notional transfer between accounts
     */
    function transferAccountAsset(
        address from,
        address to,
        bytes1 swapType,
        uint8 futureCashGroupId,
        uint16 instrumentId,
        uint32 startBlock,
        uint32 duration,
        uint128 value
    ) public override {
        // Can only be called by ERC1155 token to transfer assets between accounts.
        require(calledByERC1155(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Asset[] storage fromPortfolio = _accountAssets[from];
        (Common.Asset storage asset, uint256 index, /* bool */) = _searchAsset(
            fromPortfolio,
            swapType,
            futureCashGroupId,
            instrumentId,
            startBlock,
            duration,
            false
        );
        _reduceAsset(fromPortfolio, asset, index, value);

        Common.Asset[] storage toPortfolio = _accountAssets[to];
        _upsertAsset(
            toPortfolio,
            Common.Asset(futureCashGroupId, instrumentId, startBlock, duration, swapType, asset.rate, value)
        );

        // All transfers of assets must pass a free collateral check.
        (int256 fc, /* uint128[] memory */) = freeCollateral(from);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        (fc, /* uint128[] memory */) = freeCollateral(to);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
    }

    /**
     * @notice Settles all matured cash assets and liquidity tokens in a user's portfolio. This method is
     * unauthenticated, anyone may settle the assets in any account. This is required for accounts that
     * have negative cash and counterparties need to settle against them. Generally, external developers
     * should not need to call this function. We ensure that accounts are settled on every free collateral
     * check, cash settlement, and liquidation.
     * @param account the account referenced
     */
    function settleAccount(address account) public override {
        bool didSettle = _settleAccount(account);

        if (didSettle) {
            emit SettleAccount(account);
        }
    }

    /**
     * @notice Settle a batch of accounts. See note for `settleAccount`, external developers should not need
     * to call this function.
     * @param accounts an array of accounts to settle
     */
    function settleAccountBatch(address[] calldata accounts) external override {
        for (uint256 i; i < accounts.length; i++) {
            _settleAccount(accounts[i]);
        }

        // We do not want to emit when this is called by escrow during settle cash.
        if (!calledByEscrow()) {
            emit SettleAccountBatch(accounts);
        }
    }

    /**
     * @notice Settles all matured cash assets and liquidity tokens in a user's portfolio. This method is
     * unauthenticated, anyone may settle the assets in any account. This is required for accounts that
     * have negative cash and counterparties need to settle against them.
     * @param account the account referenced
     * @return true if the account had any assets that were settled, used to determine if we emit
     * an event or not
     */
    function _settleAccount(address account) internal returns (bool) {
        bool didSettle = false;
        Common.Asset[] storage portfolio = _accountAssets[account];
        uint32 blockNum = uint32(block.number);

        // This is only used when merging the account's portfolio for updating cash balances in escrow. We
        // keep this here so that we can do a single function call to settle all the cash in Escrow.
        int256[] memory settledCash = new int256[](uint256(G_NUM_CURRENCIES + 1));

        // Loop through the portfolio and find the assets that have matured.
        for (uint256 i; i < portfolio.length; i++) {
            if ((portfolio[i].startBlock + portfolio[i].duration) <= blockNum) {
                // Here we are dealing with a matured asset. We get the appropriate currency for
                // the instrument. We may want to cache this somehow, but in all likelihood there
                // will not be multiple matured assets in the same future cash group.
                uint16 currency = futureCashGroups[portfolio[i].futureCashGroupId].currency;

                if (Common.isCashPayer(portfolio[i].swapType)) {
                    // If the asset is a payer, we subtract from the cash balance
                    settledCash[currency] = settledCash[currency].sub(portfolio[i].notional);
                } else if (Common.isCashReceiver(portfolio[i].swapType)) {
                    // If the asset is a receiver, we add to the cash balance
                    settledCash[currency] = settledCash[currency].add(portfolio[i].notional);
                } else if (Common.isLiquidityToken(portfolio[i].swapType)) {
                    // Settling liquidity tokens is a bit more involved since we need to remove
                    // money from the collateral pools. This function returns the amount of future cash
                    // the liquidity token has a claim to.
                    address futureCashMarket = futureCashGroups[portfolio[i].futureCashGroupId].futureCashMarket;
                    // This function call will transfer the collateral claim back to the Escrow account.
                    uint128 futureCashAmount = FutureCash(futureCashMarket).settleLiquidityToken(
                        account,
                        portfolio[i].notional,
                        portfolio[i].startBlock + portfolio[i].duration
                    );
                    settledCash[currency] = settledCash[currency].add(futureCashAmount);
                } else {
                    revert($$(ErrorCode(INVALID_SWAP)));
                }

                // Remove asset from the portfolio
                _removeAsset(portfolio, i);
                // The portfolio has gotten smaller, so we need to go back to account for the removed asset.
                i--;
                didSettle = true;
            }
        }

        // We call the escrow contract to update the account's cash balances.
        if (didSettle) {
            Escrow().portfolioSettleCash(account, settledCash);
        }

        return didSettle;
    }

    /***** Public Authenticated Methods *****/

    /***** Liquidation Methods *****/

    /**
     * @notice Looks for ways to take cash from the portfolio and return it to the escrow contract during
     * cash settlement.
     * @dev skip
     * @param account the account to extract cash from
     * @param currency the currency that the token should be denominated in
     * @param amount the amount of collateral to extract from the portfolio
     * @return returns the amount of remaining collateral value (if any) that the function was unable
     *  to extract from the portfolio
     */
    function raiseCollateralViaLiquidityToken(
        address account,
        uint16 currency,
        uint128 amount
    ) public override returns (uint128) {
        return _tradePortfolio(account, currency, amount, Common.getLiquidityToken());
    }

    /**
     * @notice Looks for ways to take cash from the portfolio and return it to the escrow contract during
     * cash settlement.
     * @dev skip
     * @param account the account to extract cash from
     * @param currency the currency that the token should be denominated in
     * @param amount the amount of collateral to extract from the portfolio
     * @return returns the amount of remaining collateral value (if any) that the function was unable
     *  to extract from the portfolio
     */
    function raiseCollateralViaCashReceiver(
        address account,
        uint16 currency,
        uint128 amount
    ) public override returns (uint128) {
        return _tradePortfolio(account, currency, amount, Common.getCashReceiver());
    }

    /**
     * @notice Takes some amount of collateral and uses it to pay of obligations in the portfolio.
     * @dev skip
     * @param account the account that holds the obligations
     * @param currency the currency that the assets should be denominated in
     * @param amount the amount of current cash available to pay off obligations
     * @return returns the excess amount of collateral after obligations have been closed
     */
    function repayCashPayer(
        address account,
        uint16 currency,
        uint128 amount
    ) public override returns (uint128) {
        return _tradePortfolio(account, currency, amount, Common.getCashPayer());
    }

    /**
     * @notice A generic, internal function that trades positions within a portfolio.
     * @param account account that holds the portfolio to trade
     * @param currency the currency that the trades should be denominated in
     * @param amount of collateral available
     * @param tradeType the swapType to trade in the portfolio
     */
    function _tradePortfolio(
        address account,
        uint16 currency,
        uint128 amount,
        bytes1 tradeType
    ) internal returns (uint128) {
        // Only Escrow can execute actions to trade the portfolio
        require(calledByEscrow(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        // Sorting the portfolio ensures that as we iterate through it we see each future cash group
        // in batches. However, this means that we won't be able to track the indexes to remove correctly.
        Common.Asset[] memory portfolio = Common._sortPortfolio(_accountAssets[account]);
        if (portfolio.length == 0) return amount;

        TradePortfolioState memory state = TradePortfolioState(
            uint128(amount),
            0,
            0,
            // At most we will add twice as many assets as the portfolio (this would be for liquidity token)
            // changes where we update both liquidity tokens as well as cash obligations.
            new Common.Asset[](portfolio.length * 2)
        );

        // We initialize these future cash groups here knowing that there is at least one asset in the portfolio
        uint8 futureCashGroupId = portfolio[0].futureCashGroupId;
        Common.FutureCashGroup memory fg = futureCashGroups[futureCashGroupId];

        // Iterate over the portfolio and trade as required.
        for (uint256 i; i < portfolio.length; i++) {
            if (futureCashGroupId != portfolio[i].futureCashGroupId) {
                // Here the future cash group has changed and therefore the future cash market has also
                // changed. We need to unlock collateral from the previous future cash market.
                Escrow().unlockCollateral(currency, fg.futureCashMarket, state.unlockedCollateral);
                // Reset this counter for the next group
                state.unlockedCollateral = 0;

                // Fetch the new future cash group.
                futureCashGroupId = portfolio[i].futureCashGroupId;
                fg = futureCashGroups[futureCashGroupId];
            }

            if (fg.currency != currency) continue;
            if (portfolio[i].swapType != tradeType) continue;

            if (Common.isCashPayer(portfolio[i].swapType)) {
                _tradeCashPayer(portfolio[i], fg.futureCashMarket, state);
            } else if (Common.isLiquidityToken(portfolio[i].swapType)) {
                _tradeLiquidityToken(portfolio[i], fg.futureCashMarket, state);
            } else if (Common.isCashReceiver(portfolio[i].swapType)) {
                _tradeCashReceiver(account, portfolio[i], fg.futureCashMarket, state);
            }

            // No more collateral left so we break out of the loop
            if (state.amountRemaining == 0) {
                break;
            }
        }

        if (state.unlockedCollateral != 0) {
            // Transfer cash from the last future cash group in the previous loop
            Escrow().unlockCollateral(currency, fg.futureCashMarket, state.unlockedCollateral);
        }

        Common.Asset[] storage accountStorage = _accountAssets[account];
        for (uint256 i; i < state.indexCount; i++) {
            // This bypasses the free collateral check which is required here.
            _upsertAsset(accountStorage, state.portfolioChanges[i]);
        }

        return state.amountRemaining;
    }

    /**
     * @notice Extracts collateral from liquidity tokens.
     * @param asset the liquidity token to extract cash from
     * @param futureCashMarket the address of the future cash market
     * @param state state of the portfolio trade operation
     */
    function _tradeLiquidityToken(
        Common.Asset memory asset,
        address futureCashMarket,
        TradePortfolioState memory state
    ) internal  {
        (uint128 collateral, uint128 futureCash, uint128 tokens) = FutureCash(futureCashMarket)
            .tradeLiquidityToken(
                state.amountRemaining,
                asset.notional,
                asset.startBlock + asset.duration
            );
        state.amountRemaining = state.amountRemaining.sub(collateral);

        // This amount of collateral has been removed from the market
        state.unlockedCollateral = state.unlockedCollateral.add(collateral);

        // This is a CASH_RECEIVER that is credited back as a result of settling the liquidity token.
        state.portfolioChanges[state.indexCount] = Common.Asset(
            asset.futureCashGroupId,
            asset.instrumentId,
            asset.startBlock,
            asset.duration,
            Common.getCashReceiver(),
            asset.rate,
            futureCash
        );
        state.indexCount++;

        // This marks the removal of an amount of liquidity tokens
        state.portfolioChanges[state.indexCount] = Common.Asset(
            asset.futureCashGroupId,
            asset.instrumentId,
            asset.startBlock,
            asset.duration,
            Common.makeCounterparty(Common.getLiquidityToken()),
            asset.rate,
            tokens
        );
        state.indexCount++;
    }

    /**
     * @notice Sells future cash in order to raise collateral
     * @param account the account that holds the future cash
     * @param asset the future cash token to extract cash from
     * @param futureCashMarket the address of the future cash market
     * @param state state of the portfolio trade operation
     */
    function _tradeCashReceiver(
        address account,
        Common.Asset memory asset,
        address futureCashMarket,
        TradePortfolioState memory state
    ) internal {
        // This will sell off the entire amount of future cash and return collateral
        uint128 collateral = FutureCash(futureCashMarket).tradeCashReceiver(
            account,
            state.amountRemaining,
            asset.notional,
            asset.startBlock + asset.duration
        );

        // Trade failed, do not update any state variables
        if (collateral == 0) return;

        // This amount of collateral has been removed from the market
        state.unlockedCollateral = state.unlockedCollateral.add(collateral);
        state.amountRemaining = state.amountRemaining.sub(collateral);

        // This is a CASH_PAYER that will offset the future cash in the portfolio, it will
        // always be the entire future cash amount.
        state.portfolioChanges[state.indexCount] = Common.Asset(
            asset.futureCashGroupId,
            asset.instrumentId,
            asset.startBlock,
            asset.duration,
            Common.getCashPayer(),
            asset.rate,
            asset.notional
        );
        state.indexCount++;
    }

    /**
     * @notice Purchases future cash to offset obligations
     * @param asset the future cash token to pay off
     * @param futureCashMarket the address of the future cash market
     * @param state state of the portfolio trade operation
     */
    function _tradeCashPayer(
        Common.Asset memory asset,
        address futureCashMarket,
        TradePortfolioState memory state
    ) internal returns (uint256, uint128, int256) {
        // This will purchase future cash in order to close out the obligations
        (uint128 repayCost, uint128 futureCash) = FutureCash(futureCashMarket).tradeCashPayer(
            state.amountRemaining,
            asset.notional,
            asset.startBlock + asset.duration
        );

        // This amount of collateral has to be deposited in the market
        state.unlockedCollateral = state.unlockedCollateral.sub(repayCost);
        state.amountRemaining = state.amountRemaining.sub(repayCost);

        // This is a CASH_RECEIVER that will offset the obligation in the portfolio
        state.portfolioChanges[state.indexCount] = Common.Asset(
            asset.futureCashGroupId,
            asset.instrumentId,
            asset.startBlock,
            asset.duration,
            Common.getCashReceiver(),
            asset.rate,
            futureCash
        );
        state.indexCount++;
    }

    /***** Liquidation Methods *****/

    /***** Internal Portfolio Methods *****/

    /**
     * @notice Returns the offset for a specific asset in an array of assets given a storage
     * pointer to a asset array. The parameters of this function define a unique id of
     * the asset.
     * @param portfolio storage pointer to the list of assets
     * @param swapType the type of swap to search for
     * @param futureCashGroupId the future cash group id
     * @param instrumentId the instrument id
     * @param startBlock the starting block
     * @param duration the duration of the swap
     * @param findCounterparty find the counterparty of the asset
     *
     * @return (storage pointer to the asset, index of asset, is counterparty asset or not)
     */
    function _searchAsset(
        Common.Asset[] storage portfolio,
        bytes1 swapType,
        uint8 futureCashGroupId,
        uint16 instrumentId,
        uint32 startBlock,
        uint32 duration,
        bool findCounterparty
    ) internal view returns (Common.Asset storage, uint256, bool) {
        if (portfolio.length == 0) {
            return (NULL_ASSET, portfolio.length, false);
        }

        for (uint256 i; i < portfolio.length; i++) {
            Common.Asset storage t = portfolio[i];
            if (t.futureCashGroupId != futureCashGroupId) continue;
            if (t.instrumentId != instrumentId) continue;
            if (t.startBlock != startBlock) continue;
            if (t.duration != duration) continue;

            if (t.swapType == swapType) {
                return (t, i, false);
            } else if (findCounterparty && t.swapType == Common.makeCounterparty(swapType)) {
                return (t, i, true);
            }
        }

        return (NULL_ASSET, portfolio.length, false);
    }

    /**
     * @notice Checks for the existence of a matching asset and then chooses update or append
     * as appropriate.
     * @param portfolio a list of assets
     * @param asset the new asset to add
     */
    function _upsertAsset(Common.Asset[] storage portfolio, Common.Asset memory asset) internal {
        (Common.Asset storage matchedAsset, uint256 index, bool isCounterparty) = _searchAsset(
            portfolio,
            asset.swapType,
            asset.futureCashGroupId,
            asset.instrumentId,
            asset.startBlock,
            asset.duration,
            true
        );

        if (matchedAsset.swapType == 0x00) {
            if (Common.isLiquidityToken(asset.swapType) && Common.isPayer(asset.swapType)) {
                // You cannot have a payer liquidity token without an existing liquidity token entry in
                // your portfolio since liquidity tokens must always have a positive balance.
                revert($$(ErrorCode(INSUFFICIENT_BALANCE)));
            }

            // Append the new asset
            portfolio.push(asset);
        } else if (!isCounterparty) {
            // If the asset types match, then just aggregate the notional amounts.
            matchedAsset.notional = matchedAsset.notional.add(asset.notional);
        } else {
            if (matchedAsset.notional >= asset.notional) {
                // We have enough notional of the asset to reduce or remove the asset.
                _reduceAsset(portfolio, matchedAsset, index, asset.notional);
            } else if (Common.isLiquidityToken(asset.swapType)) {
                // Liquidity tokens cannot go below zero.
                revert($$(ErrorCode(INSUFFICIENT_BALANCE)));
            } else if (Common.isCash(asset.swapType)) {
                // Otherwise, we need to flip the sign of the swap and set the notional amount
                // to the difference.
                matchedAsset.notional = asset.notional.sub(matchedAsset.notional);
                matchedAsset.swapType = asset.swapType;
            }
        }
    }

    /**
     * @notice Reduces the notional of a asset by value, if value is equal to the total notional
     * then removes it from the portfolio.
     * @param portfolio a storage pointer to the account's assets
     * @param asset a storage pointer to the asset
     * @param index of the asset in the portfolio
     * @param value the amount of notional to reduce
     */
    function _reduceAsset(Common.Asset[] storage portfolio, Common.Asset storage asset, uint256 index, uint128 value)
        internal
    {
        require(asset.swapType != 0x00, $$(ErrorCode(INVALID_SWAP)));
        require(asset.notional >= value, $$(ErrorCode(INSUFFICIENT_BALANCE)));

        if (asset.notional == value) {
            _removeAsset(portfolio, index);
        } else {
            // We did the check above that will prevent an underflow here
            asset.notional = asset.notional - value;
        }
    }

    /**
     * @notice Removes a asset from a portfolio, used when assets are transferred by _reduceAsset
     * or when they are settled.
     * @param portfolio a storage pointer to the assets
     * @param index the index of the asset to remove
     */
    function _removeAsset(Common.Asset[] storage portfolio, uint256 index) internal {
        uint256 lastIndex = portfolio.length - 1;
        if (index != lastIndex) {
            Common.Asset memory lastAsset = portfolio[lastIndex];
            portfolio[index] = lastAsset;
        }
        portfolio.pop();
    }
}
