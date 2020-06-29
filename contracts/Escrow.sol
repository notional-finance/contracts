pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./FutureCash.sol";

import "./utils/Governed.sol";
import "./lib/SafeInt256.sol";
import "./lib/SafeMath.sol";

import "./interface/IERC20.sol";
import "./interface/IERC777Recipient.sol";
import "./interface/IERC1820Registry.sol";
import "./interface/IAggregator.sol";
import "./interface/IEscrowCallable.sol";

import "./storage/EscrowStorage.sol";

/**
 * @title Escrow
 * @notice Manages a account balances for the entire system including deposits, withdraws,
 * cash balances, collateral lockup for trading, cash transfers (settlement), and liquidation.
 */
contract Escrow is EscrowStorage, Governed, IERC777Recipient, IEscrowCallable {
    using SafeMath for uint256;
    using SafeInt256 for int256;

    /**
     * @dev skip
     * @param directory reference to other contracts
     * @param registry ERC1820 registry for ERC777 token standard
     */
    function initialize(address directory, address registry) public initializer {
        Governed.initialize(directory);

        // This registry call is used for the ERC777 token standard.
        IERC1820Registry(registry).setInterfaceImplementer(address(0), TOKENS_RECIPIENT_INTERFACE_HASH, address(this));

        // List ETH as the zero currency and a deposit currency
        currencyIdToAddress[0] = G_ETH_CURRENCY;
        addressToCurrencyId[G_ETH_CURRENCY] = 0;
        depositCurrencies.push(0);
    }

    /********** Events *******************************/
    event NewTradableCurrency(address indexed token, uint16 currencyId);
    event NewDepositCurrency(address indexed token, uint16 currencyId);
    event UpdateExchangeRate(address indexed baseCurrency, address indexed quoteCurrency);
    event Deposit(address indexed currency, address account, uint256 value);
    event Withdraw(address indexed currency, address account, uint256 value);
    event Liquidate(address indexed currency, address liquidator, address account);
    /********** Events *******************************/

    /********** Governance Settings ******************/

    /**
     * @notice Sets discounts applied when purchasing collateral during liquidation or settlement
     * @dev governance
     * @param liquidation discount applied to liquidation
     * @param settlement discount applied to settlement
     */
    function setDiscounts(uint128 liquidation, uint128 settlement) external onlyOwner {
        G_LIQUIDATION_DISCOUNT = liquidation;
        G_SETTLEMENT_DISCOUNT = settlement;
    }

    /**
     * @notice Sets the reserve account used to settle against for insolvent accounts
     * @dev governance
     * @param account address of reserve account
     */
    function setReserveAccount(address account) external onlyOwner {
        G_RESERVE_ACCOUNT = account;
    }

    /**
     * @notice Lists a new currency that can be traded in future cash markets
     * @dev governance
     * @param token address of the ERC20 or ERC777 token
     */
    function listTradableCurrency(address token) external onlyOwner {
        _listCurrency(token);
        emit NewTradableCurrency(token, maxCurrencyId);
    }

    /**
     * @notice Lists a new currency that can only be used to collateralize `CASH_PAYER` tokens
     * @dev governance
     * @param token address of the ERC20 or ERC777 token
     */
    function listDepositCurrency(address token) external onlyOwner {
        _listCurrency(token);
        depositCurrencies.push(maxCurrencyId);

        emit NewDepositCurrency(token, maxCurrencyId);
    }

    function _listCurrency(address token) internal {
        maxCurrencyId++;
        // We don't do a lot of checking here but since this is purely an administrative
        // activity we just rely on governance not to set this improperly.
        currencyIdToAddress[maxCurrencyId] = token;
        addressToCurrencyId[token] = maxCurrencyId;
        // We need to set this number so that the free collateral check can provision
        // the right number of currencies.
        Portfolios().setNumCurrencies(maxCurrencyId);
    }

    /**
     * @notice Creates an exchange rate between two currencies.
     * @dev governance
     * @param base the base currency
     * @param quote the quote currency
     * @param rateOracle the oracle that will give the exchange rate between the two
     * @param onChainExchange uniswap exchange for trustless exchange
     * @param haircut multiple to apply to the exchange rate that sets the collateralization ratio
     */
    function addExchangeRate(
        uint16 base,
        uint16 quote,
        address rateOracle,
        address onChainExchange,
        uint128 haircut
    ) external onlyOwner {
        address baseCurrency = currencyIdToAddress[base];
        address quoteCurrency = currencyIdToAddress[quote];
        exchangeRateOracles[baseCurrency][quoteCurrency] = ExchangeRate(
            rateOracle,
            onChainExchange,
            haircut
        );

        emit UpdateExchangeRate(baseCurrency, quoteCurrency);
    }
    /********** Governance Settings ******************/

    /********** Getter Methods ***********************/

    /**
     * @notice Evaluates whether or not a currency id is valid
     * @param currency currency id
     * @return true if the currency is valid
     */
    function isValidCurrency(uint16 currency) public view returns (bool) {
        return currency <= maxCurrencyId;
    }

    /**
     * @notice Evaluates whether or not a currency can be traded
     * @param currency currency id
     * @return true if the currency is tradable
     */
    function isTradableCurrency(uint16 currency) public override view returns (bool) {
        if (!isValidCurrency(currency)) return false;

        for (uint256 i; i < depositCurrencies.length; i++) {
            if (depositCurrencies[i] == currency) return false;
        }

        return true;
    }

    /**
     * @notice Evaluates whether or not a currency can be used as collateral
     * @param currency currency id
     * @return true if the currency is a deposit currency
     */
    function isDepositCurrency(uint16 currency) public view returns (bool) {
        if (!isValidCurrency(currency)) return false;

        for (uint256 i; i < depositCurrencies.length; i++) {
            if (depositCurrencies[i] == currency) return true;
        }

        return false;
    }

    /**
     * @notice Getter method for exchange rates
     * @param base token address for the base currency
     * @param quote token address for the quote currency
     * @return ExchangeRate struct
     */
    function getExchangeRate(address base, address quote) external view returns (ExchangeRate memory) {
        return exchangeRateOracles[base][quote];
    }

    /**
     * @notice Returns the net balances of all the currencies owned by an account as
     * an array. Each index of the array refers to the currency id.
     * @param account the account to query
     * @return the balance of each currency net of the account's cash position
     */
    function getNetBalances(
        address account
    ) public override view returns (Common.AccountBalance[] memory) {
        // We add one here because the zero currency index is unused
        Common.AccountBalance[] memory balances = new Common.AccountBalance[](maxCurrencyId + 1);

        for (uint256 i; i < balances.length; i++) {
            balances[i].netBalance = getNetBalanceOfCurrency(account, uint16(i));
        }

        for (uint256 i; i < depositCurrencies.length; i++) {
            balances[depositCurrencies[i]].isDepositCurrency = true;
        }

        return balances;
    }

    /**
     * @notice Returns the net balance denominated in the currency for an account. This balance
     * may be less than zero due to negative cash balances.
     * @param account to get the balance for
     * @param currency currency id
     * @return the net balance of the currency
     */
    function getNetBalanceOfCurrency(address account, uint16 currency) public view returns (int256) {
        address token = currencyIdToAddress[currency];
        uint256 balance = currencyBalances[token][account];

        return int256(balance).add(cashBalances[currency][account]);
    }

    /**
     * @notice Converts the balances given to ETH for the purposes of determining whether an account has
     * sufficient free collateral.
     * @param amounts the balance in each currency group as an array, each index refers to the currency group id.
     * @return an array the same length as amounts with each balance denominated in ETH
     */
    function convertBalancesToETH(
        uint128[] memory amounts
    ) public override view returns (uint128[] memory) {
        // We expect values for all currencies to be supplied here, we will not do any work on 0 balances.
        require(amounts.length == maxCurrencyId + 1, $$(ErrorCode(INVALID_CURRENCY)));
        uint128[] memory results = new uint128[](amounts.length);

        // Currency ID = 0 is already ETH so we don't need to convert it
        results[0] = amounts[0];
        for (uint256 i = 1; i < amounts.length; i++) {
            if (amounts[i] == 0) continue;

            address base = currencyIdToAddress[uint16(i)];
            results[i] = uint128(_convertToETHWithHaircut(base, amounts[i]));
        }

        return results;
    }

    /********** Getter Methods ***********************/

    /********** Withdraw / Deposit Methods ***********/

    /**
     * @notice This is a special function to handle ETH deposits. Value of ETH to be deposited must be specified in `msg.value`
     */
    function depositEth() public payable {
        require(msg.value <= Common.MAX_UINT_128, $$(ErrorCode(OVER_MAX_ETH_BALANCE)));
        currencyBalances[G_ETH_CURRENCY][msg.sender] = currencyBalances[G_ETH_CURRENCY][msg.sender].add(uint128(msg.value));

        emit Deposit(G_ETH_CURRENCY, msg.sender, msg.value);
    }

    /**
     * @notice Withdraw ETH from the contract.
     * @dev We do not use `msg.sender.transfer` or `msg.sender.send` as recommended by Consensys:
     * https://diligence.consensys.net/blog/2019/09/stop-using-soliditys-transfer-now/
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

        emit Withdraw(G_ETH_CURRENCY, msg.sender, amount);
    }

    /**
     * @notice Transfers a balance from an ERC20 token contract into the Escrow.
     * @param token token contract to send from
     * @param amount tokens to transfer
     */
    function deposit(address token, uint256 amount) external {
        address to = msg.sender;
        uint16 currencyGroupId = addressToCurrencyId[token];
        require(currencyGroupId != 0, $$(ErrorCode(INVALID_CURRENCY)));

        currencyBalances[token][to] = currencyBalances[token][to].add(amount);
        IERC20(token).transferFrom(to, address(this), amount);

        emit Deposit(token, msg.sender, amount);
    }

    /**
     * @notice Receives tokens from an ERC777 send message.
     * @dev skip
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
        uint16 currencyGroupId = addressToCurrencyId[msg.sender];
        require(currencyGroupId != 0, $$(ErrorCode(INVALID_CURRENCY)));
        currencyBalances[msg.sender][from] = currencyBalances[msg.sender][from].add(amount);

        emit Deposit(msg.sender, from, amount);
    }

    /**
     * @notice Withdraws from an account's collateral holdings back to their account. Checks if the
     * account has sufficient free collateral after the withdraw or else it fails.
     * @param token collateral type to withdraw
     * @param amount total value to withdraw
     */
    function withdraw(address token, uint256 amount) external {
        address to = msg.sender;
        require(currencyBalances[token][to] >= amount, $$(ErrorCode(INSUFFICIENT_BALANCE)));
        require(token != address(0), $$(ErrorCode(INVALID_CURRENCY)));

        currencyBalances[token][to] = currencyBalances[token][to].sub(amount);

        // We're checking this after the withdraw has been done on currency balances.
        require(_freeCollateral(to) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
        IERC20(token).transfer(to, amount);

        emit Withdraw(token, to, amount);
    }

    /********** Withdraw / Deposit Methods ***********/

    /********** Collateral / Cash Management *********/

    /**
     * @notice Transfers the collateral required between the Future Cash Market and the specified account. Collateral
     * held by the Future Cash Market is available to purchase in the liquidity pools.
     * @dev skip
     * @param account the account to withdraw collateral from
     * @param collateralToken the address of the token to use as collateral
     * @param instrumentGroupId the instrument group used to authenticate the future cash market
     * @param value the amount of collateral to deposit
     * @param fee the amount of `value` to pay as a fee
     */
    function depositIntoMarket(
        address account,
        address collateralToken,
        uint8 instrumentGroupId,
        uint128 value,
        uint128 fee
    ) public override {
        // Only the future cash market is allowed to call this function.
        Common.InstrumentGroup memory ig = Portfolios().getInstrumentGroup(instrumentGroupId);
        require(msg.sender == ig.futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        if (fee > 0) {
            currencyBalances[collateralToken][G_RESERVE_ACCOUNT] = currencyBalances[collateralToken][G_RESERVE_ACCOUNT].add(fee);
        }

        currencyBalances[collateralToken][msg.sender] = currencyBalances[collateralToken][msg.sender].add(value);
        currencyBalances[collateralToken][account] = currencyBalances[collateralToken][account].sub(value + fee);
    }

    /**
     * @notice Transfers the collateral required between the Future Cash Market and the specified account. Collateral
     * held by the Future Cash Market is available to purchase in the liquidity pools.
     * @dev skip
     * @param account the account to withdraw collateral from
     * @param collateralToken the address of the token to use as collateral
     * @param instrumentGroupId the instrument group used to authenticate the future cash market
     * @param value the amount of collateral to deposit
     * @param fee the amount of `value` to pay as a fee
     */
    function withdrawFromMarket(
        address account,
        address collateralToken,
        uint8 instrumentGroupId,
        uint128 value,
        uint128 fee
    ) public override {
        // Only the future cash market is allowed to call this function.
        Common.InstrumentGroup memory ig = Portfolios().getInstrumentGroup(instrumentGroupId);
        require(msg.sender == ig.futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        if (fee > 0) {
            currencyBalances[collateralToken][G_RESERVE_ACCOUNT] = currencyBalances[collateralToken][G_RESERVE_ACCOUNT].add(fee);
        }

        currencyBalances[collateralToken][account] = currencyBalances[collateralToken][account].add(value - fee);
        currencyBalances[collateralToken][msg.sender] = currencyBalances[collateralToken][msg.sender].sub(value);
    }

    /**
     * @notice Adds or removes collateral from the future cash market when the portfolio is trading positions
     * as a result of settlement or liquidation.
     * @dev skip
     * @param currency the currency group of the collateral
     * @param futureCashMarket the address of the future cash market to transfer between
     * @param amount the amount to transfer
     */
    function unlockCollateral(
        uint16 currency,
        address futureCashMarket,
        int256 amount
    ) public override {
        require(calledByPortfolios(), $$(ErrorCode(UNAUTHORIZED_CALLER)));
        address token = currencyIdToAddress[currency];

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
     * @dev skip
     * @param account account where the cash is settled
     * @param settledCash an array of the currency groups that need to have their cash balance updated
     */
    function portfolioSettleCash(address account, int256[] memory settledCash) public override {
        require(calledByPortfolios(), $$(ErrorCode(UNAUTHORIZED_CALLER)));
        // Since we are using the indexes to refer to the currency group ids, the length must be less than
        // or equal to the total number of group ids currently used plus the zero currency which is unused.
        require(settledCash.length == maxCurrencyId + 1, $$(ErrorCode(INVALID_CURRENCY)));

        for (uint256 i = 0; i < settledCash.length; i++) {
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
     * @param currency the currency group to settle
     * @param payers the party that has a negative cash balance and will transfer collateral to the receiver
     * @param receivers the party that has a positive cash balance and will receive collateral from the payer
     * @param values the amount of collateral to transfer
     */
    function settleCashBalanceBatch(
        uint16 currency,
        uint16 depositCurrency,
        address[] calldata payers,
        address[] calldata receivers,
        uint128[] calldata values
    ) external {
        // TODO: should we de-duplicate these arrays?
        Portfolios().settleAccountBatch(payers);
        Portfolios().settleAccountBatch(receivers);
        require(isDepositCurrency(depositCurrency), $$(ErrorCode(INVALID_CURRENCY)));
        address depositToken = currencyIdToAddress[depositCurrency];

        for (uint256 i; i < payers.length; i++) {
            _settleCashBalance(currency, depositToken, payers[i], receivers[i], values[i]);
        }
    }

    /**
     * @notice Settles the cash balance between the payer and the receiver.
     * @param currency the currency group to settle
     * @param depositCurrency the deposit currency to sell to cover
     * @param payer the party that has a negative cash balance and will transfer collateral to the receiver
     * @param receiver the party that has a positive cash balance and will receive collateral from the payer
     * @param value the amount of collateral to transfer
     */
    function settleCashBalance(
        uint16 currency,
        uint16 depositCurrency,
        address payer,
        address receiver,
        uint128 value
    ) external {
        // We must always ensure that accounts are settled when we settle cash balances because
        // matured trades that are not converted to cash may cause the _settleCashBalance function
        // to trip into settling with the reserve account.
        address[] memory accounts = new address[](2);
        accounts[0] = payer;
        accounts[1] = receiver;
        Portfolios().settleAccountBatch(accounts);
        require(isDepositCurrency(depositCurrency), $$(ErrorCode(INVALID_CURRENCY)));
        address depositToken = currencyIdToAddress[depositCurrency];

        _settleCashBalance(currency, depositToken, payer, receiver, value);
    }

    /**
     * @notice Settles the cash balance between the payer and the receiver.
     * @param currency the currency group to settle
     * @param depositToken the deposit currency to sell to cover
     * @param payer the party that has a negative cash balance and will transfer collateral to the receiver
     * @param receiver the party that has a positive cash balance and will receive collateral from the payer
     * @param value the amount of collateral to transfer
     */
    function _settleCashBalance(
        uint16 currency,
        address depositToken,
        address payer,
        address receiver,
        uint128 value
    ) internal {
        require(payer != receiver, $$(ErrorCode(COUNTERPARTY_CANNOT_BE_SELF)));
        require(isValidCurrency(currency), $$(ErrorCode(INVALID_CURRENCY)));
        if (value == 0) return;

        // This cash account must have enough negative cash to settle against
        require(cashBalances[currency][payer] <= int256(value).neg(), $$(ErrorCode(INCORRECT_CASH_BALANCE)));
        // The receiver must have enough cash balance to settle
        require(cashBalances[currency][receiver] >= int256(value), $$(ErrorCode(INCORRECT_CASH_BALANCE)));

        address localCurrencyToken = currencyIdToAddress[currency];
        // This is a reference to the total balance that the payer has in the local currency.
        uint256 localCurrencyBalance = currencyBalances[localCurrencyToken][payer];
        uint128 settledAmount = value;

        if (localCurrencyBalance >= value) {
            // In this case we are just paying the receiver directly out of the currency balance
            currencyBalances[localCurrencyToken][payer] = currencyBalances[localCurrencyToken][payer].sub(value);
        } else {
            // Inside this if statement, the payer does not have enough local currency to settle their obligation.
            // First we will spend all of their collateral balance to settle their obligations before proceeding.
            delete currencyBalances[localCurrencyToken][payer];

            // If the payer does not have enough collateral to cover the value of the cash settlement, we have a
            // two options here:
            // 1. We attempt to extract cash from the portfolio (we do not know if there is any at this point)
            // 2. If there is still obligations remaining after we extract cash, we then check their free collateral.
            //   - If there is sufficient free collateral, we trade their ETH for local currency, either via uniswap
            //     or via exchange with the msg.sender
            //   - If there is not sufficient collateral, the payer account must be liquidated. However, we still
            //     settle out as much of their obligation as we can without liquidation.

            // The remaining amount of collateral that we need to raise from the account to cover its obligation.
            uint128 localCurrencyRequired = value - uint128(localCurrencyBalance);

            // It's unclear here that this call will actually be able to extract any cash, but must attempt to do
            // this anyway. This action cannot result in the payer ending up under collateralized. Since we do not
            // sell future cash in this call, localCurrencyRequired will always be greater than or equal to zero after
            // this call returns.
            localCurrencyRequired = Portfolios().raiseCollateralViaLiquidityToken(payer, currency, localCurrencyRequired);

            // Extract cash did not cover the local currency required, we must sell collateral.
            if (localCurrencyRequired > 0) {
                settledAmount = _sellCollateralToSettleCash(
                    payer,
                    receiver,
                    localCurrencyToken,
                    localCurrencyRequired,
                    depositToken,
                    value
                );
            }
        }

        // Net out cash balances, the payer no longer owes this cash. The receiver is no longer owed this cash.
        cashBalances[currency][payer] = cashBalances[currency][payer].add(settledAmount);
        cashBalances[currency][receiver] = cashBalances[currency][receiver].sub(settledAmount);

        // Transfer the required amount to the receiver
        currencyBalances[localCurrencyToken][receiver] = currencyBalances[localCurrencyToken][receiver].add(settledAmount);
    }

    /**
     * @notice Liquidates a batch of accounts in a specific currency.
     * @param accounts the account to liquidate
     * @param currency the currency that is undercollateralized
     * @param depositCurrency the deposit currency to exchange for `currency`
     */
    function liquidateBatch(address[] calldata accounts, uint16 currency, uint16 depositCurrency) external {
        require(isDepositCurrency(depositCurrency), $$(ErrorCode(INVALID_CURRENCY)));
        address depositToken = currencyIdToAddress[depositCurrency];

        for (uint256 i; i < accounts.length; i++) {
            _liquidate(accounts[i], currency, depositToken);
        }
    }

    /**
     * @notice Liquidates a single account if it is undercollateralized
     * @param account the account to liquidate
     * @param currency the currency that is undercollateralized
     * @param depositCurrency the deposit currency to exchange for `currency`
     */
    function liquidate(address account, uint16 currency, uint16 depositCurrency) external {
        require(isDepositCurrency(depositCurrency), $$(ErrorCode(INVALID_CURRENCY)));
        address depositToken = currencyIdToAddress[depositCurrency];

        _liquidate(account, currency, depositToken);
    }

    function _liquidate(address account, uint16 currency, address depositToken) internal {
        int256 fc;
        uint128[] memory currencyRequirement;

        (fc, currencyRequirement) = Portfolios().freeCollateral(account);

        // We must be undercollateralized overall and there must be a requirement for collaterlizing obligations in this currency.
        require(fc < 0 && currencyRequirement[currency] > 0, $$(ErrorCode(CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL)));
        address localCurrencyToken = currencyIdToAddress[currency];

        // This amount represents the required amount of collateral for the currency. In this method, we will attempt
        // to ensure that there is no currencyRequirement for this currency after liquidating all of the account's
        // postively valued positions.
        uint128 localCurrencyRequired = currencyRequirement[currency];

        // First we extract as much cash as we can out of the portfolio, we do not sell future cash in this method
        // because it is not taken into account in the free collateral calculation. This call will only attempt to
        // extract collateral held via liquidity tokens.
        localCurrencyRequired = Portfolios().raiseCollateralViaLiquidityToken(account, currency, localCurrencyRequired);

        if (localCurrencyRequired > 0) {
            // If liquidity tokens have not recollateralized the account, we allow the caller to purchase
            // collateral from the account at `G_LIQUIDATION_DISCOUNT`. Partial liquidation is okay in this
            // scenario.
            uint128 localCurrencyRaised = _purchaseCollateralForLocalCurrency(
                account,
                localCurrencyToken,
                localCurrencyRequired,
                G_LIQUIDATION_DISCOUNT,
                depositToken,
                true
            );
            localCurrencyRequired = localCurrencyRequired - localCurrencyRaised;
        }

        // We now use the collateral we've raised to close out the obligations on this account. It is possible
        // that we've raised more collateral than required to close out obligations and as a result we will
        // credit the unspent shortfall back to the liqudiated account.
        uint128 unspentShortfall = Portfolios().repayCashPayer(
            account,
            currency,
            // This argument is the amount of obligation denominated in local currency that we can trade
            // out of.
            currencyRequirement[currency] - localCurrencyRequired
        );

        currencyBalances[localCurrencyToken][account] = currencyBalances[localCurrencyToken][account].add(unspentShortfall);

        emit Liquidate(localCurrencyToken, msg.sender, account);
    }

    /********** Settle Cash / Liquidation *************/

    /********** Internal Methods *********************/

    function _sellCollateralToSettleCash(
        address payer,
        address receiver,
        address localCurrencyToken,
        uint128 localCurrencyRequired,
        address depositToken,
        uint128 valueToSettle
    ) internal returns (uint128) {
        // When we calculate free collateral here we need to add back in the value that we've extracted to ensure that the
        // free collateral calculation returns the appropriate value.
        int256 freeCollateral = _freeCollateral(payer)
            .add(int256(_convertToETHWithHaircut(localCurrencyToken, valueToSettle - localCurrencyRequired)));

        if (freeCollateral >= 0) {
            if (msg.sender == receiver) {
                // If the sender is the receiver then someone is attempting to settle the cash that they are owed.
                // For this, we attempt to sell the collateral on Uniswap so that the receiver can have a purely
                // on chain interaction.
                _tradeCollateralOnExchange(
                    payer,
                    localCurrencyToken,
                    depositToken,
                    localCurrencyRequired
                );
            } else {
                _purchaseCollateralForLocalCurrency(
                    payer,
                    localCurrencyToken,
                    localCurrencyRequired,
                    G_SETTLEMENT_DISCOUNT,
                    depositToken,
                    false
                );
            }

            return valueToSettle;
        } else {
            if (!_hasCollateral(payer)) {
                // This call will attempt to sell future cash tokens in return for local currency. We do this as a last ditch effort
                // before we dip into reserves. The free collateral position will not change as a result of this method since positive
                // future cash (in this version) does not affect free collateral.
                uint16 currencyId = addressToCurrencyId[localCurrencyToken];
                uint128 cashShortfall = Portfolios().raiseCollateralViaCashReceiver(payer, currencyId, localCurrencyRequired);

                if (cashShortfall > 0 && _isInsolvent(payer)) {
                    // At this point, the portfolio has no positive future value associated with it and no collateral. It
                    // the account is completely insolvent and therfore we need to pay out the remaining obligation from the
                    // reserve account.
                    currencyBalances[localCurrencyToken][G_RESERVE_ACCOUNT] = currencyBalances[localCurrencyToken][G_RESERVE_ACCOUNT].sub(cashShortfall);
                    return valueToSettle;
                }

                return valueToSettle - cashShortfall;
            } else {
                // Here we are trying to settle cash against an undercollateralized account. What we do here is settle the max
                // amount of collateral we can at this point. The remaining value can be settled after liquidation.
                return valueToSettle - localCurrencyRequired;
            }
        }
    }

    /**
     * @notice Exchanges collateral for specified local currency at a discount
     */
    function _purchaseCollateralForLocalCurrency(
        address payer,
        address localCurrencyToken,
        uint128 localCurrencyRequired,
        uint128 discountFactor,
        address depositToken,
        bool canSellPartial
    ) internal returns (uint128) {
        // If the msg sender does not equal the receiver, then it is settling the position on behalf
        // of the receiver. In this case, the msg.sender can purchase the ETH from the payer at a small
        // discount from the oracle price for their service.

        uint256 rate = _exchangeRate(localCurrencyToken, depositToken);

        uint128 localCurrencyPurchased = localCurrencyRequired;
        uint256 collateralToPurchase = rate
            .mul(localCurrencyPurchased)
            .div(Common.DECIMALS)
            .mul(discountFactor)
            .div(Common.DECIMALS);
        uint256 collateralBalance = currencyBalances[depositToken][payer];

        if (collateralToPurchase > collateralBalance) {
            require(canSellPartial, $$(ErrorCode(INSUFFICIENT_COLLATERAL_BALANCE)));
            localCurrencyPurchased = uint128(
                collateralBalance
                    .mul(Common.DECIMALS)
                    .div(rate)
                    .mul(Common.DECIMALS)
                    .div(discountFactor)
            );
            collateralToPurchase = collateralBalance;
        }

        // Transfer the collateral between accounts. The msg.sender must have enough to cover the collateral
        // remaining at this point.
        currencyBalances[localCurrencyToken][msg.sender] = currencyBalances[localCurrencyToken][msg.sender].sub(localCurrencyPurchased);

        // Transfer the collateral currency between accounts
        currencyBalances[depositToken][msg.sender] = currencyBalances[depositToken][msg.sender].add(collateralToPurchase);
        // We expect the payer to have enough here because they passed the free collateral check.
        currencyBalances[depositToken][payer] = currencyBalances[depositToken][payer].sub(collateralToPurchase);

        return localCurrencyPurchased;
    }

    /**
     * @notice Liquidates collateral balances to the target currency on Uniswap.
     *
     * @param account the account that holds the collateral
     * @param targetToken the currency to trade into
     * @param amountToRaise the amount of the target currency to raise
     */
    function _tradeCollateralOnExchange(
        address account,
        address targetToken,
        address depositToken,
        uint128 amountToRaise
    ) internal {
        ExchangeRate memory er = exchangeRateOracles[targetToken][depositToken];
        require(er.onChainExchange != address(0), $$(ErrorCode(NO_EXCHANGE_LISTED_FOR_PAIR)));

        uint256 amountRemaining = amountToRaise;
        // First determine how much local currency the collateral would trade for. If it is enough to cover the obligation then
        // we just trade for what is required. If not then we will trade all the collateral.
        uint256 collateralRequired = UniswapExchangeInterface(er.onChainExchange).getEthToTokenOutputPrice(
            amountRemaining
        );

        _checkUniswapRateDifference(amountRemaining, collateralRequired, er.rateOracle);

        uint256 collateralBalance = currencyBalances[depositToken][account];
        require(collateralBalance >= collateralRequired, $$(ErrorCode(INSUFFICIENT_COLLATERAL_FOR_SETTLEMENT)));
        // This will trade exactly the amount of collateralRequired for exactly the target currency required.
        UniswapExchangeInterface(er.onChainExchange).ethToTokenSwapOutput.value(collateralRequired)(
            amountRemaining,
            block.timestamp
            // solium-disable-previous-line security/no-block-members
        );

        // Reduce the collateral balance by the amount traded.
        currencyBalances[depositToken][account] = collateralBalance - collateralRequired;
    }

    /**
     * @notice Checks the rate difference between the on chain oracle and uniswap to ensure
     * that there is no price manipulation
     *
     * @param baseAmount amount of base currency to purchase
     * @param quoteAmount amount of quote currency to sell
     * @param rateOracle address of the chainlink rate oracle
     */
    function _checkUniswapRateDifference(
        uint256 baseAmount,
        uint256 quoteAmount,
        address rateOracle
    ) internal view {
        // This is the rate implied by the trade on uniswap
        uint256 uniswapImpliedRate = quoteAmount.mul(Common.DECIMALS).div(baseAmount);

        int256 answer = IAggregator(rateOracle).latestAnswer();
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
        require(rateDiff < uint256(G_SETTLEMENT_DISCOUNT).sub(Common.DECIMALS), $$(ErrorCode(CANNOT_SETTLE_PRICE_DISCREPENCY)));
    }

    /**
     * @notice Internal method for calling free collateral.
     *
     * @param account the account to check free collateral for
     * @return amount of free collateral
     */
    function _freeCollateral(address account) internal returns (int256) {
        (int256 fc, /* uint128[] memory */) = Portfolios().freeCollateral(account);
        return fc;
    }

    /**
     * @notice Converts a balance between token addresses.
     *
     * @param base base currency
     * @param balance amount to convert
     * @return the converted balance
     */
    function _convertToETHWithHaircut(
        address base,
        uint256 balance
    ) internal view returns (uint256) {
        ExchangeRate memory er = exchangeRateOracles[base][G_ETH_CURRENCY];

        // Fetches the latest answer from the chainlink oracle and haircut it by the apporpriate amount.
        int256 answer = IAggregator(er.rateOracle).latestAnswer();
        require(answer > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

        uint256 rate = uint256(answer)
            .mul(er.haircut)
            .div(Common.DECIMALS);

        return balance.mul(rate).div(Common.DECIMALS);
    }

    function _exchangeRate(
        address base,
        address quote
    ) internal view returns (uint256) {
        ExchangeRate memory er = exchangeRateOracles[base][G_ETH_CURRENCY];

        int256 rate = IAggregator(er.rateOracle).latestAnswer();
        require(rate > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

        if (quote != G_ETH_CURRENCY) {
            ExchangeRate memory quoteER = exchangeRateOracles[quote][G_ETH_CURRENCY];

            int256 quoteRate = IAggregator(quoteER.rateOracle).latestAnswer();
            require(quoteRate > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

            rate = rate.mul(Common.DECIMALS).div(quoteRate);
        }

        return uint256(rate);
    }

    function _hasCollateral(address account) internal returns (bool) {
        for(uint256 i; i < depositCurrencies.length; i++) {
            if (currencyBalances[currencyIdToAddress[depositCurrencies[i]]][account] > 0) {
                return true;
            }
        }

        return false;
    }

    function _isInsolvent(address account) internal returns (bool) {
        if (_hasCollateral(account)) return false;

        Common.Trade[] memory portfolio = Portfolios().getTrades(account);
        for (uint256 i; i < portfolio.length; i++) {
            if (Common.isReceiver(portfolio[i].swapType)) {
                return false;
            }
        }

        return true;
    }
}