pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./Portfolios.sol";
import "./FutureCash.sol";

import "./utils/Governed.sol";
import "./lib/SafeInt256.sol";
import "./lib/SafeMath.sol";

import "./interface/IERC20.sol";
import "./interface/IERC777Recipient.sol";
import "./interface/IERC1820Registry.sol";
import "./interface/IAggregator.sol";

import "./storage/EscrowStorage.sol";

/**
 * @title Escrow
 * @notice Manages collateral balances and cash balances for accounts. Collateral is managed under
 * `Currency Groups` which define a group of tokens that are risk free (or practically risk free)
 * equivalents of one another.
 */
contract Escrow is EscrowStorage, Governed, IERC777Recipient {
    using SafeMath for uint256;
    using SafeInt256 for int256;

    function initialize(address directory, address registry) public initializer {
        Governed.initialize(directory);

        // This registry call is used for the ERC777 token standard.
        IERC1820Registry(registry).setInterfaceImplementer(address(0), TOKENS_RECIPIENT_INTERFACE_HASH, address(this));
    }

    /********** Governance Settings ******************/
    function setCollateralCurrency(uint16 currency) external onlyOwner {
        G_COLLATERAL_CURRENCY = currency;
        G_COLLATERAL_TOKEN = currencyGroups[currency].primary;
    }

    function setEscrowHaircuts(uint128 liquidation, uint128 settlement) external onlyOwner {
        G_LIQUIDATION_HAIRCUT = liquidation;
        G_SETTLEMENT_HAIRCUT = settlement;
    }

    function setReserveAccount(address account) external onlyOwner {
        G_RESERVE_ACCOUNT = account;
    }

    /**
     * @notice Creates a new currency group using the primary currency token address.
     *
     * @param primary the primary currency token address
     */
    function createCurrencyGroup(address primary) external onlyOwner {
        // The first group id will be 1, we do not want 0 to be used as a group id.
        _currentCurrencyGroupId++;
        // We don't do a lot of checking here but since this is purely an administrative
        // activity we just rely on governance not to set this improperly.
        currencyGroups[_currentCurrencyGroupId].primary = primary;
        tokensToGroups[primary] = _currentCurrencyGroupId;
        // We need to set this number so that the free collateral check can provision
        // the right number of currencies.
        Portfolios(contracts[uint256(CoreContracts.Portfolios)]).setNumCurrencies(_currentCurrencyGroupId);
        emit NewCurrencyGroup(_currentCurrencyGroupId, primary);
    }

    /**
     * @notice Creates an exchange rate between the two primary currencies.
     * @dev This method will have to change once we begin to support secondary currencies.
     *
     * @param base the base currency
     * @param quote the quote currency
     * @param rateOracle the oracle that will give the exchange rate between the two
     * @param onChainExchange uniswap exchange for trustless exchange
     * @param haircut the amount of haircut to apply to the currency conversion
     */
    function addExchangeRate(
        uint16 base,
        uint16 quote,
        address rateOracle,
        address onChainExchange,
        uint128 haircut
    ) external onlyOwner {
        address baseCurrency = currencyGroups[base].primary;
        address quoteCurrency = currencyGroups[quote].primary;
        exchangeRateOracles[baseCurrency][quoteCurrency] = ExchangeRate(
            rateOracle,
            onChainExchange,
            haircut
        );

        emit NewExchangeRate(base, quote);
    }
    /********** Governance Settings ******************/

    /********** Events *******************************/
    event NewCurrencyGroup(uint16 indexed currencyGroupId, address indexed primary);
    event NewCurrency(uint16 indexed currencyGroupId, address indexed secondary, address exchangeRateOracle);
    event NewExchangeRate(uint16 indexed baseCurrency, uint16 indexed quoteCurrency);
    event RegisterFutureCashMarket(
        uint16 indexed currencyGroupId,
        address indexed futureCashMarket,
        address indexed collateralToken
    );
    /********** Events *******************************/

    /********** Getter Methods ***********************/

    /**
     * @notice Getter method for currency groups
     *
     * @param currency currency group id
     * @return CurrencyGroup
     */
    function getCurrencyGroup(uint16 currency) external view returns (CurrencyGroup memory) {
        return currencyGroups[currency];
    }

    /**
     * @notice true or false if currency group is valid
     *
     * @param currency currency group id
     * @return CurrencyGroup
     */
    function isCurrencyGroup(uint16 currency) public view returns (bool) {
        return currency != 0 && currency <= _currentCurrencyGroupId;
    }

    /**
     * @notice Getter method for exchange rates
     *
     * @param base token address for the base currency
     * @param quote token address for the quote currency
     * @return ExchangeRate
     */
    function getExchangeRate(address base, address quote) external view returns (ExchangeRate memory) {
        return exchangeRateOracles[base][quote];
    }

    /**
     * @notice Returns the net balances of all the primary currencies owned by an account as
     * an array. Each index of the array refers to the currency group id.
     *
     * @param account the account to query
     * @return the net balance of each currency group indexed by id (0 is unused)
     */
    function getNetBalances(address account) public view returns (int256[] memory) {
        // We add one here because the zero currency index is unused
        int256[] memory balances = new int256[](_currentCurrencyGroupId + 1);

        for (uint256 i = 1; i < balances.length; i++) {
            balances[i] = getNetBalanceOfCurrency(account, uint16(i));
        }

        return balances;
    }

    /**
     * @notice Returns the net balance denominated in the primary currency for an account. This balance
     * may be less than zero due to negative cash balances.
     * @dev This method needs to be modified to support secondary currencies
     *
     * @param account to get the balance for
     * @param currency the id of the currency group
     * @return the net balance of the currency group, denominated in the primary currency
     */
    function getNetBalanceOfCurrency(address account, uint16 currency) public view returns (int256) {
        CurrencyGroup storage cg = currencyGroups[currency];
        uint256 balance = currencyBalances[cg.primary][account];

        // In this version of the protocol, secondary currencies are not implemented.
        assert(cg.secondaries.length == 0);
        return int256(balance).add(cashBalances[currency][account]);
    }

    /**
     * @notice Converts the balances given to G_COLLATERAL_CURRENCY for the purposes of determining whether
     * an account has sufficient free collateral.
     *
     * @param amounts the balance in each currency group as an array, each index refers to the currency group id.
     * @return an array the same length as amounts with each balance denominated in G_COLLATERAL_CURRENCY
     */
    function convertBalancesToCollateral(
        uint128[] memory amounts
    ) public view returns (uint128[] memory) {
        // We expect values for all currencies to be supplied here, we will not do any work on 0 balances.
        require(amounts.length == (_currentCurrencyGroupId + 1), $$(ErrorCode(INVALID_CURRENCY)));
        uint128[] memory results = new uint128[](amounts.length);
        // The quote currency will always be the designated collateral currency
        address quote = currencyGroups[G_COLLATERAL_CURRENCY].primary;

        for (uint256 i = 1; i < amounts.length; i++) {
            // The zero currency group is unused.
            if (amounts[i] == 0) continue;
            if (i == uint256(G_COLLATERAL_CURRENCY)) {
                // We do not need to convert this currency
                results[i] = amounts[i];
            }

            address base = currencyGroups[uint16(i)].primary;
            // We are converting from the base to quote here, the quote is the collateral currency
            results[i] = uint128(_convert(base, quote, amounts[i], false));
        }

        return results;
    }

    /********** Getter Methods ***********************/

    /********** Withdraw / Deposit Methods ***********/

    /**
     * @notice Deposit ETH to use as collateral for loans. All future cash is denominated in Dai so this is only
     * useful as collateral for borrowing. Lenders will have to deposit dai in order to purchase future cash.
     * The amount of eth deposited should be set in `msg.value`.
     */
    function depositEth() public payable {
        require(msg.value <= Common.MAX_UINT_128, $$(ErrorCode(OVER_MAX_ETH_BALANCE)));
        currencyBalances[G_ETH_CURRENCY][msg.sender] = currencyBalances[G_ETH_CURRENCY][msg.sender].add(uint128(msg.value));
    }

    /**
     * @notice Withdraw ETH from the contract. This can only be done after a successful free collateral check.
     * @dev We do not use `msg.sender.transfer` or `msg.sender.send` as recommended by Consensys:
     * https://diligence.consensys.net/blog/2019/09/stop-using-soliditys-transfer-now/
     *
     * @param amount the amount of eth to withdraw from the contract
     */
    function withdrawEth(uint128 amount) public {
        uint256 balance = currencyBalances[G_ETH_CURRENCY][msg.sender];
        // Do all of these checks before we actually transfer the ETH to limit re-entrancy.
        require(balance >= amount, $$(ErrorCode(INSUFFICIENT_BALANCE)));
        currencyBalances[G_ETH_CURRENCY][msg.sender] = balance.sub(amount);
        require(_freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        // solium-disable-next-line security/no-call-value
        (bool success, ) = msg.sender.call.value(amount)("");
        require(success, $$(ErrorCode(TRANSFER_FAILED)));
    }

    /**
     * @notice Transfers a balance from an ERC20 token contract into the escrow.
     * @param tokenContract token contract to send from
     * @param amount tokens to transfer
     */
    function deposit(address tokenContract, uint256 amount) external {
        address to = msg.sender;
        uint16 currencyGroupId = tokensToGroups[tokenContract];
        require(currencyGroupId != 0, $$(ErrorCode(INVALID_CURRENCY)));
        require(tokenContract != address(0), $$(ErrorCode(INVALID_CURRENCY)));

        currencyBalances[tokenContract][to] = currencyBalances[tokenContract][to].add(amount);
        IERC20(tokenContract).transferFrom(to, address(this), amount);
    }

    /**
     * @dev See {IERC777TokenRecipient}
     * Receives tokens from an ERC777-send message.
     * @param from address the tokens are being sent from (!= msg.sender)
     * @param amount amount
     */
    function tokensReceived(
        address, /*operator*/
        address from,
        address, /*to*/
        uint256 amount,
        bytes calldata, /*userData*/
        bytes calldata /*operatorData*/
    ) external override {
        uint16 currencyGroupId = tokensToGroups[msg.sender];
        require(currencyGroupId != 0, $$(ErrorCode(INVALID_CURRENCY)));
        currencyBalances[msg.sender][from] = currencyBalances[msg.sender][from].add(amount);
    }

    /**
     * @notice Withdraws from an account's collateral holdings back to their account. Checks if the
     * account has sufficient free collateral after the withdraw or else it fails.
     *
     * @param tokenContract collateral type to withdraw
     * @param amount total value to withdraw
     */
    function withdraw(address tokenContract, uint256 amount) external {
        address to = msg.sender;
        require(currencyBalances[tokenContract][to] >= amount, $$(ErrorCode(INSUFFICIENT_BALANCE)));
        require(tokenContract != address(0), $$(ErrorCode(INVALID_CURRENCY)));

        currencyBalances[tokenContract][to] = currencyBalances[tokenContract][to].sub(amount);

        // We're checking this after the withdraw has been done on currency balances.
        require(_freeCollateral(to) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
        IERC20(tokenContract).transfer(to, amount);
    }

    /********** Withdraw / Deposit Methods ***********/

    /********** Collateral / Cash Management *********/

    /**
     * @notice Transfers the collateral required between the Future Cash Market and the specified account. Collateral
     * held by the Future Cash Market is available to purchase in the liquidity pools.
     *
     * @param account the account to withdraw collateral from
     * @param collateralToken the address of the token to use as collateral
     * @param currencyGroupId the currency group that this future cash market is registered under
     * @param isDeposit true if this is a deposit into the future cash market, false if it is a withdraw
     *      from the future cash market into the account
     * @param value the amount (denominated in the primary currency) of collateral to deposit
     * @param fee the amount of `value` to pay as a fee (denominated in the primary currency)
     */
    function transferFutureCashMarket(
        address account,
        address collateralToken,
        uint16 currencyGroupId,
        uint8 instrumentGroupId,
        bool isDeposit,
        uint128 value,
        uint128 fee
    ) public {
        CurrencyGroup storage cg = currencyGroups[currencyGroupId];

        // Only the future cash market is allowed to call this function.
        Common.InstrumentGroup memory ig = Portfolios(contracts[uint256(CoreContracts.Portfolios)])
            .getInstrumentGroup(instrumentGroupId);
        require(msg.sender == ig.discountRateOracle, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        if (collateralToken != cg.primary) {
            // Secondary currencies are unimplemented in this version of the code.
            revert($$(ErrorCode(UNIMPLEMENTED)));
        }
        uint256 amount = value - fee;

        if (fee > 0) {
            // Fees will accumualte in the reserve account. Not all transactions will have fees.
            currencyBalances[collateralToken][G_RESERVE_ACCOUNT] = currencyBalances[collateralToken][G_RESERVE_ACCOUNT].add(fee);
        }

        if (isDeposit) {
            // This is a deposit into the future cash market's account.
            currencyBalances[collateralToken][msg.sender] = currencyBalances[collateralToken][msg.sender].add(amount);
            currencyBalances[collateralToken][account] = currencyBalances[collateralToken][account].sub(amount);
        } else {
            // This is a withdraw from the future cash market's account.
            currencyBalances[collateralToken][account] = currencyBalances[collateralToken][account].add(amount);
            currencyBalances[collateralToken][msg.sender] = currencyBalances[collateralToken][msg.sender].sub(amount);
        }

        // A free collateral check is unncessary here because in every instance of the transfers in the
        // future cash market a free collateral check is done in the portfolio before the method finishes.
    }

    /**
     * @notice Adds or removes collateral from the future cash market when the portfolio is trading positions
     * as a result of settlement or liquidation.
     *
     * @param currency the currency group of the collateral
     * @param futureCashMarket the address of the future cash market to transfer between
     * @param amount the amount to transfer
     */
    function unlockCollateral(
        uint16 currency,
        address futureCashMarket,
        int256 amount
    ) public {
        require(msg.sender == contracts[uint256(CoreContracts.Portfolios)], $$(ErrorCode(UNAUTHORIZED_CALLER)));
        // NOTE: in this version of the protocol there are no secondary collateral tokens
        address token = currencyGroups[currency].primary;

        // The methods that calls this function will handle management of the collateral that is added or removed from
        // the market.
        if (amount > 0) {
            currencyBalances[token][futureCashMarket] = currencyBalances[token][futureCashMarket].sub(uint256(amount));
        } else {
            currencyBalances[token][futureCashMarket] = currencyBalances[token][futureCashMarket].add(uint256(amount.neg()));
        }
    }

    /**
     * @notice Can only be called by Portfolios when trades are settled to cash. There is no free collateral
     * check for this function call because trade settlement is an equivalent transformation of a trade
     * to a net cash value. An account's free collateral position will remain unchanged after settlement.
     *
     * @param account account where the cash is settled
     * @param settledCash an array of the currency groups that need to have their cash balance updated
     */
    function portfolioSettleCash(address account, int256[] memory settledCash) public {
        require(msg.sender == contracts[uint256(CoreContracts.Portfolios)], $$(ErrorCode(UNAUTHORIZED_CALLER)));
        // Since we are using the indexes to refer to the currency group ids, the length must be less than
        // or equal to the total number of group ids currently used plus the zero currency which is unused.
        require(settledCash.length == _currentCurrencyGroupId + 1, $$(ErrorCode(INVALID_CURRENCY)));

        // Note that currency group 0 is unused.
        for (uint256 i = 1; i < settledCash.length; i++) {
            if (settledCash[i] != 0) {
                // Update the balance of the appropriate currency group. We've validated that this conversion
                // to uint16 will not overflow with the require statement above.
                cashBalances[uint16(i)][account] = cashBalances[uint16(i)][account].add(settledCash[i]);
            }
        }
    }

    /********** Collateral / Cash Management *********/

    /********** Settle Cash / Liquidation *************/

    /**
     * @notice Settles the cash balances between the payers and receivers in batch
     *
     * @param currency the currency group to settle
     * @param payers the party that has a negative cash balance and will transfer collateral to the receiver
     * @param receivers the party that has a positive cash balance and will receive collateral from the payer
     * @param values the amount of collateral to transfer
     * @param settleAccounts if true, will settle all the accounts first
     */
    function settleCashBalanceBatch(
        uint16 currency,
        address[] calldata payers,
        address[] calldata receivers,
        uint128[] calldata values,
        bool settleAccounts
    ) external {
        if (settleAccounts) {
            Portfolios(contracts[uint256(CoreContracts.Portfolios)]).settleAccountBatch(payers);
            Portfolios(contracts[uint256(CoreContracts.Portfolios)]).settleAccountBatch(receivers);
        }

        for (uint256 i; i < payers.length; i++) {
            _settleCashBalance(currency, payers[i], receivers[i], values[i]);
        }
    }

    /**
     * @notice Settles the cash balance between the payer and the receiver.
     *
     * @param currency the currency group to settle
     * @param payer the party that has a negative cash balance and will transfer collateral to the receiver
     * @param receiver the party that has a positive cash balance and will receive collateral from the payer
     * @param value the amount of collateral to transfer
     */
    function settleCashBalance(
        uint16 currency,
        address payer,
        address receiver,
        uint128 value,
        bool settleAccounts
    ) external {
        if (settleAccounts) {
            address[] memory accounts = new address[](2);
            accounts[0] = payer;
            accounts[1] = receiver;
            Portfolios(contracts[uint256(CoreContracts.Portfolios)]).settleAccountBatch(accounts);
        }

        _settleCashBalance(currency, payer, receiver, value);
    }

    /**
     * @notice Settles the cash balance between the payer and the receiver.
     *
     * @param currency the currency group to settle
     * @param payer the party that has a negative cash balance and will transfer collateral to the receiver
     * @param receiver the party that has a positive cash balance and will receive collateral from the payer
     * @param value the amount of collateral to transfer
     */
    function _settleCashBalance(uint16 currency, address payer, address receiver, uint128 value) internal {
        require(payer != receiver, $$(ErrorCode(COUNTERPARTY_CANNOT_BE_SELF)));
        require(currency != 0 && currency <= _currentCurrencyGroupId, $$(ErrorCode(INVALID_CURRENCY)));
        if (value == 0) return;

        // This cash account must have enough negative cash to settle against
        require(cashBalances[currency][payer] <= int256(value).neg(), $$(ErrorCode(INCORRECT_CASH_BALANCE)));
        // The receiver must have enough cash balance to settle
        require(cashBalances[currency][receiver] >= int256(value), $$(ErrorCode(INCORRECT_CASH_BALANCE)));

        // In this version of the code we only support primary currencies so this is hardcoded to use only the
        // primary currency.
        address primary = currencyGroups[currency].primary;
        // This is a reference to the total balance that the payer has in the local currency.
        uint256 collateralBalance = currencyBalances[primary][payer];

        if (collateralBalance < value) {
            // Inside this if statement, the payer does not have enough local currency to settle their obligation.
            // First we will spend all of their collateral balance to settle their obligations before proceeding.
            delete currencyBalances[primary][payer];

            // If the payer does not have enough collateral to cover the value of the cash settlement, we have a
            // two options here:
            // 1. We attempt to extract cash from the portfolio (we do not know if there is any at this point)
            // 2. If there is still obligations remaining after we extract cash, we then check their free collateral.
            //   - If there is sufficient free collateral, we trade their ETH for local currency, either via uniswap
            //     or via exchange with the msg.sender
            //   - If there is not sufficient collateral, the payer account must be liquidated. However, we still
            //     settle out as much of their obligation as we can without liquidation.

            // The remaining amount of collateral that we need to raise from the account to cover its obligation.
            uint128 collateralRemaining = value - uint128(collateralBalance);

            // It's unclear here that this call will actually be able to extract any cash, but must attempt to do
            // this anyway. This action cannot result in the payer ending up under collateralized. Since we do not
            // sell future cash in this call, collateralRemaining will always be greater than or equal to zero after
            // this call returns.
            collateralRemaining = Portfolios(contracts[uint256(CoreContracts.Portfolios)])
                .extractCash(payer, currency, collateralRemaining, false);

            // In here, the extractCash call was not completely successful.
            if (collateralRemaining > 0) {
                // When we calculate free collateral here we need to add back in the value that we've extracted to ensure that the
                // free collateral calculation returns the appropriate value.
                int256 fc = _freeCollateral(payer).add(value).sub(collateralRemaining);

                if (fc >= 0) {
                    // If there is free collateral then we can sell ETH in order to raise collateral to settle cash.
                    if (msg.sender == receiver) {
                        // If the sender is the receiver then someone is attempting to settle the cash that they are owed.
                        // For this, we attempt to sell the collateral on Uniswap so that the receiver can have a purely
                        // on chain interaction.
                        collateralRemaining = _sellCollateral(
                            payer,
                            currency,
                            collateralRemaining
                        );
                    } else {
                        address collateralToken = currencyGroups[G_COLLATERAL_CURRENCY].primary;
                        // If the msg sender does not equal the receiver, then it is settling the position on behalf
                        // of the receiver. In this case, the msg.sender can purchase the ETH from the payer at a small
                        // discount from the oracle price for their service.
                        ExchangeRate memory er = exchangeRateOracles[primary][collateralToken];

                        int256 answer = IAggregator(er.rateOracle).latestAnswer();
                        require(answer > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

                        // G_SETTLEMENT_HAIRCUT defines a discount that the msg.sender receives for settling accounts
                        // on behalf of the receiver.
                        uint256 collateralToPurchase = uint256(answer)
                            .mul(collateralRemaining)
                            .div(Common.DECIMALS)
                            .mul(G_SETTLEMENT_HAIRCUT)
                            .div(Common.DECIMALS);

                        // Transfer the collateral between accounts. The msg.sender must have enough to cover the collateral
                        // remaining at this point.
                        currencyBalances[primary][msg.sender] = currencyBalances[primary][msg.sender].sub(collateralRemaining);

                        // Transfer the collateral currency between accounts
                        currencyBalances[collateralToken][msg.sender] = currencyBalances[collateralToken][msg.sender].add(collateralToPurchase);
                        // We expect the payer to have enough here because they passed the free collateral check.
                        currencyBalances[collateralToken][payer] = currencyBalances[collateralToken][payer].sub(collateralToPurchase);
                    }
                } else {
                    // Inside this branch, the account does not have enough free collateral and must be liquidated. There are two possible
                    // outcomes here. One is that the account has no collateral left and its debts must be settled via the reserve. The other
                    // is that we simply partially settle cash and leave the account for liquidation.
                    address collateralToken = currencyGroups[G_COLLATERAL_CURRENCY].primary;

                    if (currencyBalances[collateralToken][payer] == 0) {
                        // This call will attempt to sell future cash tokens in return for local currency. We do this as a last ditch effort
                        // before we dip into reserves. The free collateral position will not change as a result of this method since positive
                        // future cash (in this version) does not affect free collateral.
                        collateralRemaining = Portfolios(contracts[uint256(CoreContracts.Portfolios)])
                            .extractCash(payer, currency, collateralRemaining, true);

                        if (collateralRemaining > 0) {
                            // At this point, the portfolio has no positive future value associated with it and no collateral. It
                            // the account is completely insolvent and therfore we need to pay out the remaining obligation from the
                            // reserve account.
                            currencyBalances[primary][G_RESERVE_ACCOUNT] = currencyBalances[primary][G_RESERVE_ACCOUNT].sub(collateralRemaining);
                        }
                    } else {
                        // Here we are trying to settle cash against an undercollateralized account. What we do here is settle the max
                        // amount of collateral we can at this point. The remaining value can be settled after liquidation.
                        uint128 settledAmount = value - collateralRemaining;

                        // Net out cash balances, the payer no longer owes this cash. The receiver is no longer owed this cash.
                        cashBalances[currency][payer] = cashBalances[currency][payer].add(settledAmount);
                        cashBalances[currency][receiver] = cashBalances[currency][receiver].sub(settledAmount);

                        // Transfer the required amount to the receiver
                        currencyBalances[primary][receiver] = currencyBalances[primary][receiver].add(settledAmount);
                        return;
                    }
                }
            }
        } else {
            // In this case we are just paying the receiver directly out of the currency balance
            currencyBalances[primary][payer] = currencyBalances[primary][payer].sub(value);
        }

        // Net out cash balances, the payer no longer owes this cash. The receiver is no longer owed this cash. Every scenario
        // above results in these next three lines except for the scenario where we only partially settle the cash.
        cashBalances[currency][payer] = cashBalances[currency][payer].add(value);
        cashBalances[currency][receiver] = cashBalances[currency][receiver].sub(value);

        // Transfer the required amount to the receiver
        currencyBalances[primary][receiver] = currencyBalances[primary][receiver].add(value);
    }

    /**
     * @notice Liquidates a batch of accounts in a specific currency.
     *
     * @param accounts the account to liquidate
     * @param currency the currency group that is undercollateralized
     */
    function liquidateBatch(address[] calldata accounts, uint16 currency) external {
        for (uint256 i; i < accounts.length; i++) {
            liquidate(accounts[i], currency);
        }
    }

    /**
     * @notice Liquidates an account if it is under collateralized. First extracts any cash from the portfolio, then proceeds to
     * allow the liquidator to purchase collateral from the account at a discount from the oracle price. Finally, uses the collateral
     * raised to close out any obligations in the portfolio.
     *
     * @param account the account to liquidate
     * @param currency the currency group that is undercollateralized
     */
    function liquidate(address account, uint16 currency) public {
        int256 fc;
        uint128[] memory currencyRequirement;

        (fc, currencyRequirement) = Portfolios(contracts[uint256(CoreContracts.Portfolios)]).freeCollateral(account);

        // We must be undercollateralized overall and there must be a requirement for collaterlizing obligations in this currency.
        require(fc < 0 && currencyRequirement[currency] > 0, $$(ErrorCode(CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL)));
        address localCurrency = currencyGroups[currency].primary;

        // This amount represents the required amount of collateral for the currency. In this method, we will attempt
        // to ensure that there is no currencyRequirement for this currency after liquidating all of the account's
        // postively valued positions.
        uint128 shortfallRemaining = currencyRequirement[currency];

        // First we extract as much cash as we can out of the portfolio, we do not sell future cash in this method
        // because it is not taken into account in the free collateral calculation. This call will only attempt to
        // extract collateral held via liquidity tokens.
        shortfallRemaining = Portfolios(contracts[uint256(CoreContracts.Portfolios)]).extractCash(
            account,
            currency,
            shortfallRemaining,
            false
        );

        if (shortfallRemaining > 0) {
            // If there is still a shortfall remaining, we sell ETH collateral to msg.sender at a discount from the
            // oracle price.
            address collateralToken = currencyGroups[G_COLLATERAL_CURRENCY].primary;
            ExchangeRate memory er = exchangeRateOracles[localCurrency][collateralToken];
            uint128 shortfallToCover = shortfallRemaining;

            int256 answer = IAggregator(er.rateOracle).latestAnswer();
            require(answer > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

            // This represents the amount of collateral it will cost to cover the remaining shortfall along with
            // the discount that the liquidator is owed.
            uint256 collateralToTransfer = uint256(answer)
                .mul(shortfallRemaining)
                .div(Common.DECIMALS)
                .mul(G_LIQUIDATION_HAIRCUT)
                .div(Common.DECIMALS);

            uint256 collateralBalance = currencyBalances[collateralToken][account];
            if (collateralToTransfer > collateralBalance) {
                // The account does not have enough collateral to cover the shortfall along with the liquidation
                // haircut. At this point we transfer all the collateralBalance that we can to the liquidator.
                shortfallToCover = uint128(
                    collateralBalance
                        .mul(Common.DECIMALS)
                        .div(uint256(answer))
                        .mul(Common.DECIMALS)
                        .div(G_LIQUIDATION_HAIRCUT)
                );
                collateralToTransfer = collateralBalance;
            }

            // Transfer the collateral to the liquidator
            currencyBalances[collateralToken][account] = collateralBalance.sub(collateralToTransfer);
            currencyBalances[collateralToken][msg.sender] = currencyBalances[collateralToken][msg.sender].add(collateralToTransfer);

            // Remove the local currency from the liquidator
            currencyBalances[localCurrency][msg.sender] = currencyBalances[localCurrency][msg.sender].sub(shortfallToCover);

            shortfallRemaining = shortfallRemaining - shortfallToCover;
        }

        // We now use the collateral we've raised to close out the obligations on this account. It is possible
        // that we've raised more collateral than required to close out obligations and as a result we will
        // credit the unspent shortfall back to the liqudiated account.
        uint128 unspentShortfall = Portfolios(contracts[uint256(CoreContracts.Portfolios)]).closeObligations(
            account,
            currency,
            // This argument is the amount of obligation denominated in local currency that we can trade
            // out of.
            currencyRequirement[currency] - shortfallRemaining
        );

        currencyBalances[localCurrency][account] = currencyBalances[localCurrency][account].add(unspentShortfall);
    }

    /********** Settle Cash / Liquidation *************/

    /********** Internal Methods *********************/

    /**
     * @notice Liquidates collateral balances to the target currency on Uniswap.
     *
     * @param account the account that holds the collateral
     * @param targetCurrency the currency to trade into
     * @param amountToRaise the amount of the target currency to raise
     */
    function _sellCollateral(
        address account,
        uint16 targetCurrency,
        uint128 amountToRaise
    ) internal returns (uint128) {
        address primary = currencyGroups[targetCurrency].primary;
        address collateralToken = currencyGroups[G_COLLATERAL_CURRENCY].primary;
        ExchangeRate memory er = exchangeRateOracles[primary][collateralToken];

        uint256 amountRemaining = amountToRaise;
        // First determine how much local currency the collateral would trade for. If it is enough to cover the obligation then
        // we just trade for what is required. If not then we will trade all the collateral.
        uint256 collateralRequired = UniswapExchangeInterface(er.onChainExchange).getEthToTokenOutputPrice(
            amountRemaining
        );

        if (true) {
            // This is the rate implied by the trade on uniswap
            uint256 uniswapImpliedRate = collateralRequired.mul(Common.DECIMALS).div(amountRemaining);

            int256 answer = IAggregator(er.rateOracle).latestAnswer();
            require(answer > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

            uint256 rateDiff = uint256(
                answer
                    .sub(int256(uniswapImpliedRate))
                    .abs()
                    .mul(Common.DECIMALS)
                    .div(answer)
            );

            // We fail if the rate diff between the two exchanges is larger than the settlement haircut. This means that
            // there is an arbitrage opportunity for the receiver and we fail out here to protect the payer.
            require(rateDiff < uint256(G_SETTLEMENT_HAIRCUT).sub(Common.DECIMALS), $$(ErrorCode(CANNOT_SETTLE_PRICE_DISCREPENCY)));
        }

        uint256 collateralBalance = currencyBalances[collateralToken][account];
        if (collateralBalance > 0) {
            if (collateralBalance >= collateralRequired) {
                // This will trade exactly the amount of collateralRequired for exactly the target currency required.
                UniswapExchangeInterface(er.onChainExchange).ethToTokenSwapOutput.value(collateralRequired)(
                    amountRemaining,
                    block.timestamp
                    // solium-disable-previous-line security/no-block-members
                );

                // Reduce the collateral balance by the amount traded.
                currencyBalances[collateralToken][account] = collateralBalance - collateralRequired;
                amountRemaining = 0;
            } else {
                // In here we will sell off all the ETH that the account holds.
                uint256 amountTraded = UniswapExchangeInterface(er.onChainExchange).ethToTokenSwapInput.value(
                    collateralBalance
                )(1, block.timestamp);
                // solium-disable-previous-line security/no-block-members

                currencyBalances[collateralToken][account] = 0;
                amountRemaining = amountRemaining - amountTraded;
            }
        }

        return uint128(amountRemaining);
    }

    /**
     * @notice Internal method for calling free collateral.
     *
     * @param account the account to check free collateral for
     * @return amount of free collateral
     */
    function _freeCollateral(address account) internal returns (int256) {
        (int256 fc, /* uint128[] memory */) = Portfolios(contracts[uint256(CoreContracts.Portfolios)])
            .freeCollateral(account);
        return fc;
    }

    /**
     * @notice Converts a balance between token addresses.
     *
     * @param base base currency
     * @param quote quote currency
     * @param balance amount to convert
     * @param inverse if true, convert from quote to base
     * @return the converted balance
     */
    function _convert(
        address base,
        address quote,
        uint256 balance,
        bool inverse
    ) internal view returns (uint256) {
        ExchangeRate memory er = exchangeRateOracles[base][quote];

        // Fetches the latest answer from the chainlink oracle and haircut it by the apporpriate amount.
        int256 answer = IAggregator(er.rateOracle).latestAnswer();
        require(answer > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

        uint256 rate = uint256(answer)
            .mul(Common.DECIMALS)
            .div(er.haircut);

        if (inverse) {
            return balance.mul(Common.DECIMALS).div(rate);
        } else {
            return balance.mul(rate).div(Common.DECIMALS);
        }
    }
}
