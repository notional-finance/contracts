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
     * @notice Emitted when max assets is set
     * @param maxAssets the max assets a portfolio can hold
     */
    event SetMaxAssets(uint256 maxAssets);

    /**
     * @dev skip
     * @param directory holds contract addresses for dependencies
     * @param numCurrencies initializes the number of currencies listed on the escrow contract
     * @param maxAssets max assets that a portfolio can hold
     */
    function initialize(address directory, uint16 numCurrencies, uint256 maxAssets) external initializer {
        Governed.initialize(directory);

        // We must initialize this here because it cannot be a constant.
        NULL_ASSET = Common.Asset(0, 0, 0, 0, 0, 0);
        G_NUM_CURRENCIES = numCurrencies;
        G_MAX_ASSETS = maxAssets;

        emit SetMaxAssets(maxAssets);
    }

    /****** Governance Parameters ******/

    /**
     * @dev skip
     * @param numCurrencies the total number of currencies set by escrow
     */
    function setNumCurrencies(uint16 numCurrencies) external override {
        require(calledByEscrow(), $$(ErrorCode(UNAUTHORIZED_CALLER)));
        G_NUM_CURRENCIES = numCurrencies;
    }

    /**
     * @notice Set the max assets that a portfolio can hold. The default will be initialized to something
     * like 10 assets, but this will be increased as new markets are created.
     * @dev governance
     * @param maxAssets new max asset number
     */
    function setMaxAssets(uint256 maxAssets) external onlyOwner {
        G_MAX_ASSETS = maxAssets;

        emit SetMaxAssets(maxAssets);
    }

    /**
     * @notice An future cash group defines a collection of similar future cashs where the risk ladders can be netted
     * against each other. The identifier is only 1 byte so we can only have 255 future cash groups, 0 is unused.
     * @dev governance
     * @param numPeriods the total number of periods
     * @param periodSize the baseline period length (in seconds) for periodic swaps in this future cash.
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
        require(Escrow().isValidCurrency(currency), $$(ErrorCode(INVALID_CURRENCY)));

        currentFutureCashGroupId++;
        futureCashGroups[currentFutureCashGroupId] = Common.FutureCashGroup(
            numPeriods,
            periodSize,
            precision,
            futureCashMarket,
            currency,
            riskFormula
        );

        if (futureCashMarket == address(0)) {
            // If futureCashMarket is set to address 0, then it is an idiosyncratic future cash group that does not have
            // an AMM that will trade it. It can only be traded off chain and created via mintFutureCashPair
            require(numPeriods == 1);
        } else if (futureCashMarket != address(0)) {
            // The future cash is set to 0 for discount rate oracles and there is no max rate as well.
            IRateOracle(futureCashMarket).setParameters(currentFutureCashGroupId, 0, precision, periodSize, numPeriods, 0);
        }

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
        require(Escrow().isValidCurrency(currency), $$(ErrorCode(INVALID_CURRENCY)));

        Common.FutureCashGroup storage i = futureCashGroups[futureCashGroupId];
        if (i.numPeriods != numPeriods) i.numPeriods = numPeriods;
        if (i.periodSize != periodSize) i.periodSize = periodSize;
        if (i.precision != precision) i.precision = precision;
        if (i.currency != currency) i.currency = currency;
        if (i.futureCashMarket != futureCashMarket) i.futureCashMarket = futureCashMarket;
        if (i.riskFormula != riskFormula) i.riskFormula = riskFormula;

        // The future cash is set to 0 for discount rate oracles and there is no max rate as well.
        IRateOracle(futureCashMarket).setParameters(futureCashGroupId, 0, precision, periodSize, numPeriods, 0);

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
    function getFutureCashGroup(uint8 futureCashGroupId) public override view returns (Common.FutureCashGroup memory) {
        return futureCashGroups[futureCashGroupId];
    }

    /**
     * @notice Returns a batch of future cash groups
     * @param groupIds array of future cash group ids to retrieve
     * @return an array of future cash group objects
     */
    function getFutureCashGroups(uint8[] memory groupIds) public override view returns (Common.FutureCashGroup[] memory) {
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
     * @param maturity the maturity timestamp of the asset
     * @return (asset, index of asset)
     */
    function searchAccountAsset(
        address account,
        bytes1 swapType,
        uint8 futureCashGroupId,
        uint16 instrumentId,
        uint32 maturity
    ) public override view returns (Common.Asset memory, uint256) {
        Common.Asset[] storage portfolio = _accountAssets[account];
        (
            Common.Asset memory asset,
            uint256 index, /* bool */

        ) = _searchAsset(portfolio, swapType, futureCashGroupId, instrumentId, maturity, false);

        return (asset, index);
    }

    /**
     * @notice Stateful version of free collateral, first settles all assets in the account before returning
     * the free collateral parameters. Generally, external developers should not need to call this function. It is used
     * internally to both check free collateral and ensure that the portfolio does not have any matured assets.
     * Call `freeCollateralView` if you require a view function.
     * @param account address of account to get free collateral for
     * @return (net free collateral position, an array of the net currency available)
     */
    function freeCollateral(address account) public override returns (int256, int256[] memory, int256[] memory) {
        // This will emit an event, which is the correct action here.
        settleMaturedAssets(account);

        return freeCollateralView(account);
    }

    /**
     * @notice Stateful version of free collateral that does not emit a SettleAccount event, used during
     * liquidation to ensure that off chain syncing with the graph protocol does not have race conditions
     * due to two events proclaiming changes to an account.
     * @dev skip
     * @param account address of account to get free collateral for
     * @return (net free collateral position, an array of the net currency available)
     */
    function freeCollateralNoEmit(address account) public override returns (int256, int256[] memory, int256[] memory) {
        require(calledByEscrow(), $$(ErrorCode(UNAUTHORIZED_CALLER)));
        // This will emit an event, which is the correct action here.
        _settleMaturedAssets(account);

        return freeCollateralView(account);
    }

    /**
     * @notice Returns the free collateral balance for an account as a view functon.
     * @dev - INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0
     * @param account account in question
     * @return (net free collateral position, an array of the net currency available)
     */
    function freeCollateralView(address account) public override view returns (int256, int256[] memory, int256[] memory) {
        Common.Asset[] memory portfolio = _accountAssets[account];
        int256[] memory balances = Escrow().getBalances(account);
        int256[] memory npv = new int256[](balances.length);

        if (portfolio.length > 0) {
            // This returns the net requirement in each currency held by the portfolio.
            Common.Requirement[] memory requirements = RiskFramework().getRequirement(portfolio);

            for (uint256 i; i < requirements.length; i++) {
                uint256 currency = uint256(requirements[i].currency);
                npv[currency] = npv[currency].add(requirements[i].npv);
                balances[currency] = balances[currency].add(requirements[i].npv).sub(requirements[i].requirement);
            }
        }

        // Collateral requirements are denominated in ETH and positive.
        int256[] memory ethBalances = Escrow().convertBalancesToETH(balances);

        // Sum up the required balances in ETH
        int256 fc;
        for (uint256 i; i < balances.length; i++) {
            fc = fc.add(ethBalances[i]);
        }

        return (fc, balances, npv);
    }

    /***** Public Authenticated Methods *****/

    /**
     * @notice Updates the portfolio of an account with a asset, merging it into the rest of the
     * portfolio if necessary.
     * @dev skip
     * @param account to insert the asset to
     * @param asset asset to insert into the account
     * @param checkFreeCollateral allows free collateral check to be skipped (BE CAREFUL WITH THIS!)
     */
    function upsertAccountAsset(
        address account,
        Common.Asset calldata asset,
        bool checkFreeCollateral
    ) external override {
        // Only the future cash market can insert assets into a portfolio
        address futureCashMarket = futureCashGroups[asset.futureCashGroupId].futureCashMarket;
        require(msg.sender == futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Asset[] storage portfolio = _accountAssets[account];
        _upsertAsset(portfolio, asset);

        if (checkFreeCollateral) {
            (
                int256 fc, /* int256[] memory */, /* int256[] memory */

            ) = freeCollateral(account);
            require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
        }
    }

    /**
     * @notice Updates the portfolio of an account with a batch of assets, merging it into the rest of the
     * portfolio if necessary.
     * @dev skip
     * @param account to insert the assets into
     * @param assets array of assets to insert into the account
     * @param checkFreeCollateral allows free collateral check to be skipped (BE CAREFUL WITH THIS!)
     */
    function upsertAccountAssetBatch(
        address account,
        Common.Asset[] calldata assets,
        bool checkFreeCollateral
    ) external override {
        if (assets.length == 0) {
            return;
        }

        // Here we check that all the future cash group ids are the same if the liquidation auction
        // is not calling this function. If this is not the case then we have an issue. Cash markets
        // should only ever call this function with the same future cash group id for all the assets
        // they submit.
        uint16 id = assets[0].futureCashGroupId;
        for (uint256 i = 1; i < assets.length; i++) {
            require(assets[i].futureCashGroupId == id, $$(ErrorCode(INVALID_ASSET_BATCH)));
        }

        address futureCashMarket = futureCashGroups[assets[0].futureCashGroupId].futureCashMarket;
        require(msg.sender == futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Asset[] storage portfolio = _accountAssets[account];
        for (uint256 i; i < assets.length; i++) {
            _upsertAsset(portfolio, assets[i]);
        }

        if (checkFreeCollateral) {
            (
                int256 fc, /* int256[] memory */, /* int256[] memory */
            ) = freeCollateral(account);
            require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
        }
    }

    /**
     * @notice Transfers a asset from one account to another.
     * @dev skip
     * @param from account to transfer from
     * @param to account to transfer to
     * @param swapType the type of swap to search for
     * @param futureCashGroupId the future cash group id
     * @param instrumentId the instrument id
     * @param maturity the maturity of the asset
     * @param value the amount of notional transfer between accounts
     */
    function transferAccountAsset(
        address from,
        address to,
        bytes1 swapType,
        uint8 futureCashGroupId,
        uint16 instrumentId,
        uint32 maturity,
        uint128 value
    ) external override {
        // Can only be called by ERC1155 token to transfer assets between accounts.
        require(calledByERC1155Token(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Asset[] storage fromPortfolio = _accountAssets[from];
        (
            Common.Asset storage asset,
            uint256 index, /* bool */

        ) = _searchAsset(fromPortfolio, swapType, futureCashGroupId, instrumentId, maturity, false);
        _reduceAsset(fromPortfolio, asset, index, value);

        Common.Asset[] storage toPortfolio = _accountAssets[to];
        _upsertAsset(
            toPortfolio,
            Common.Asset(futureCashGroupId, instrumentId, maturity, swapType, asset.rate, value)
        );

        // All transfers of assets must pass a free collateral check.
        (
            int256 fc, /* int256[] memory */, /* int256[] memory */
        ) = freeCollateral(from);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        (
            fc, /* int256[] memory */, /* int256[] memory */
        ) = freeCollateral(to);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
    }

    /**
     * @notice Used by ERC1155 token contract to create block trades for future cash pairs. Allows idiosyncratic
     * future cash when futureCashGroup is set to zero.
     * @dev skip
     */
    function mintFutureCashPair(
        address payer,
        address receiver,
        uint8 futureCashGroupId,
        uint32 maturity,
        uint128 notional
    ) external override {
        require(calledByERC1155Trade(), $$(ErrorCode(UNAUTHORIZED_CALLER)));
        require(futureCashGroupId != 0 && futureCashGroupId <= currentFutureCashGroupId, $$(ErrorCode(INVALID_FUTURE_CASH_GROUP)));

        uint32 blockTime = uint32(block.timestamp);
        require(blockTime < maturity, $$(ErrorCode(TRADE_MATURITY_ALREADY_PASSED)));

        Common.FutureCashGroup memory fcg = futureCashGroups[futureCashGroupId];

        if (fcg.futureCashMarket != address(0)) {
            // This is a future cash group that is traded on an AMM so we ensure that the maturity fits
            // the cadence.
            require(maturity % fcg.periodSize == 0, $$(ErrorCode(INVALID_SWAP)));
        }

        uint32 maxMaturity = blockTime - (blockTime % fcg.periodSize) + (fcg.periodSize * fcg.numPeriods);
        require(maturity <= maxMaturity, $$(ErrorCode(PAST_MAX_MATURITY)));

        _upsertAsset(_accountAssets[payer],
            Common.Asset(
                futureCashGroupId,
                0,
                maturity,
                Common.getCashPayer(),
                fcg.precision,
                notional
            ));

        _upsertAsset(_accountAssets[receiver],
            Common.Asset(
                futureCashGroupId,
                0,
                maturity,
                Common.getCashReceiver(),
                fcg.precision,
                notional
            ));

        (int256 fc, /* int256[] memory */, /* int256[] memory */) = freeCollateral(payer);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        // NOTE: this check is not strictly necessary
        (fc, /* int256[] memory */, /* int256[] memory */) = freeCollateral(receiver);
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
    function settleMaturedAssets(address account) public override {
        bool didSettle = _settleMaturedAssets(account);

        if (didSettle) {
            emit SettleAccount(account);
        }
    }

    /**
     * @notice Settle a batch of accounts. See note for `settleMaturedAssets`, external developers should not need
     * to call this function.
     * @param accounts an array of accounts to settle
     */
    function settleMaturedAssetsBatch(address[] calldata accounts) external override {
        for (uint256 i; i < accounts.length; i++) {
            _settleMaturedAssets(accounts[i]);
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
    function _settleMaturedAssets(address account) internal returns (bool) {
        bool didSettle = false;
        Common.Asset[] storage portfolio = _accountAssets[account];
        uint32 blockTime = uint32(block.timestamp);

        // This is only used when merging the account's portfolio for updating cash balances in escrow. We
        // keep this here so that we can do a single function call to settle all the cash in Escrow.
        int256[] memory settledCash = new int256[](uint256(G_NUM_CURRENCIES + 1));

        // Loop through the portfolio and find the assets that have matured.
        for (uint256 i; i < portfolio.length; i++) {
            if (portfolio[i].maturity <= blockTime) {
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
                        portfolio[i].maturity
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
    ) external override returns (uint128) {
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
    ) external override returns (uint128) {
        return _tradePortfolio(account, currency, amount, Common.getCashReceiver());
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
            amount,
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

            // This is an idiosyncratic future cash market and we cannot trade out of it
            if (fg.futureCashMarket == address(0)) continue;
            if (fg.currency != currency) continue;
            if (portfolio[i].swapType != tradeType) continue;

            if (Common.isCashPayer(portfolio[i].swapType)) {
                revert($$(ErrorCode(INVALID_SWAP)));
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
    ) internal {
        (uint128 collateral, uint128 futureCash, uint128 tokens) = FutureCash(futureCashMarket).tradeLiquidityToken(
            state.amountRemaining,
            asset.notional,
            asset.maturity
        );
        state.amountRemaining = state.amountRemaining.sub(collateral);

        // This amount of collateral has been removed from the market
        state.unlockedCollateral = state.unlockedCollateral.add(collateral);

        // This is a CASH_RECEIVER that is credited back as a result of settling the liquidity token.
        state.portfolioChanges[state.indexCount] = Common.Asset(
            asset.futureCashGroupId,
            asset.instrumentId,
            asset.maturity,
            Common.getCashReceiver(),
            asset.rate,
            futureCash
        );
        state.indexCount++;

        // This marks the removal of an amount of liquidity tokens
        state.portfolioChanges[state.indexCount] = Common.Asset(
            asset.futureCashGroupId,
            asset.instrumentId,
            asset.maturity,
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
            asset.maturity
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
            asset.maturity,
            Common.getCashPayer(),
            asset.rate,
            asset.notional
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
     * @param maturity maturity of the asset
     * @param findCounterparty find the counterparty of the asset
     *
     * @return (storage pointer to the asset, index of asset, is counterparty asset or not)
     */
    function _searchAsset(
        Common.Asset[] storage portfolio,
        bytes1 swapType,
        uint8 futureCashGroupId,
        uint16 instrumentId,
        uint32 maturity,
        bool findCounterparty
    )
        internal
        view
        returns (
            Common.Asset storage,
            uint256,
            bool
        )
    {
        if (portfolio.length == 0) {
            return (NULL_ASSET, portfolio.length, false);
        }

        for (uint256 i; i < portfolio.length; i++) {
            Common.Asset storage t = portfolio[i];
            if (t.futureCashGroupId != futureCashGroupId) continue;
            if (t.instrumentId != instrumentId) continue;
            if (t.maturity != maturity) continue;

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
            asset.maturity,
            true
        );

        if (matchedAsset.swapType == 0x00) {
            // This is the NULL_ASSET so we append. This restriction should never work against extracting
            // cash or liquidation because in those cases we will always be trading offsetting positions
            // rather than adding new positions.
            require(portfolio.length <= G_MAX_ASSETS, $$(ErrorCode(PORTFOLIO_TOO_LARGE)));

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
    function _reduceAsset(
        Common.Asset[] storage portfolio,
        Common.Asset storage asset,
        uint256 index,
        uint128 value
    ) internal {
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
