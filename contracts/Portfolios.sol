pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./utils/Common.sol";
import "./utils/Governed.sol";

import "./lib/SafeMath.sol";
import "./lib/SafeInt256.sol";
import "./lib/SafeUInt128.sol";

import "./interface/IRateOracle.sol";
import "./interface/IRiskFramework.sol";

import "./Escrow.sol";
import "./FutureCash.sol";

import "./storage/PortfoliosStorage.sol";

/**
 * @title Portfolios
 * @notice Holds all the methods for managing an account's portfolio of trades
 */
contract Portfolios is PortfoliosStorage, Governed {
    using SafeMath for uint256;
    using SafeInt256 for int256;
    using SafeUInt128 for uint128;

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

    function setNumCurrencies(uint16 numCurrencies) public {
        require(msg.sender == contracts[uint256(CoreContracts.Escrow)], $$(ErrorCode(UNAUTHORIZED_CALLER)));
        G_NUM_CURRENCIES = numCurrencies;
    }

    function setMaxTrades(uint256 maxTrades) public onlyOwner {
        G_MAX_TRADES = maxTrades;
    }

    function setCollateralCurrency(uint16 currency) public onlyOwner {
        G_COLLATERAL_CURRENCY = currency;
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
     * @param discountRateOracle the rate oracle that defines the discount rate
     */
    function createInstrumentGroup(
        uint32 numPeriods,
        uint32 periodSize,
        uint32 precision,
        uint16 currency,
        address discountRateOracle,
        address riskFormula
    ) external onlyOwner {
        require(currentInstrumentGroupId <= MAX_INSTRUMENT_GROUPS, $$(ErrorCode(OVER_INSTRUMENT_LIMIT)));
        require(
            Escrow(contracts[uint256(CoreContracts.Escrow)]).isCurrencyGroup(currency),
            $$(ErrorCode(INVALID_CURRENCY))
        );
        // We don't need to check for the validity of discountRateOracles on the SettlementOracle because
        // future cash markets do not require settlement.
        currentInstrumentGroupId++;
        instrumentGroups[currentInstrumentGroupId] = Common.InstrumentGroup(
            numPeriods,
            periodSize,
            precision,
            currency,
            discountRateOracle,
            riskFormula
        );

        // The instrument is set to 0 for discount rate oracles and there is no max rate as well.
        IRateOracle(discountRateOracle).setParameters(
            currentInstrumentGroupId,
            0,
            currency,
            precision,
            periodSize,
            numPeriods,
            0
        );

        emit NewInstrumentGroup(currentInstrumentGroupId);
    }

    /**
     * @notice Updates instrument groups. Be very careful when calling this function! When changing periods and
     * period sizes the oracles must be updated as well. If the discountRateOracle is shared by other
     * instrument groups, their numPeriod and periodSize must be updated as well or this will result in
     * incompatibility.
     *
     * @param instrumentGroupId the group id to update
     * @param numPeriods this is safe to update as long as the discount rate oracle is not shared
     * @param periodSize this is only safe to update when there are no trades left
     * @param precision this is only safe to update when there are no trades left
     * @param currency this is safe to update if there are no trades or the new currency is equivalent
     * @param discountRateOracle this is safe to update once the oracle is established
     */
    function updateInstrumentGroup(
        uint8 instrumentGroupId,
        uint32 numPeriods,
        uint32 periodSize,
        uint32 precision,
        uint16 currency,
        address discountRateOracle,
        address riskFormula
    ) external onlyOwner {
        require(
            instrumentGroupId != 0 && instrumentGroupId <= currentInstrumentGroupId,
            $$(ErrorCode(INVALID_INSTRUMENT_GROUP))
        );
        require(
            Escrow(contracts[uint256(CoreContracts.Escrow)]).isCurrencyGroup(currency),
            $$(ErrorCode(INVALID_CURRENCY))
        );

        Common.InstrumentGroup storage i = instrumentGroups[instrumentGroupId];
        if (i.numPeriods != numPeriods) i.numPeriods = numPeriods;
        if (i.periodSize != periodSize) i.periodSize = periodSize;
        if (i.precision != precision) i.precision = precision;
        if (i.currency != currency) i.currency = currency;
        if (i.discountRateOracle != discountRateOracle) i.discountRateOracle = discountRateOracle;
        if (i.riskFormula != riskFormula) i.riskFormula = riskFormula;

        // The instrument is set to 0 for discount rate oracles and there is no max rate as well.
        IRateOracle(discountRateOracle).setParameters(
            instrumentGroupId,
            0,
            currency,
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
    function getTrades(address account) public view returns (Common.Trade[] memory) {
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
    function getInstrumentGroup(uint8 instrumentGroupId) public view returns (Common.InstrumentGroup memory) {
        return instrumentGroups[instrumentGroupId];
    }

    /**
     * @notice Gets instrument groups by id
     *
     * @param groupIds array of instrument group ids to retrieve
     */
    function getInstrumentGroups(uint8[] memory groupIds) public view returns (Common.InstrumentGroup[] memory) {
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
    ) public view returns (Common.Trade memory, uint256) {
        Common.Trade[] storage portfolio = _accountTrades[account];
        (Common.Trade memory t, uint256 index) = _searchTrade(
            portfolio,
            swapType,
            instrumentGroupId,
            instrumentId,
            startBlock,
            duration
        );

        return (t, index);
    }

    /**
     * @notice Stateful version of free collateral, first settles all trades in the account before returning
     * the free collateral parameters.
     *
     * @param account to get free collateral for
     */
    function freeCollateral(address account) public returns (int256, uint128[] memory) {
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
        int256[] memory cash = Escrow(contracts[uint256(CoreContracts.Escrow)]).getNetBalances(account);
        // This array will hold the requirements in each currency
        uint128[] memory currencyRequirement = new uint128[](cash.length);
        Common.Requirement[] memory requirements;

        if (portfolio.length > 0) {
            // This returns the net requirement in each currency held by the portfolio.
            requirements = IRiskFramework(contracts[uint256(CoreContracts.RiskFramework)]).getRequirement(portfolio);

            // Net out the cash that and requirements provided by the risk framework.
            for (uint256 i; i < requirements.length; i++) {
                uint256 currency = uint256(requirements[i].currency);
                // This new cash balance represents any net collateral position after taking the portfolio
                // into account.

                // TODO: update this to a separate array?
                cash[currency] = cash[currency].add(requirements[i].npv).sub(requirements[i].requirement);
            }
        }

        // We do this in a separate loop in case the portfolio is empty and the account just holds
        // a negative cash balance. We still need to ensure that it is collateralized.
        for (uint256 i; i < cash.length; i++) {
            if (cash[i] < 0) {
                currencyRequirement[i] = uint128(cash[i].neg());
                // TODO: credit back positive cash that is not collateralizing obligations, we cannot credit back
                // npv here because we won't be able to determine which currency we need to extract cash from.
            }
        }

        // Collateral requirements are denominated in G_COLLATERAL_CURRENCY and positive.
        uint128[] memory collateralRequirement = Escrow(contracts[uint256(CoreContracts.Escrow)])
            .convertBalancesToCollateral(currencyRequirement);

        // Sum up the required balances in G_COLLATERAL_CURRENCY and then net it out with the balance that
        // the account holds
        int256 fc;
        for (uint256 i; i < collateralRequirement.length; i++) {
            fc = fc.sub(collateralRequirement[i]);
        }

        // TODO: fc here is not really free collateral, it's more like the net currency requirement
        return (fc.add(cash[G_COLLATERAL_CURRENCY]), currencyRequirement);
    }

    /***** Public Authenticated Methods *****/

    /**
     * @notice Updates the portfolio of an account with a trade, merging it into the rest of the
     * portfolio if necessary.
     *
     * @param account to insert the trade to
     * @param trade trade to insert into the account
     */
    function upsertAccountTrade(address account, Common.Trade memory trade) public {
        // Only the rate oracle (in this case the Future Cash market) can call insert trades
        // for this instrument group.
        address rateOracle = instrumentGroups[trade.instrumentGroupId].discountRateOracle;
        require(msg.sender == rateOracle, $$(ErrorCode(UNAUTHORIZED_CALLER)));

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
    ) public {
        // Only the rate oracle (in this case the Future Cash market) can call insert trades
        // for this instrument group. Liquidation is also allowed to call this function in order to
        // sell off portions of the portfolio.

        // No point in calling this function with an empty trade array.
        if (trades.length == 0) {
            return;
        }

        // Here we check that all the instrument group ids are the same if the liquidation auction
        // is not calling this function. If this is not the case then we have an issue. Rate oracles
        // should only ever call this function with the same instrument group id for all the trades
        // they submit.
        uint16 id = trades[0].instrumentGroupId;
        for (uint256 i = 1; i < trades.length; i++) {
            require(trades[i].instrumentGroupId == id, $$(ErrorCode(UNAUTHORIZED_CALLER)));
        }

        address rateOracle = instrumentGroups[trades[0].instrumentGroupId].discountRateOracle;
        require(msg.sender == rateOracle, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Trade[] storage portfolio = _accountTrades[account];
        for (uint256 i; i < trades.length; i++) {
            // If an array contains an empty swap type then quit. This cannot be possible
            // via the Swap contract since it will validate trades before they are submitted.
            if (trades[i].swapType == 0) break;
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
    ) public {
        // Can only be called by ERC1155 token to transfer trades between accounts.
        require(msg.sender == contracts[uint256(CoreContracts.ERC1155Token)], $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Common.Trade[] storage fromPortfolio = _accountTrades[from];
        (Common.Trade storage trade, uint256 index) = _searchTrade(
            fromPortfolio,
            swapType,
            instrumentGroupId,
            instrumentId,
            startBlock,
            duration
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
    function settleAccount(address account) public {
        _settleAccount(account);

        emit SettleAccount(msg.sender, account);
    }

    /**
     * @notice Settle a batch of accounts.
     *
     * @param accounts an array of accounts to settle
     */
    function settleAccountBatch(address[] calldata accounts) external {
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

                if (Common.isCash(portfolio[i].swapType)) {
                    if (Common.isPayer(portfolio[i].swapType)) {
                        // If the trade is a payer, we subtract from the cash balance
                        settledCash[currency] = settledCash[currency].sub(portfolio[i].notional);
                    } else {
                        // If the trade is a receiver, we add to the cash balance
                        settledCash[currency] = settledCash[currency].add(portfolio[i].notional);
                    }
                } else if (Common.isLiquidityToken(portfolio[i].swapType)) {
                    // Settling liquidity tokens is a bit more involved since we need to remove
                    // money from the collateral pools. This function returns the amount of future cash
                    // the liquidity token has a claim to.
                    address rateOracle = instrumentGroups[portfolio[i].instrumentGroupId].discountRateOracle;
                    // This function call will transfer the collateral claim back to the Escrow account.
                    uint128 futureCashAmount = FutureCash(rateOracle).settleLiquidityToken(
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
        Escrow(contracts[uint256(CoreContracts.Escrow)]).portfolioSettleCash(account, settledCash);
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
     * @param sellFutureCash whether or not we should sell future cash
     * @return returns the amount of remaining collateral value (if any) that the function was unable
     *  to extract from the portfolio
     */
    function extractCash(
        address account,
        uint16 currency,
        uint128 amount,
        bool sellFutureCash
    ) public returns (uint128) {
        return _tradePortfolio(account, currency, amount, false, sellFutureCash);
    }

    /**
     * @notice Takes some amount of collateral and uses it to pay of obligations in the portfolio.
     *
     * @param account the account that holds the obligations
     * @param currency the currency that the trades should be denominated in
     * @param amount the amount of current cash available to pay off obligations
     * @return returns the excess amount of collateral after obligations have been closed
     */
    function closeObligations(
        address account,
        uint16 currency,
        uint128 amount
    ) public returns (uint128) {
        return _tradePortfolio(account, currency, amount, true, false);
    }

    /**
     * @notice A generic, internal function that trades positions within a portfolio.
     * @dev May want to refactor this to take swapType as an input instead of bools
     *
     * @param account account that holds the portfolio to trade
     * @param currency the currency that the trades should be denominated in
     * @param amount of collateral available
     * @param isCloseObligations if this function should be closing obligations
     * @param sellFutureCash if this function should sell future cash
     */
    function _tradePortfolio(
        address account,
        uint16 currency,
        uint128 amount,
        bool isCloseObligations,
        bool sellFutureCash
    ) public returns (uint128) {
        // Only Escrow can execute actions to trade the portfolio
        require(
            msg.sender == contracts[uint256(CoreContracts.Escrow)],
            $$(ErrorCode(UNAUTHORIZED_CALLER))
        );

        // Sorting the portfolio ensures that as we iterate through it we see each instrument group
        // in batches. However, this means that we won't be able to track the indexes to remove correctly.
        Common.Trade[] memory portfolio = Common._sortPortfolio(_accountTrades[account]);
        if (portfolio.length == 0) {
            // Nothing to do here.
            return amount;
        }

        // Amount of collateral remaining
        uint128 amountRemaining = uint128(amount);
        // Number of indexes in the portfolioChanges array that have been used.
        uint256 indexCount;
        // At most we will add twice as many trades as the portfolio (this would be for liquidity token)
        // changes where we update both liquidity tokens as well as cash obligations.
        Common.Trade[] memory portfolioChanges = new Common.Trade[](portfolio.length * 2);
        // This variable holds the amount of collateral that the future cash contract needs to transfer
        // between to the escrow contract since it has been taken out of or added to future cash markets.
        int256 unlockedCollateral;

        // We initialize these instrument groups here knowing that there is at least one trade in the portfolio
        uint8 instrumentGroupId = portfolio[0].instrumentGroupId;
        Common.InstrumentGroup memory ig = instrumentGroups[instrumentGroupId];

        // Iterate over the portfolio and trade as required.
        for (uint256 i; i < portfolio.length; i++) {
            if (instrumentGroupId != portfolio[i].instrumentGroupId) {
                // Here the instrument group has changed and therefore the future cash market has also
                // changed. We need to unlock collateral from the previous future cash market.
                Escrow(contracts[uint256(CoreContracts.Escrow)]).unlockCollateral(
                    currency,
                    ig.discountRateOracle,
                    unlockedCollateral
                );
                // Reset this counter for the next group
                unlockedCollateral = 0;

                // Fetch the new instrument group.
                instrumentGroupId = portfolio[i].instrumentGroupId;
                ig = instrumentGroups[instrumentGroupId];
            }

            if (ig.currency != currency) {
                // Only operate on trades in this currency
                continue;
            }

            if (isCloseObligations &&
                Common.isCash(portfolio[i].swapType) &&
                Common.isPayer(portfolio[i].swapType)
            ) {
                // Close obligations on CASH_PAYER tokens
                (indexCount, amountRemaining, unlockedCollateral) = _closeObligation(
                    portfolio[i],
                    portfolioChanges,
                    ig.discountRateOracle,
                    indexCount,
                    amountRemaining,
                    unlockedCollateral
                );
            } else if (!isCloseObligations && Common.isLiquidityToken(portfolio[i].swapType)) {
                // Extract cash from liquidity tokens
                (indexCount, amountRemaining, unlockedCollateral) = _extractLiquidityToken(
                    portfolio[i],
                    portfolioChanges,
                    ig.discountRateOracle,
                    indexCount,
                    amountRemaining,
                    unlockedCollateral
                );
            } else if (!isCloseObligations && sellFutureCash &&
                Common.isCash(portfolio[i].swapType) &&
                Common.isReceiver(portfolio[i].swapType) &&
                !Common.isLiquidityToken(portfolio[i].swapType)
            ) {
                // Trade future cash for current cash
                (indexCount, amountRemaining, unlockedCollateral) = _extractFutureCash(
                    account,
                    portfolio[i],
                    portfolioChanges,
                    ig.discountRateOracle,
                    indexCount,
                    amountRemaining,
                    unlockedCollateral
                );
            }

            // No more collateral left so we break out of the loop
            if (amountRemaining == 0) {
                break;
            }
        }

        if (unlockedCollateral != 0) {
            // Transfer cash from the last instrument group in the previous loop
            Escrow(contracts[uint256(CoreContracts.Escrow)]).unlockCollateral(
                currency,
                ig.discountRateOracle,
                unlockedCollateral
            );
        }

        Common.Trade[] storage accountStorage = _accountTrades[account];
        for (uint256 i; i < indexCount; i++) {
            // This bypasses the free collateral check which is required here.
            _upsertTrade(accountStorage, portfolioChanges[i]);
        }

        return amountRemaining;
    }

    /**
     * @notice Extracts collateral from liquidity tokens.
     *
     * @param trade the liquidity token to extract cash from
     * @param portfolioChanges an array of the changes to the portfolio
     * @param discountRateOracle the address of the future cash market
     * @param indexCount index of portfolio changes to add trades to
     * @param amountRemaining amount of collateral to raise remaining
     * @param unlockedCollateral amount of collateral to unlock
     */
    // solium-disable-next-line security/no-assign-params
    function _extractLiquidityToken(
        Common.Trade memory trade,
        Common.Trade[] memory portfolioChanges,
        address discountRateOracle,
        uint256 indexCount,
        uint128 amountRemaining,
        int256 unlockedCollateral
    ) internal returns (uint256, uint128, int256) {
        // Do this in order to prevent the stack from getting too large
        uint128[] memory args = new uint128[](3);
        // 0 = collateralAmount
        // 1 = futureCashAmount
        // 2 = tokensToRemove

        (args[0], args[1], args[2]) = FutureCash(discountRateOracle)
            .extractCashLiquidityToken(
                amountRemaining,
                trade.notional,
                trade.startBlock + trade.duration
            );
        amountRemaining = amountRemaining - args[0];

        // This amount of collateral has been removed from the market
        unlockedCollateral = unlockedCollateral + args[0];

        // This is a CASH_RECEIVER that is credited back as a result of settling the liquidity token.
        portfolioChanges[indexCount] = Common.Trade(
            trade.instrumentGroupId,
            trade.instrumentId,
            trade.startBlock,
            trade.duration,
            Common.getFutureCash(false),
            trade.rate,
            args[1]
        );
        indexCount++;

        // This marks the removal of an amount of liquidity tokens
        portfolioChanges[indexCount] = Common.Trade(
            trade.instrumentGroupId,
            trade.instrumentId,
            trade.startBlock,
            trade.duration,
            Common.makeCounterparty(Common.getLiquidityToken()),
            trade.rate,
            args[2]
        );
        indexCount++;

        return (indexCount, amountRemaining, unlockedCollateral);
    }

    /**
     * @notice Sells future cash in order to raise collateral
     *
     * @param account the account that holds the future cash
     * @param trade the future cash token to extract cash from
     * @param portfolioChanges an array of the changes to the portfolio
     * @param discountRateOracle the address of the future cash market
     * @param indexCount index of portfolio changes to add trades to
     * @param amountRemaining amount of collateral to raise remaining
     * @param unlockedCollateral amount of collateral to unlock
     */
    // solium-disable-next-line security/no-assign-params
    function _extractFutureCash(
        address account,
        Common.Trade memory trade,
        Common.Trade[] memory portfolioChanges,
        address discountRateOracle,
        uint256 indexCount,
        uint128 amountRemaining,
        int256 unlockedCollateral
    ) internal returns (uint256, uint128, int256) {
        // This will sell off the entire amount of future cash and return collateral
        uint128 collateralAmount = FutureCash(discountRateOracle).extractFutureCash(
            account,
            amountRemaining,
            trade.notional,
            trade.startBlock + trade.duration
        );

        // This amount of collateral has been removed from the market
        unlockedCollateral = unlockedCollateral + collateralAmount;

        amountRemaining = amountRemaining - collateralAmount;

        // This is a CASH_PAYER that will offset the future cash in the portfolio, it will
        // always be the entire future cash amount.
        portfolioChanges[indexCount] = Common.Trade(
            trade.instrumentGroupId,
            trade.instrumentId,
            trade.startBlock,
            trade.duration,
            Common.getFutureCash(true),
            trade.rate,
            trade.notional
        );
        indexCount++;

        return (indexCount, amountRemaining, unlockedCollateral);
    }

    /**
     * @notice Purchases future cash to offset obligations
     *
     * @param trade the future cash token to pay off
     * @param portfolioChanges an array of the changes to the portfolio
     * @param discountRateOracle the address of the future cash market
     * @param indexCount index of portfolio changes to add trades to
     * @param amountRemaining amount of collateral to raise remaining
     * @param unlockedCollateral amount of collateral to unlock
     */
    // solium-disable-next-line security/no-assign-params
    function _closeObligation(
        Common.Trade memory trade,
        Common.Trade[] memory portfolioChanges,
        address discountRateOracle,
        uint256 indexCount,
        uint128 amountRemaining,
        int256 unlockedCollateral
    ) internal returns (uint256, uint128, int256) {
        // This will purchase future cash in order to close out the obligations
        (uint128 receiverCost, uint128 futureCashAmount) = FutureCash(discountRateOracle).closeObligation(
            amountRemaining,
            trade.notional,
            trade.startBlock + trade.duration
        );

        // This amount of collateral has to be deposited in the market
        unlockedCollateral = unlockedCollateral - receiverCost;

        amountRemaining = amountRemaining - receiverCost;

        // This is a CASH_RECEIVER that will offset the obligation in the portfolio
        portfolioChanges[indexCount] = Common.Trade(
            trade.instrumentGroupId,
            trade.instrumentId,
            trade.startBlock,
            trade.duration,
            Common.getFutureCash(false),
            trade.rate,
            futureCashAmount
        );
        indexCount++;

        return (indexCount, amountRemaining, unlockedCollateral);
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
     *
     * @return (storage pointer to the trade, index of trade)
     */
    function _searchTrade(
        Common.Trade[] storage portfolio,
        bytes1 swapType,
        uint8 instrumentGroupId,
        uint16 instrumentId,
        uint32 startBlock,
        uint32 duration
    ) internal view returns (Common.Trade storage, uint256) {
        if (portfolio.length == 0) {
            return (NULL_TRADE, portfolio.length);
        }

        for (uint256 i; i < portfolio.length; i++) {
            Common.Trade storage t = portfolio[i];
            if (t.instrumentGroupId != instrumentGroupId) continue;
            if (t.instrumentId != instrumentId) continue;
            if (t.startBlock != startBlock) continue;
            if (t.duration != duration) continue;
            if (t.swapType != swapType) continue;

            return (t, i);
        }

        return (NULL_TRADE, portfolio.length);
    }

    /**
     * @notice Checks for the existence of a matching trade and then chooses update or append
     * as appropriate.
     *
     * @param portfolio a list of trades
     * @param trade the new trade to add
     */
    function _upsertTrade(Common.Trade[] storage portfolio, Common.Trade memory trade) internal {
        Common.Trade storage t = NULL_TRADE;
        uint256 index;
        bool isCounterparty;

        if (portfolio.length > 0) {
            for (; index < portfolio.length; index++) {
                // These factors are what are required to find a trade that will match
                if (portfolio[index].instrumentGroupId != trade.instrumentGroupId) continue;
                if (portfolio[index].instrumentId != trade.instrumentId) continue;
                if (portfolio[index].startBlock != trade.startBlock) continue;
                if (portfolio[index].duration != trade.duration) continue;

                // If the swap type matches exactly or is the counterparty version, we can match here.
                if (portfolio[index].swapType == trade.swapType) {
                    t = portfolio[index];
                    break;
                } else if (portfolio[index].swapType == Common.makeCounterparty(trade.swapType)) {
                    // We have a trade that will net out against the trade in the portfolio.
                    t = portfolio[index];
                    isCounterparty = true;
                    break;
                }
            }
        }

        if (t.swapType == 0x00) {
            // This is the NULL_TRADE so we append. This restriction should never work against extracting
            // cash or liquidation because in those cases we will always be trading offsetting positions
            // rather than adding new positions.
            require(portfolio.length < G_MAX_TRADES, $$(ErrorCode(PORTFOLIO_TOO_LARGE)));

            if (Common.isLiquidityToken(trade.swapType) && Common.isPayer(trade.swapType)) {
                // You cannot have a payer liquidity token without an existing liquidity token entry in
                // your portfolio since liquidity tokens must always have a positive balance.
                revert($$(ErrorCode(INVALID_SWAP)));
            }

            // Append the new trade
            portfolio.push(trade);
        } else if (Common.isLiquidityToken(trade.swapType)) {
            // Liquidity tokens cannot have a negative balance but we need to differentiate between
            // the act of removing tokens and adding tokens so they have a payer or receiver marker.
            // When we store them in the portfolio this marker is not saved.
            if (isCounterparty) {
                // These are offsetting trades so we are reducing the notional amount of tokens
                if (t.notional == trade.notional) {
                    _removeTrade(portfolio, index);
                } else {
                    t.notional = t.notional.sub(trade.notional);
                }
            } else {
                // If it is not the counterparty, then add the tokens
                t.notional = t.notional.add(trade.notional);
            }
        } else if (Common.isCash(trade.swapType)) {
            // Receiver cash tokens are a positive cash flow, payer cash tokens are a negative cash flow. When
            // we merge in here we just need to ensure that we set the receiver / payer flag appropriately.
            if (isCounterparty) {
                if (t.notional == trade.notional) {
                    // If they are equal then the cash just nets out. Remove the trade.
                    _removeTrade(portfolio, index);
                } else if (t.notional > trade.notional) {
                    // If the existing trade has more notional, then we subtract the notional from
                    // the new trade. This will throw an error if it goes below zero.
                    t.notional = t.notional.sub(trade.notional);
                } else {
                    // Otherwise, we need to flip the sign of the swap and set the notional amount
                    // to the difference.
                    t.notional = trade.notional.sub(t.notional);
                    t.swapType = trade.swapType;
                }
            } else {
                // In this case we are on the same side so just add.
                t.notional = t.notional.add(trade.notional);
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
