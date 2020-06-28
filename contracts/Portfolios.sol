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
 * @notice Holds all the methods for managing an account's portfolio of trades
 */
contract Portfolios is PortfoliosStorage, IPortfoliosCallable, Governed {
    using SafeMath for uint256;
    using SafeInt256 for int256;
    using SafeUInt128 for uint128;

    struct TradePortfolioState {
        uint128 amountRemaining;
        uint256 indexCount;
        int256 unlockedCollateral;
        Common.Trade[] portfolioChanges;
    }

    event SettleAccount(address operator, address account);
    event SettleAccountBatch(address operator, address[] account);
    event NewInstrumentGroup(uint8 indexed instrumentGroupId);
    event UpdateInstrumentGroup(uint8 indexed instrumentGroupId);

    function initialize(address directory, uint256 maxTrades) public initializer {
        Governed.initialize(directory);
        G_MAX_TRADES = maxTrades;

        // We must initialize this here because it cannot be a constant.
        NULL_TRADE = Common.Trade(0, 0, 0, 0, 0, 0, 0);
    }

    /****** Governance Parameters ******/

    function setNumCurrencies(uint16 numCurrencies) public override {
        require(calledByEscrow(), $$(ErrorCode(UNAUTHORIZED_CALLER)));
        G_NUM_CURRENCIES = numCurrencies;
    }

    function setMaxTrades(uint256 maxTrades) public onlyOwner {
        G_MAX_TRADES = maxTrades;
    }

    /**
     * @notice An instrument group defines a collection of similar instruments where the risk ladders can be netted
     * against each other. The identifier is only 1 byte so we can only have 255 instrument groups, 0 is unused.
     * The periods are defined in the instrument group.
     *
     * @param numPeriods the total number of periods
     * @param periodSize the baseline period length (in blocks) for periodic swaps in this instrument.
     * @param precision the discount rate precision
     * @param currency the token address of the currenty this instrument settles in
     * @param futureCashMarket the rate oracle that defines the discount rate
     */
    function createInstrumentGroup(
        uint32 numPeriods,
        uint32 periodSize,
        uint32 precision,
        uint16 currency,
        address futureCashMarket,
        address riskFormula
    ) external onlyOwner {
        require(currentInstrumentGroupId <= MAX_INSTRUMENT_GROUPS, $$(ErrorCode(OVER_INSTRUMENT_LIMIT)));
        require(Escrow().isTradableCurrency(currency), $$(ErrorCode(INVALID_CURRENCY)));

        currentInstrumentGroupId++;
        instrumentGroups[currentInstrumentGroupId] = Common.InstrumentGroup(
            numPeriods,
            periodSize,
            precision,
            currency,
            futureCashMarket,
            riskFormula
        );

        // The instrument is set to 0 for discount rate oracles and there is no max rate as well.
        IRateOracle(futureCashMarket).setParameters(
            currentInstrumentGroupId,
            0,
            precision,
            periodSize,
            numPeriods,
            0
        );

        emit NewInstrumentGroup(currentInstrumentGroupId);
    }

    /**
     * @notice Updates instrument groups. Be very careful when calling this function! When changing periods and
     * period sizes the oracles must be updated as well. If the futureCashMarket is shared by other
     * instrument groups, their numPeriod and periodSize must be updated as well or this will result in
     * incompatibility.
     *
     * @param instrumentGroupId the group id to update
     * @param numPeriods this is safe to update as long as the discount rate oracle is not shared
     * @param periodSize this is only safe to update when there are no trades left
     * @param precision this is only safe to update when there are no trades left
     * @param currency this is safe to update if there are no trades or the new currency is equivalent
     * @param futureCashMarket this is safe to update once the oracle is established
     */
    function updateInstrumentGroup(
        uint8 instrumentGroupId,
        uint32 numPeriods,
        uint32 periodSize,
        uint32 precision,
        uint16 currency,
        address futureCashMarket,
        address riskFormula
    ) external onlyOwner {
        require(
            instrumentGroupId != 0 && instrumentGroupId <= currentInstrumentGroupId,
            $$(ErrorCode(INVALID_INSTRUMENT_GROUP))
        );
        require(Escrow().isTradableCurrency(currency), $$(ErrorCode(INVALID_CURRENCY)));

        Common.InstrumentGroup storage i = instrumentGroups[instrumentGroupId];
        if (i.numPeriods != numPeriods) i.numPeriods = numPeriods;
        if (i.periodSize != periodSize) i.periodSize = periodSize;
        if (i.precision != precision) i.precision = precision;
        if (i.currency != currency) i.currency = currency;
        if (i.futureCashMarket != futureCashMarket) i.futureCashMarket = futureCashMarket;
        if (i.riskFormula != riskFormula) i.riskFormula = riskFormula;

        // The instrument is set to 0 for discount rate oracles and there is no max rate as well.
        IRateOracle(futureCashMarket).setParameters(
            instrumentGroupId,
            0,
            precision,
            periodSize,
            numPeriods,
            0
        );

        emit UpdateInstrumentGroup(instrumentGroupId);
    }
    /****** Governance Parameters ******/

    /***** Public View Methods *****/

    /**
     * @notice Returns the trades of an account
     *
     * @param account to retrieve
     */
    function getTrades(address account) public override view returns (Common.Trade[] memory) {
        return _accountTrades[account];
    }

    /**
     * @notice Returns a particular trade via index
     *
     * @param account to retrieve
     * @param index of trade
     */
    function getTrade(address account, uint256 index) public view returns (Common.Trade memory) {
        return _accountTrades[account][index];
    }

    /**
     * @notice Returns a particular instrumentGroupId
     *
     * @param instrumentGroupId to retrieve
     */
    function getInstrumentGroup(
        uint8 instrumentGroupId
    ) public view override returns (Common.InstrumentGroup memory) {
        return instrumentGroups[instrumentGroupId];
    }

    /**
     * @notice Gets instrument groups by id
     *
     * @param groupIds array of instrument group ids to retrieve
     */
    function getInstrumentGroups(
        uint8[] memory groupIds
    ) public view override returns (Common.InstrumentGroup[] memory) {
        Common.InstrumentGroup[] memory results = new Common.InstrumentGroup[](groupIds.length);

        for (uint256 i; i < groupIds.length; i++) {
            results[i] = instrumentGroups[groupIds[i]];
        }

        return results;
    }

    /**
     * @notice Public method for searching for a trade in an account.
     *
     * @param account account to search
     * @param swapType the type of swap to search for
     * @param instrumentGroupId the instrument group id
     * @param instrumentId the instrument id
     * @param startBlock the starting block
     * @param duration the duration of the swap
     * @return (trade, index of trade)
     */
    function searchAccountTrade(
        address account,
        bytes1 swapType,
        uint8 instrumentGroupId,
        uint16 instrumentId,
        uint32 startBlock,
        uint32 duration
    ) public override view returns (Common.Trade memory, uint256) {
        Common.Trade[] storage portfolio = _accountTrades[account];
        (Common.Trade memory t, uint256 index, /* bool */) = _searchTrade(
            portfolio,
            swapType,
            instrumentGroupId,
            instrumentId,
            startBlock,
            duration,
            false
        );

        return (t, index);
    }

    /**
     * @notice Stateful version of free collateral, first settles all trades in the account before returning
     * the free collateral parameters.
     *
     * @param account to get free collateral for
     */
    function freeCollateral(address account) public override returns (int256, uint128[] memory) {
        // This will emit an event, which is the correct action here.
        settleAccount(account);

        return freeCollateralView(account);
    }

    /**
     * @notice Returns the free collateral balance for an account.
     *
     * @param account account in question
     * @return the amount of free collateral and the per currency requirement
     */
    function freeCollateralView(address account) public view returns (int256, uint128[] memory) {
        Common.Trade[] memory portfolio = _accountTrades[account];
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
     * @notice Updates the portfolio of an account with a trade, merging it into the rest of the
     * portfolio if necessary.
     *
     * @param account to insert the trade to
     * @param trade trade to insert into the account
     */
    function upsertAccountTrade(address account, Common.Trade memory trade) public override {
        // Only the future cash market can insert trades into a portfolio
        address futureCashMarket = instrumentGroups[trade.instrumentGroupId].futureCashMarket;
        require(msg.sender == futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Trade[] storage portfolio = _accountTrades[account];
        _upsertTrade(portfolio, trade);
        (int256 fc, /* uint128[] memory */) = freeCollateral(account);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
    }

    /**
     * @notice Updates the portfolio of an account with a batch of trades, merging it into the rest of the
     * portfolio if necessary.
     *
     * @param account to insert the trades into
     * @param trades array of trades to insert into the account
     */
    function upsertAccountTradeBatch(
        address account,
        Common.Trade[] memory trades
    ) public override {
        if (trades.length == 0) {
            return;
        }

        // Here we check that all the instrument group ids are the same if the liquidation auction
        // is not calling this function. If this is not the case then we have an issue. Cash markets
        // should only ever call this function with the same instrument group id for all the trades
        // they submit.
        uint16 id = trades[0].instrumentGroupId;
        for (uint256 i = 1; i < trades.length; i++) {
            require(trades[i].instrumentGroupId == id, $$(ErrorCode(UNAUTHORIZED_CALLER)));
        }

        address futureCashMarket = instrumentGroups[trades[0].instrumentGroupId].futureCashMarket;
        require(msg.sender == futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Trade[] storage portfolio = _accountTrades[account];
        for (uint256 i; i < trades.length; i++) {
            _upsertTrade(portfolio, trades[i]);
        }

        (int256 fc, /* uint128[] memory */) = freeCollateral(account);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
    }

    /**
     * @notice Transfers a trade from one account to another.
     *
     * @param from account to transfer from
     * @param to account to transfer to
     * @param swapType the type of swap to search for
     * @param instrumentGroupId the instrument group id
     * @param instrumentId the instrument id
     * @param startBlock the starting block
     * @param duration the duration of the swap
     * @param value the amount of notional transfer between accounts
     */
    function transferAccountTrade(
        address from,
        address to,
        bytes1 swapType,
        uint8 instrumentGroupId,
        uint16 instrumentId,
        uint32 startBlock,
        uint32 duration,
        uint128 value
    ) public override {
        // Can only be called by ERC1155 token to transfer trades between accounts.
        require(calledByERC1155(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Trade[] storage fromPortfolio = _accountTrades[from];
        (Common.Trade storage trade, uint256 index, /* bool */) = _searchTrade(
            fromPortfolio,
            swapType,
            instrumentGroupId,
            instrumentId,
            startBlock,
            duration,
            false
        );
        _reduceTrade(fromPortfolio, trade, index, value);

        Common.Trade[] storage toPortfolio = _accountTrades[to];
        _upsertTrade(
            toPortfolio,
            Common.Trade(instrumentGroupId, instrumentId, startBlock, duration, swapType, trade.rate, value)
        );

        // All transfers of trades must pass a free collateral check.
        (int256 fc, /* uint128[] memory */) = freeCollateral(from);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        (fc, /* uint128[] memory */) = freeCollateral(to);
        require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
    }

    /**
     * @notice Settles all matured cash trades and liquidity tokens in a user's portfolio. This method is
     * unauthenticated, anyone may settle the trades in any account. This is required for accounts that
     * have negative cash and counterparties need to settle against them.
     *
     * @param account the account referenced
     */
    function settleAccount(address account) public override {
        _settleAccount(account);

        emit SettleAccount(msg.sender, account);
    }

    /**
     * @notice Settle a batch of accounts.
     *
     * @param accounts an array of accounts to settle
     */
    function settleAccountBatch(address[] calldata accounts) external override {
        for (uint256 i; i < accounts.length; i++) {
            _settleAccount(accounts[i]);
        }

        emit SettleAccountBatch(msg.sender, accounts);
    }

    /**
     * @notice Settles all matured cash trades and liquidity tokens in a user's portfolio. This method is
     * unauthenticated, anyone may settle the trades in any account. This is required for accounts that
     * have negative cash and counterparties need to settle against them.
     *
     * @param account the account referenced
     */
    function _settleAccount(address account) internal {
        Common.Trade[] storage portfolio = _accountTrades[account];
        uint32 blockNum = uint32(block.number);

        // This is only used when merging the account's portfolio for updating cash balances in escrow. We
        // keep this here so that we can do a single function call to settle all the cash in Escrow.
        int256[] memory settledCash = new int256[](uint256(G_NUM_CURRENCIES + 1));

        // Loop through the portfolio and find the trades that have matured.
        for (uint256 i; i < portfolio.length; i++) {
            if ((portfolio[i].startBlock + portfolio[i].duration) <= blockNum) {
                // Here we are dealing with a matured trade. We get the appropriate currency for
                // the instrument. We may want to cache this somehow, but in all likelihood there
                // will not be multiple matured trades in the same instrument group.
                uint16 currency = instrumentGroups[portfolio[i].instrumentGroupId].currency;

                if (Common.isCashPayer(portfolio[i].swapType)) {
                    // If the trade is a payer, we subtract from the cash balance
                    settledCash[currency] = settledCash[currency].sub(portfolio[i].notional);
                } else if (Common.isCashReceiver(portfolio[i].swapType)) {
                    // If the trade is a receiver, we add to the cash balance
                    settledCash[currency] = settledCash[currency].add(portfolio[i].notional);
                } else if (Common.isLiquidityToken(portfolio[i].swapType)) {
                    // Settling liquidity tokens is a bit more involved since we need to remove
                    // money from the collateral pools. This function returns the amount of future cash
                    // the liquidity token has a claim to.
                    address futureCashMarket = instrumentGroups[portfolio[i].instrumentGroupId].futureCashMarket;
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

                // Remove trade from the portfolio
                _removeTrade(portfolio, i);
                // The portfolio has gotten smaller, so we need to go back to account for the removed trade.
                i--;
            }
        }

        // We call the escrow contract to update the account's cash balances.
        Escrow().portfolioSettleCash(account, settledCash);
    }

    /***** Public Authenticated Methods *****/

    /***** Liquidation Methods *****/

    /**
     * @notice Looks for ways to take cash from the portfolio and return it to the escrow contract during
     * cash settlement.
     *
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

    function raiseCollateralViaCashReceiver(
        address account,
        uint16 currency,
        uint128 amount
    ) public override returns (uint128) {
        return _tradePortfolio(account, currency, amount, Common.getCashReceiver());
    }

    /**
     * @notice Takes some amount of collateral and uses it to pay of obligations in the portfolio.
     *
     * @param account the account that holds the obligations
     * @param currency the currency that the trades should be denominated in
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
     * @dev May want to refactor this to take swapType as an input instead of bools
     *
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
    ) public returns (uint128) {
        // Only Escrow can execute actions to trade the portfolio
        require(calledByEscrow(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        // Sorting the portfolio ensures that as we iterate through it we see each instrument group
        // in batches. However, this means that we won't be able to track the indexes to remove correctly.
        Common.Trade[] memory portfolio = Common._sortPortfolio(_accountTrades[account]);
        if (portfolio.length == 0) return amount;

        TradePortfolioState memory state = TradePortfolioState(
            uint128(amount),
            0,
            0,
            // At most we will add twice as many trades as the portfolio (this would be for liquidity token)
            // changes where we update both liquidity tokens as well as cash obligations.
            new Common.Trade[](portfolio.length * 2)
        );

        // We initialize these instrument groups here knowing that there is at least one trade in the portfolio
        uint8 instrumentGroupId = portfolio[0].instrumentGroupId;
        Common.InstrumentGroup memory ig = instrumentGroups[instrumentGroupId];

        // Iterate over the portfolio and trade as required.
        for (uint256 i; i < portfolio.length; i++) {
            if (instrumentGroupId != portfolio[i].instrumentGroupId) {
                // Here the instrument group has changed and therefore the future cash market has also
                // changed. We need to unlock collateral from the previous future cash market.
                Escrow().unlockCollateral(currency, ig.futureCashMarket, state.unlockedCollateral);
                // Reset this counter for the next group
                state.unlockedCollateral = 0;

                // Fetch the new instrument group.
                instrumentGroupId = portfolio[i].instrumentGroupId;
                ig = instrumentGroups[instrumentGroupId];
            }

            if (ig.currency != currency) continue;
            if (portfolio[i].swapType != tradeType) continue;

            if (Common.isCashPayer(portfolio[i].swapType)) {
                _tradeCashPayer(portfolio[i], ig.futureCashMarket, state);
            } else if (Common.isLiquidityToken(portfolio[i].swapType)) {
                _tradeLiquidityToken(portfolio[i], ig.futureCashMarket, state);
            } else if (Common.isCashReceiver(portfolio[i].swapType)) {
                _tradeCashReceiver(account, portfolio[i], ig.futureCashMarket, state);
            }

            // No more collateral left so we break out of the loop
            if (state.amountRemaining == 0) {
                break;
            }
        }

        if (state.unlockedCollateral != 0) {
            // Transfer cash from the last instrument group in the previous loop
            Escrow().unlockCollateral(currency, ig.futureCashMarket, state.unlockedCollateral);
        }

        Common.Trade[] storage accountStorage = _accountTrades[account];
        for (uint256 i; i < state.indexCount; i++) {
            // This bypasses the free collateral check which is required here.
            _upsertTrade(accountStorage, state.portfolioChanges[i]);
        }

        return state.amountRemaining;
    }

    /**
     * @notice Extracts collateral from liquidity tokens.
     *
     * @param trade the liquidity token to extract cash from
     * @param futureCashMarket the address of the future cash market
     * @param state state of the portfolio trade operation
     */
    function _tradeLiquidityToken(
        Common.Trade memory trade,
        address futureCashMarket,
        TradePortfolioState memory state
    ) internal  {
        (uint128 collateral, uint128 futureCash, uint128 tokens) = FutureCash(futureCashMarket)
            .tradeLiquidityToken(
                state.amountRemaining,
                trade.notional,
                trade.startBlock + trade.duration
            );
        state.amountRemaining = state.amountRemaining.sub(collateral);

        // This amount of collateral has been removed from the market
        state.unlockedCollateral = state.unlockedCollateral.add(collateral);

        // This is a CASH_RECEIVER that is credited back as a result of settling the liquidity token.
        state.portfolioChanges[state.indexCount] = Common.Trade(
            trade.instrumentGroupId,
            trade.instrumentId,
            trade.startBlock,
            trade.duration,
            Common.getCashReceiver(),
            trade.rate,
            futureCash
        );
        state.indexCount++;

        // This marks the removal of an amount of liquidity tokens
        state.portfolioChanges[state.indexCount] = Common.Trade(
            trade.instrumentGroupId,
            trade.instrumentId,
            trade.startBlock,
            trade.duration,
            Common.makeCounterparty(Common.getLiquidityToken()),
            trade.rate,
            tokens
        );
        state.indexCount++;
    }

    /**
     * @notice Sells future cash in order to raise collateral
     *
     * @param account the account that holds the future cash
     * @param trade the future cash token to extract cash from
     * @param futureCashMarket the address of the future cash market
     * @param state state of the portfolio trade operation
     */
    function _tradeCashReceiver(
        address account,
        Common.Trade memory trade,
        address futureCashMarket,
        TradePortfolioState memory state
    ) internal {
        // This will sell off the entire amount of future cash and return collateral
        uint128 collateral = FutureCash(futureCashMarket).tradeCashReceiver(
            account,
            state.amountRemaining,
            trade.notional,
            trade.startBlock + trade.duration
        );

        // Trade failed, do not update any state variables
        if (collateral == 0) return;

        // This amount of collateral has been removed from the market
        state.unlockedCollateral = state.unlockedCollateral.add(collateral);
        state.amountRemaining = state.amountRemaining.sub(collateral);

        // This is a CASH_PAYER that will offset the future cash in the portfolio, it will
        // always be the entire future cash amount.
        state.portfolioChanges[state.indexCount] = Common.Trade(
            trade.instrumentGroupId,
            trade.instrumentId,
            trade.startBlock,
            trade.duration,
            Common.getCashPayer(),
            trade.rate,
            trade.notional
        );
        state.indexCount++;
    }

    /**
     * @notice Purchases future cash to offset obligations
     *
     * @param trade the future cash token to pay off
     * @param futureCashMarket the address of the future cash market
     * @param state state of the portfolio trade operation
     */
    function _tradeCashPayer(
        Common.Trade memory trade,
        address futureCashMarket,
        TradePortfolioState memory state
    ) internal returns (uint256, uint128, int256) {
        // This will purchase future cash in order to close out the obligations
        (uint128 repayCost, uint128 futureCash) = FutureCash(futureCashMarket).tradeCashPayer(
            state.amountRemaining,
            trade.notional,
            trade.startBlock + trade.duration
        );

        // This amount of collateral has to be deposited in the market
        state.unlockedCollateral = state.unlockedCollateral.sub(repayCost);
        state.amountRemaining = state.amountRemaining.sub(repayCost);

        // This is a CASH_RECEIVER that will offset the obligation in the portfolio
        state.portfolioChanges[state.indexCount] = Common.Trade(
            trade.instrumentGroupId,
            trade.instrumentId,
            trade.startBlock,
            trade.duration,
            Common.getCashReceiver(),
            trade.rate,
            futureCash
        );
        state.indexCount++;
    }

    /***** Liquidation Methods *****/

    /***** Internal Portfolio Methods *****/

    /**
     * @notice Returns the offset for a specific trade in an array of trades given a storage
     * pointer to a trade array. The parameters of this function define a unique id of
     * the trade.
     *
     * @param portfolio storage pointer to the list of trades
     * @param swapType the type of swap to search for
     * @param instrumentGroupId the instrument group id
     * @param instrumentId the instrument id
     * @param startBlock the starting block
     * @param duration the duration of the swap
     * @param findCounterparty find the counterparty of the trade
     *
     * @return (storage pointer to the trade, index of trade, is counterparty trade or not)
     */
    function _searchTrade(
        Common.Trade[] storage portfolio,
        bytes1 swapType,
        uint8 instrumentGroupId,
        uint16 instrumentId,
        uint32 startBlock,
        uint32 duration,
        bool findCounterparty
    ) internal view returns (Common.Trade storage, uint256, bool) {
        if (portfolio.length == 0) {
            return (NULL_TRADE, portfolio.length, false);
        }

        for (uint256 i; i < portfolio.length; i++) {
            Common.Trade storage t = portfolio[i];
            if (t.instrumentGroupId != instrumentGroupId) continue;
            if (t.instrumentId != instrumentId) continue;
            if (t.startBlock != startBlock) continue;
            if (t.duration != duration) continue;

            if (t.swapType == swapType) {
                return (t, i, false);
            } else if (findCounterparty && t.swapType == Common.makeCounterparty(swapType)) {
                return (t, i, true);
            }
        }

        return (NULL_TRADE, portfolio.length, false);
    }

    /**
     * @notice Checks for the existence of a matching trade and then chooses update or append
     * as appropriate.
     *
     * @param portfolio a list of trades
     * @param trade the new trade to add
     */
    function _upsertTrade(Common.Trade[] storage portfolio, Common.Trade memory trade) internal {
        (Common.Trade storage matchedTrade, uint256 index, bool isCounterparty) = _searchTrade(
            portfolio,
            trade.swapType,
            trade.instrumentGroupId,
            trade.instrumentId,
            trade.startBlock,
            trade.duration,
            true
        );

        if (matchedTrade.swapType == 0x00) {
            // This is the NULL_TRADE so we append. This restriction should never work against extracting
            // cash or liquidation because in those cases we will always be trading offsetting positions
            // rather than adding new positions.
            require(portfolio.length < G_MAX_TRADES, $$(ErrorCode(PORTFOLIO_TOO_LARGE)));

            if (Common.isLiquidityToken(trade.swapType) && Common.isPayer(trade.swapType)) {
                // You cannot have a payer liquidity token without an existing liquidity token entry in
                // your portfolio since liquidity tokens must always have a positive balance.
                revert($$(ErrorCode(INSUFFICIENT_BALANCE)));
            }

            // Append the new trade
            portfolio.push(trade);
        } else if (!isCounterparty) {
            // If the trade types match, then just aggregate the notional amounts.
            matchedTrade.notional = matchedTrade.notional.add(trade.notional);
        } else {
            if (matchedTrade.notional >= trade.notional) {
                // We have enough notional of the trade to reduce or remove the trade.
                _reduceTrade(portfolio, matchedTrade, index, trade.notional);
            } else if (Common.isLiquidityToken(trade.swapType)) {
                // Liquidity tokens cannot go below zero.
                revert($$(ErrorCode(INSUFFICIENT_BALANCE)));
            } else if (Common.isCash(trade.swapType)) {
                // Otherwise, we need to flip the sign of the swap and set the notional amount
                // to the difference.
                matchedTrade.notional = trade.notional.sub(matchedTrade.notional);
                matchedTrade.swapType = trade.swapType;
            }
        }
    }

    /**
     * @notice Reduces the notional of a trade by value, if value is equal to the total notional
     * then removes it from the portfolio.
     *
     * @param portfolio a storage pointer to the account's trades
     * @param trade a storage pointer to the trade
     * @param index of the trade in the portfolio
     * @param value the amount of notional to reduce
     */
    function _reduceTrade(Common.Trade[] storage portfolio, Common.Trade storage trade, uint256 index, uint128 value)
        internal
    {
        require(trade.swapType != 0x00, $$(ErrorCode(INVALID_SWAP)));
        require(trade.notional >= value, $$(ErrorCode(INSUFFICIENT_BALANCE)));

        if (trade.notional == value) {
            _removeTrade(portfolio, index);
        } else {
            // We did the check above that will prevent an underflow here
            trade.notional = trade.notional - value;
        }
    }

    /**
     * @notice Removes a trade from a portfolio, used when trades are transferred by _reduceTrade
     * or when they are settled.
     *
     * @param portfolio a storage pointer to the trades
     * @param index the index of the trade to remove
     */
    function _removeTrade(Common.Trade[] storage portfolio, uint256 index) internal {
        uint256 lastIndex = portfolio.length - 1;
        if (index != lastIndex) {
            Common.Trade memory lastTrade = portfolio[lastIndex];
            portfolio[index] = lastTrade;
        }
        portfolio.pop();
    }
}
