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
import "./interface/IWETH.sol";
import "./interface/IUniswapV2Router02.sol";

import "./storage/EscrowStorage.sol";

/**
 * @title Escrow
 * @notice Manages a account balances for the entire system including deposits, withdraws,
 * cash balances, collateral lockup for trading, cash transfers (settlement), and liquidation.
 */
contract Escrow is EscrowStorage, Governed, IERC777Recipient, IEscrowCallable {
    using SafeMath for uint256;
    using SafeInt256 for int256;

    uint256 private constant UINT256_MAX = 2**256 - 1;

    /**
     * @dev skip
     * @param directory reference to other contracts
     * @param registry ERC1820 registry for ERC777 token standard
     */
    function initialize(
        address directory,
        address registry,
        address weth,
        address router
    ) public initializer {
        Governed.initialize(directory);

        // This registry call is used for the ERC777 token standard.
        IERC1820Registry(registry).setInterfaceImplementer(address(0), TOKENS_RECIPIENT_INTERFACE_HASH, address(this));

        // Uniswap Router is used for pricing token swaps
        UNISWAP_ROUTER = router;

        // List ETH as the zero currency and a deposit currency
        WETH = weth;
        currencyIdToAddress[0] = WETH;
        addressToCurrencyId[WETH] = 0;
        depositCurrencies.push(0);
        emit NewDepositCurrency(WETH);
    }

    /********** Events *******************************/

    /**
     * @notice A new tradable currency
     * @param token address of the tradable token
     */
    event NewTradableCurrency(address indexed token);

    /**
     * @notice A new deposit currency
     * @param token address of the deposit token
     */
    event NewDepositCurrency(address indexed token);

    /**
     * @notice A new exchange rate between two currencies
     * @param baseToken address of the base token
     * @param quoteToken address of the quote token
     */
    event UpdateExchangeRate(address indexed baseToken, address indexed quoteToken);

    /**
     * @notice Notice of a deposit made to an account
     * @param currency currency id of the deposit
     * @param account address of the account where the deposit was made
     * @param value amount of tokens deposited
     */
    event Deposit(uint16 indexed currency, address account, uint256 value);

    /**
     * @notice Notice of a withdraw from an account
     * @param currency currency id of the withdraw
     * @param account address of the account where the withdraw was made
     * @param value amount of tokens withdrawn
     */
    event Withdraw(uint16 indexed currency, address account, uint256 value);

    /**
     * @notice Notice of a successful liquidation. `msg.sender` will be the liquidator.
     * @param localCurrency currency that was liquidated
     * @param depositCurrency currency that was exchanged for the local currency
     * @param account the account that was liquidated
     */
    event Liquidate(uint16 indexed localCurrency, uint16 depositCurrency, address account, uint128 amountLiquidated);

    /**
     * @notice Notice of a successful batch liquidation. `msg.sender` will be the liquidator.
     * @param localCurrency currency that was liquidated
     * @param depositCurrency currency that was exchanged for the local currency
     * @param accounts the accounts that were liquidated
     */
    event LiquidateBatch(
        uint16 indexed localCurrency,
        uint16 depositCurrency,
        address[] accounts,
        uint128[] amountLiquidated
    );

    /**
     * @notice Notice of a successful cash settlement. `msg.sender` will be the settler.
     * @param localCurrency currency that was settled
     * @param depositCurrency currency that was exchanged for the local currency
     * @param payer the account that paid in the settlement
     * @param receiver the account that received in the settlement
     * @param settledAmount the amount settled between the parties
     */
    event SettleCash(
        uint16 localCurrency,
        uint16 depositCurrency,
        address indexed payer,
        address indexed receiver,
        uint128 settledAmount
    );

    /**
     * @notice Notice of a successful batch cash settlement. `msg.sender` will be the settler.
     * @param localCurrency currency that was settled
     * @param depositCurrency currency that was exchanged for the local currency
     * @param payers the accounts that paid in the settlement
     * @param receivers the accounts that received in the settlement
     * @param settledAmounts the amounts settled between the parties
     */
    event SettleCashBatch(
        uint16 localCurrency,
        uint16 depositCurrency,
        address[] payers,
        address[] receivers,
        uint128[] settledAmounts
    );

    /**
     * @notice Emitted when liquidation and settlement discounts are set
     * @param liquidationDiscount discount given to liquidators when purchasing collateral
     * @param settlementDiscount discount given to settlers when purchasing collateral
     */
    event SetDiscounts(uint128 liquidationDiscount, uint128 settlementDiscount);

    /**
     * @notice Emitted when reserve account is set
     * @param reserveAccount account that holds balances in reserve
     */
    event SetReserve(address reserveAccount);

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

        emit SetDiscounts(liquidation, settlement);
    }

    /**
     * @notice Sets the reserve account used to settle against for insolvent accounts
     * @dev governance
     * @param account address of reserve account
     */
    function setReserveAccount(address account) external onlyOwner {
        G_RESERVE_ACCOUNT = account;

        emit SetReserve(account);
    }

    /**
     * @notice Lists a new currency that can be traded in future cash markets
     * @dev governance
     * @param token address of the ERC20 or ERC777 token
     */
    function listTradableCurrency(address token) external onlyOwner {
        _listCurrency(token);
        emit NewTradableCurrency(token);
    }

    /**
     * @notice Lists a new currency that can only be used to collateralize `CASH_PAYER` tokens
     * @dev governance
     * @param token address of the ERC20 or ERC777 token
     */
    function listDepositCurrency(address token) external onlyOwner {
        _listCurrency(token);
        depositCurrencies.push(maxCurrencyId);

        emit NewDepositCurrency(token);
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
     * @param uniswapPath path between uniswap exchanges
     * @param haircut multiple to apply to the exchange rate that sets the collateralization ratio
     */
    function addExchangeRate(
        uint16 base,
        uint16 quote,
        address rateOracle,
        address[] calldata uniswapPath,
        uint128 haircut
    ) external onlyOwner {
        address baseCurrency = currencyIdToAddress[base];
        address quoteCurrency = currencyIdToAddress[quote];
        exchangeRateOracles[baseCurrency][quoteCurrency] = ExchangeRate(
            rateOracle,
            haircut,
            uniswapPath
        );

        // Give the UNISWAP_ROUTER approval to transfer as much currency as we need.
        IERC20(baseCurrency).approve(UNISWAP_ROUTER, UINT256_MAX);
        IERC20(quoteCurrency).approve(UNISWAP_ROUTER, UINT256_MAX);

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
    function getNetBalances(address account) public override view returns (Common.AccountBalance[] memory) {
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
     * @dev - INVALID_CURRENCY: length of the amounts array must match the total number of currencies
     *  - INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0
     * @param amounts the balance in each currency group as an array, each index refers to the currency group id.
     * @return an array the same length as amounts with each balance denominated in ETH
     */
    function convertBalancesToETH(uint128[] memory amounts) public override view returns (uint128[] memory) {
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
     * @dev - OVER_MAX_ETH_BALANCE: balance of deposit cannot overflow uint128
     */
    function depositEth() public payable {
        require(msg.value <= Common.MAX_UINT_128, $$(ErrorCode(OVER_MAX_ETH_BALANCE)));
        IWETH(WETH).deposit.value(msg.value)();

        currencyBalances[WETH][msg.sender] = currencyBalances[WETH][msg.sender].add(
            uint128(msg.value)
        );

        emit Deposit(0, msg.sender, msg.value);
    }

    /**
     * @notice Withdraw ETH from the contract.
     * @dev - INSUFFICIENT_BALANCE: not enough balance in account
     * - INSUFFICIENT_FREE_COLLATERAL: not enough free collateral to withdraw
     * - TRANSFER_FAILED: eth transfer did not return success
     * @param amount the amount of eth to withdraw from the contract
     */
    function withdrawEth(uint128 amount) public {
        uint256 balance = currencyBalances[WETH][msg.sender];
        // Do all of these checks before we actually transfer the ETH to limit re-entrancy.
        require(balance >= amount, $$(ErrorCode(INSUFFICIENT_BALANCE)));
        currencyBalances[WETH][msg.sender] = balance.sub(amount);
        require(_freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        IWETH(WETH).withdraw(uint256(amount));
        // solium-disable-next-line security/no-call-value
        (bool success, ) = msg.sender.call.value(amount)("");
        require(success, $$(ErrorCode(TRANSFER_FAILED)));

        emit Withdraw(0, msg.sender, amount);
    }

    /**
     * @notice receive fallback for WETH transfers
     * @dev skip
     */
    receive() external payable {
        assert(msg.sender == WETH); // only accept ETH via fallback from the WETH contract
    }

    /**
     * @notice Transfers a balance from an ERC20 token contract into the Escrow.
     * @dev - INVALID_CURRENCY: token address supplied is not a valid currency
     * @param token token contract to send from
     * @param amount tokens to transfer
     */
    function deposit(address token, uint256 amount) external {
        address to = msg.sender;
        uint16 currencyGroupId = addressToCurrencyId[token];
        if (currencyGroupId == 0 && token != WETH) {
            revert($$(ErrorCode(INVALID_CURRENCY)));
        }

        currencyBalances[token][to] = currencyBalances[token][to].add(amount);
        IERC20(token).transferFrom(to, address(this), amount);

        emit Deposit(currencyGroupId, msg.sender, amount);
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

        emit Deposit(currencyGroupId, from, amount);
    }

    /**
     * @notice Withdraws from an account's collateral holdings back to their account. Checks if the
     * account has sufficient free collateral after the withdraw or else it fails.
     * @dev - INSUFFICIENT_BALANCE: not enough balance in account
     * - INVALID_CURRENCY: token address supplied is not a valid currency
     * - INSUFFICIENT_FREE_COLLATERAL: not enough free collateral to withdraw
     * @param token collateral type to withdraw
     * @param amount total value to withdraw
     */
    function withdraw(address token, uint256 amount) external {
        address to = msg.sender;
        require(token != address(0), $$(ErrorCode(INVALID_CURRENCY)));
        require(currencyBalances[token][to] >= amount, $$(ErrorCode(INSUFFICIENT_BALANCE)));

        currencyBalances[token][to] = currencyBalances[token][to].sub(amount);

        // We're checking this after the withdraw has been done on currency balances.
        require(_freeCollateral(to) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
        IERC20(token).transfer(to, amount);
        uint16 currencyGroupId = addressToCurrencyId[token];

        emit Withdraw(currencyGroupId, to, amount);
    }

    /********** Withdraw / Deposit Methods ***********/

    /********** Collateral / Cash Management *********/

    /**
     * @notice Transfers the collateral required between the Future Cash Market and the specified account. Collateral
     * held by the Future Cash Market is available to purchase in the liquidity pools.
     * @dev skip
     * @param account the account to withdraw collateral from
     * @param collateralToken the address of the token to use as collateral
     * @param futureCashGroupId the future cash group used to authenticate the future cash market
     * @param value the amount of collateral to deposit
     * @param fee the amount of `value` to pay as a fee
     */
    function depositIntoMarket(
        address account,
        address collateralToken,
        uint8 futureCashGroupId,
        uint128 value,
        uint128 fee
    ) public override {
        // Only the future cash market is allowed to call this function.
        Common.FutureCashGroup memory fg = Portfolios().getFutureCashGroup(futureCashGroupId);
        require(msg.sender == fg.futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        if (fee > 0) {
            currencyBalances[collateralToken][G_RESERVE_ACCOUNT] = currencyBalances[collateralToken][G_RESERVE_ACCOUNT]
                .add(fee);
        }

        currencyBalances[collateralToken][msg.sender] = currencyBalances[collateralToken][msg.sender].add(value);
        currencyBalances[collateralToken][account] = currencyBalances[collateralToken][account].sub(
            value + fee,
            $$(ErrorCode(INSUFFICIENT_BALANCE))
        );
    }

    /**
     * @notice Transfers the collateral required between the Future Cash Market and the specified account. Collateral
     * held by the Future Cash Market is available to purchase in the liquidity pools.
     * @dev skip
     * @param account the account to withdraw collateral from
     * @param collateralToken the address of the token to use as collateral
     * @param futureCashGroupId the future cash group used to authenticate the future cash market
     * @param value the amount of collateral to deposit
     * @param fee the amount of `value` to pay as a fee
     */
    function withdrawFromMarket(
        address account,
        address collateralToken,
        uint8 futureCashGroupId,
        uint128 value,
        uint128 fee
    ) public override {
        // Only the future cash market is allowed to call this function.
        Common.FutureCashGroup memory fg = Portfolios().getFutureCashGroup(futureCashGroupId);
        require(msg.sender == fg.futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        if (fee > 0) {
            currencyBalances[collateralToken][G_RESERVE_ACCOUNT] = currencyBalances[collateralToken][G_RESERVE_ACCOUNT]
                .add(fee);
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
            currencyBalances[token][futureCashMarket] = currencyBalances[token][futureCashMarket].add(
                uint256(amount.neg())
            );
        }
    }

    /**
     * @notice Can only be called by Portfolios when assets are settled to cash. There is no free collateral
     * check for this function call because asset settlement is an equivalent transformation of a asset
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
     * @dev - INVALID_TRADABLE_CURRENCY: tradable currency supplied is not a valid currency
     *  - INVALID_DEPOSIT_CURRENCY: deposit currency supplied is not a valid currency
     *  - COUNTERPARTY_CANNOT_BE_SELF: payer and receiver cannot be the same address
     *  - INCORRECT_CASH_BALANCE: payer or receiver does not have sufficient cash balance to settle
     *  - INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0
     *  - NO_EXCHANGE_LISTED_FOR_PAIR: cannot settle cash because no exchange is listed for the pair
     *  - CANNOT_SETTLE_PRICE_DISCREPENCY: cannot settle due to a discrepency or slippage in Uniswap
     *  - INSUFFICIENT_COLLATERAL_FOR_SETTLEMENT: not enough collateral to settle on the exchange
     *  - RESERVE_ACCOUNT_HAS_INSUFFICIENT_BALANCE: settling requires the reserve account, but there is insufficient
     * balance to do so
     *  - INSUFFICIENT_COLLATERAL_BALANCE: account does not hold enough collateral to settle, they will have
     * additional collateral in a different currency if they are collateralized
     *  - INSUFFICIENT_FREE_COLLATERAL_SETTLER: calling account to settle cash does not have sufficient free collateral
     * after settling payers and receivers
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
        require(isTradableCurrency(currency), $$(ErrorCode(INVALID_TRADABLE_CURRENCY)));
        require(isDepositCurrency(depositCurrency), $$(ErrorCode(INVALID_DEPOSIT_CURRENCY)));

        address depositToken = currencyIdToAddress[depositCurrency];
        address localCurrencyToken = currencyIdToAddress[currency];
        uint128[] memory settledAmounts = new uint128[](values.length);

        for (uint256 i; i < payers.length; i++) {
            settledAmounts[i] = _settleCashBalance(
                currency,
                localCurrencyToken,
                depositToken,
                payers[i],
                receivers[i],
                values[i]
            );
        }

        require(_freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL_FOR_SETTLER)));
        emit SettleCashBatch(currency, depositCurrency, payers, receivers, settledAmounts);
    }

    /**
     * @notice Settles the cash balance between the payer and the receiver.
     * @dev - INVALID_SWAP: portfolio contains an invalid swap, this would be system level error
     *  - INVALID_TRADABLE_CURRENCY: tradable currency supplied is not a valid currency
     *  - INVALID_DEPOSIT_CURRENCY: deposit currency supplied is not a valid currency
     *  - COUNTERPARTY_CANNOT_BE_SELF: payer and receiver cannot be the same address
     *  - INCORRECT_CASH_BALANCE: payer or receiver does not have sufficient cash balance to settle
     *  - INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0
     *  - NO_EXCHANGE_LISTED_FOR_PAIR: cannot settle cash because no exchange is listed for the pair
     *  - CANNOT_SETTLE_PRICE_DISCREPENCY: cannot settle due to a discrepency or slippage in Uniswap
     *  - INSUFFICIENT_COLLATERAL_FOR_SETTLEMENT: not enough collateral to settle on the exchange
     *  - RESERVE_ACCOUNT_HAS_INSUFFICIENT_BALANCE: settling requires the reserve account, but there is insufficient
     * balance to do so
     *  - INSUFFICIENT_COLLATERAL_BALANCE: account does not hold enough collateral to settle, they will have
     *  - INSUFFICIENT_FREE_COLLATERAL_SETTLER: calling account to settle cash does not have sufficient free collateral
     * after settling payers and receivers
     * additional collateral in a different currency if they are collateralized
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
        // matured assets that are not converted to cash may cause the _settleCashBalance function
        // to trip into settling with the reserve account.
        address[] memory accounts = new address[](2);
        accounts[0] = payer;
        accounts[1] = receiver;
        Portfolios().settleAccountBatch(accounts);
        require(isTradableCurrency(currency), $$(ErrorCode(INVALID_TRADABLE_CURRENCY)));
        require(isDepositCurrency(depositCurrency), $$(ErrorCode(INVALID_DEPOSIT_CURRENCY)));

        address depositToken = currencyIdToAddress[depositCurrency];
        address localCurrencyToken = currencyIdToAddress[currency];

        uint128 settledAmount = _settleCashBalance(currency, localCurrencyToken, depositToken, payer, receiver, value);

        require(_freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL_FOR_SETTLER)));
        emit SettleCash(currency, depositCurrency, payer, receiver, settledAmount);
    }

    /**
     * @notice Settles the cash balance between the payer and the receiver.
     * @param currency the currency group to settle
     * @param depositToken the deposit currency to sell to cover
     * @param payer the party that has a negative cash balance and will transfer collateral to the receiver
     * @param receiver the party that has a positive cash balance and will receive collateral from the payer
     * @param valueToSettle the amount of collateral to transfer
     */
    function _settleCashBalance(
        uint16 currency,
        address localCurrencyToken,
        address depositToken,
        address payer,
        address receiver,
        uint128 valueToSettle
    ) internal returns (uint128) {
        require(payer != receiver, $$(ErrorCode(COUNTERPARTY_CANNOT_BE_SELF)));
        if (valueToSettle == 0) return 0;

        // This cash account must have enough negative cash to settle against
        require(cashBalances[currency][payer] <= int256(valueToSettle).neg(), $$(ErrorCode(INCORRECT_CASH_BALANCE)));
        // The receiver must have enough cash balance to settle
        require(cashBalances[currency][receiver] >= int256(valueToSettle), $$(ErrorCode(INCORRECT_CASH_BALANCE)));

        // This is a reference to the total balance that the payer has in the local currency.
        uint256 localCurrencyBalance = currencyBalances[localCurrencyToken][payer];
        uint128 settledAmount;

        if (localCurrencyBalance >= valueToSettle) {
            // In this case we are just paying the receiver directly out of the currency balance
            currencyBalances[localCurrencyToken][payer] = currencyBalances[localCurrencyToken][payer].sub(
                valueToSettle
            );
            settledAmount = valueToSettle;
        } else {
            // Inside this if statement, the payer does not have enough local currency to settle their obligation.
            // First we will spend all of their collateral balance to settle their obligations before proceeding.
            delete currencyBalances[localCurrencyToken][payer];

            // If the payer does not have enough collateral to cover the value of the cash settlement, we have a
            // two options here:
            // 1. We attempt to extract cash from the portfolio (we do not know if there is any at this point)
            // 2. If there is still obligations remaining after we extract cash, we then check their free collateral.
            //   - If there is sufficient free collateral, we trade their deposit currency for local currency, either
            //     via uniswap or via exchange with the msg.sender
            //   - If there is not sufficient collateral, the payer account must be liquidated. However, we still
            //     settle out as much of their obligation as we can without liquidation.
            // 3. If the account is truly insolvent (no collateral and no future cash) then we dip into the reserve
            //    account to settle cash.

            // The remaining amount of collateral that we need to raise from the account to cover its obligation.
            uint128 localCurrencyRequired = valueToSettle - uint128(localCurrencyBalance);

            // It's unclear here that this call will actually be able to extract any cash, but must attempt to do
            // this anyway. This action cannot result in the payer ending up under collateralized. localCurrencyRequired
            // will always be greater than or equal to zero after this call returns.
            localCurrencyRequired = Portfolios().raiseCollateralViaLiquidityToken(
                payer,
                currency,
                localCurrencyRequired
            );

            if (localCurrencyRequired > 0) {
                // When we calculate free collateral here we need to add back in the value that we've extracted to ensure that the
                // free collateral calculation returns the appropriate value.
                (
                    int256 freeCollateral, /* int256[] memory */

                ) = Portfolios().freeCollateralView(payer);
                freeCollateral = freeCollateral.add(
                    int256(_convertToETHWithHaircut(localCurrencyToken, settledAmount))
                );

                if (freeCollateral >= 0) {
                    // Returns the amount of shortfall that the function was unable to cover
                    localCurrencyRequired = _sellCollateralToSettleCash(
                        payer,
                        receiver,
                        localCurrencyToken,
                        localCurrencyRequired,
                        depositToken
                    );
                } else if (!_hasCollateral(payer)) {
                    // Returns the amount of shortfall that the function was unable to cover
                    localCurrencyRequired = _attemptToSettleWithFutureCash(
                        payer,
                        currency,
                        localCurrencyToken,
                        localCurrencyRequired
                    );
                }

                // If the account has collateral and no free collateral it must be liquidated, but we will just
                // settle whatever partially settled amount remains here.
            }

            settledAmount = valueToSettle - localCurrencyRequired;
        }

        // Net out cash balances, the payer no longer owes this cash. The receiver is no longer owed this cash.
        cashBalances[currency][payer] = cashBalances[currency][payer].add(settledAmount);
        cashBalances[currency][receiver] = cashBalances[currency][receiver].sub(settledAmount);

        // Transfer the required amount to the receiver
        currencyBalances[localCurrencyToken][receiver] = currencyBalances[localCurrencyToken][receiver].add(
            settledAmount
        );

        return settledAmount;
    }

    /**
     * @notice Liquidates a batch of accounts in a specific currency.
     * @dev *  - INVALID_DEPOSIT_CURRENCY: deposit currency supplied is not a valid currency
     *  - CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL: account has positive free collateral and cannot be liquidated
     *  - CANNOT_LIQUIDATE_SELF: liquidator cannot equal the liquidated account
     *  - INSUFFICIENT_FREE_COLLATERAL_LIQUIDATOR: liquidator does not have sufficient free collateral after liquidating
     * accounts
     * @param accounts the account to liquidate
     * @param currency the currency that is undercollateralized
     * @param depositCurrency the deposit currency to exchange for `currency`
     */
    function liquidateBatch(
        address[] calldata accounts,
        uint16 currency,
        uint16 depositCurrency
    ) external {
        require(isDepositCurrency(depositCurrency), $$(ErrorCode(INVALID_DEPOSIT_CURRENCY)));
        address depositToken = currencyIdToAddress[depositCurrency];
        uint128[] memory amountLiquidated = new uint128[](accounts.length);

        for (uint256 i; i < accounts.length; i++) {
            amountLiquidated[i] = _liquidate(accounts[i], currency, depositToken);
        }

        require(_freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL_FOR_LIQUIDATOR)));
        emit LiquidateBatch(currency, depositCurrency, accounts, amountLiquidated);
    }

    /**
     * @notice Liquidates a single account if it is undercollateralized
     * @dev *  - INVALID_DEPOSIT_CURRENCY: deposit currency supplied is not a valid currency
     *  - CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL: account has positive free collateral and cannot be liquidated
     *  - CANNOT_LIQUIDATE_SELF: liquidator cannot equal the liquidated account
     *  - INSUFFICIENT_FREE_COLLATERAL_LIQUIDATOR: liquidator does not have sufficient free collateral after liquidating
     * accounts
     * @param account the account to liquidate
     * @param currency the currency that is undercollateralized
     * @param depositCurrency the deposit currency to exchange for `currency`
     */
    function liquidate(
        address account,
        uint16 currency,
        uint16 depositCurrency
    ) external {
        require(isDepositCurrency(depositCurrency), $$(ErrorCode(INVALID_DEPOSIT_CURRENCY)));
        address depositToken = currencyIdToAddress[depositCurrency];

        uint128 amountLiquidated = _liquidate(account, currency, depositToken);

        require(_freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL_FOR_LIQUIDATOR)));
        emit Liquidate(currency, depositCurrency, account, amountLiquidated);
    }

    function _liquidate(
        address account,
        uint16 currency,
        address depositToken
    ) internal returns (uint128) {
        int256 fc;
        uint128[] memory currencyRequirement;
        require(account != msg.sender, $$(ErrorCode(CANNOT_LIQUIDATE_SELF)));

        (fc, currencyRequirement) = Portfolios().freeCollateralNoEmit(account);

        // We must be undercollateralized overall and there must be a requirement for collaterlizing obligations in this currency.
        require(fc < 0 && currencyRequirement[currency] > 0, $$(ErrorCode(CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL)));
        address localCurrencyToken = currencyIdToAddress[currency];

        // Free collateral credits the collateral claim in liquidity tokens to the currency requirement. We first
        // raise collateral this way to get the net local currency we need to raise. This is always greater than
        // or equal to zero.
        uint128 localCurrencyRequired = Portfolios().raiseCollateralViaLiquidityToken(
            account,
            currency,
            currencyRequirement[currency]
        );

        // Returns any remaining local currency that we were unable to raise
        localCurrencyRequired = _purchaseCollateralForLocalCurrency(
            account,
            localCurrencyToken,
            localCurrencyRequired,
            G_LIQUIDATION_DISCOUNT,
            depositToken
        );

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

        currencyBalances[localCurrencyToken][account] = currencyBalances[localCurrencyToken][account].add(
            unspentShortfall
        );

        // We return the amount of localCurrency we raised in liquidation.
        return currencyRequirement[currency] - localCurrencyRequired;
    }

    /********** Settle Cash / Liquidation *************/

    /********** Internal Methods *********************/

    function _sellCollateralToSettleCash(
        address payer,
        address receiver,
        address localCurrencyToken,
        uint128 localCurrencyRequired,
        address depositToken
    ) internal returns (uint128) {
        if (msg.sender == receiver) {
            // If the sender is the receiver then someone is attempting to settle the cash that they are owed.
            // For this, we attempt to sell the collateral on Uniswap so that the receiver can have a purely
            // on chain interaction.
            return _tradeCollateralOnExchange(payer, localCurrencyToken, depositToken, localCurrencyRequired);
        } else {
            return
                _purchaseCollateralForLocalCurrency(
                    payer,
                    localCurrencyToken,
                    localCurrencyRequired,
                    G_SETTLEMENT_DISCOUNT,
                    depositToken
                );
        }
    }

    function _attemptToSettleWithFutureCash(
        address payer,
        uint16 currency,
        address localCurrencyToken,
        uint128 localCurrencyRequired
    ) internal returns (uint128) {
        // This call will attempt to sell future cash tokens in return for local currency. We do this as a last ditch effort
        // before we dip into reserves. The free collateral position will not change as a result of this method since positive
        // future cash (in this version) does not affect free collateral.
        uint128 cashShortfall = Portfolios().raiseCollateralViaCashReceiver(payer, currency, localCurrencyRequired);

        if (cashShortfall > 0 && _hasNoAssets(payer)) {
            // At this point, the portfolio has no positive future value associated with it and no collateral. It
            // is completely insolvent and therfore we need to pay out the remaining obligation from the reserve account.
            uint256 reserveBalance = currencyBalances[localCurrencyToken][G_RESERVE_ACCOUNT];

            if (cashShortfall > reserveBalance) {
                // Partially settle the cashShortfall if the reserve account does not have enough balance
                currencyBalances[localCurrencyToken][G_RESERVE_ACCOUNT] = 0;
                return cashShortfall - uint128(reserveBalance);
            } else {
                currencyBalances[localCurrencyToken][G_RESERVE_ACCOUNT] = reserveBalance - cashShortfall;
                return 0;
            }
        }

        return cashShortfall;
    }

    /**
     * @notice Exchanges collateral for specified local currency at a discount
     */
    function _purchaseCollateralForLocalCurrency(
        address payer,
        address localCurrencyToken,
        uint128 localCurrencyRequired,
        uint128 discountFactor,
        address depositToken
    ) internal returns (uint128) {
        // If the msg sender does not equal the receiver, then it is settling the position on behalf
        // of the receiver. In this case, the msg.sender can purchase the ETH from the payer at a small
        // discount from the oracle price for their service.
        uint256 rate = _exchangeRate(localCurrencyToken, depositToken);

        uint128 localCurrencyPurchased = localCurrencyRequired;
        uint256 collateralToPurchase = rate.mul(localCurrencyPurchased).div(Common.DECIMALS).mul(discountFactor).div(
            Common.DECIMALS
        );
        uint256 collateralBalance = currencyBalances[depositToken][payer];

        if (collateralToPurchase > collateralBalance) {
            localCurrencyPurchased = uint128(
                collateralBalance.mul(Common.DECIMALS).div(rate).mul(Common.DECIMALS).div(discountFactor)
            );
            collateralToPurchase = collateralBalance;
        }

        // Transfer the collateral between accounts. The msg.sender must have enough to cover the collateral
        // remaining at this point.
        currencyBalances[localCurrencyToken][msg.sender] = currencyBalances[localCurrencyToken][msg.sender].sub(
            localCurrencyPurchased
        );

        // Transfer the collateral currency between accounts
        currencyBalances[depositToken][msg.sender] = currencyBalances[depositToken][msg.sender].add(
            collateralToPurchase
        );
        // We expect the payer to have enough here because they passed the free collateral check.
        currencyBalances[depositToken][payer] = currencyBalances[depositToken][payer].sub(collateralToPurchase);

        return localCurrencyRequired - localCurrencyPurchased;
    }

    /**
     * @notice Liquidates collateral balances to the target currency on Uniswap.
     *
     * @param account the account that holds the collateral
     * @param targetToken the currency to trade into
     * @param depositToken the deposit currency to exchange
     * @param localCurrencyRequired the amount of the target currency to raise
     */
    function _tradeCollateralOnExchange(
        address account,
        address targetToken,
        address depositToken,
        uint128 localCurrencyRequired
    ) internal returns (uint128) {
        ExchangeRate memory er = exchangeRateOracles[targetToken][depositToken];
        address[] memory path = er.uniswapPath;
        
        // We do not currently support token to token transfers on Uniswap
        require(path.length > 0, $$(ErrorCode(NO_EXCHANGE_LISTED_FOR_PAIR)));

        uint256 localCurrencyPurchased = localCurrencyRequired;
        // First determine how much local currency the collateral would trade for. If it is enough to cover the obligation then
        // we just trade for what is required. If not then we will trade all the collateral.
        uint256[] memory amounts = IUniswapV2Router02(UNISWAP_ROUTER).getAmountsIn(
            localCurrencyPurchased,
            path
        );
        uint256 collateralSold = amounts[0];

        uint256 collateralBalance = currencyBalances[depositToken][account];
        if (collateralBalance < collateralSold) {
            // Here we will sell all the collateral to cover as much debt as we can
            amounts = IUniswapV2Router02(UNISWAP_ROUTER).getAmountsOut(
                collateralBalance,
                path
            );
            localCurrencyPurchased = amounts[amounts.length - 1];
            collateralSold = collateralBalance;
        }

        _checkUniswapRateDifference(localCurrencyPurchased, collateralSold, er.rateOracle);

        // This will ensure that exactly localCurrencyPurchased tokens will be purchased,
        // the actual amount of collateralSold may be less than what we specify.
        amounts = IUniswapV2Router02(UNISWAP_ROUTER).swapTokensForExactTokens(
            localCurrencyPurchased,
            collateralSold,
            path,
            address(this),
            block.timestamp
        );
        // We have to set this here to ensure that we deduct the correct amount of collateralSold
        collateralSold = amounts[0];

        // Reduce the collateral balance by the amount traded.
        currencyBalances[depositToken][account] = collateralBalance - collateralSold;

        return localCurrencyRequired - uint128(localCurrencyPurchased);
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

        uint256 rateDiff = uint256(answer.sub(int256(uniswapImpliedRate)).abs().mul(Common.DECIMALS).div(answer));

        // We fail if the rate diff between the two exchanges is larger than the settlement haircut. This means that
        // there is an arbitrage opportunity for the receiver and we fail out here to protect the payer.
        require(
            rateDiff < uint256(G_SETTLEMENT_DISCOUNT).sub(Common.DECIMALS),
            $$(ErrorCode(CANNOT_SETTLE_PRICE_DISCREPENCY))
        );
    }

    /**
     * @notice Internal method for calling free collateral.
     *
     * @param account the account to check free collateral for
     * @return amount of free collateral
     */
    function _freeCollateral(address account) internal returns (int256) {
        (
            int256 fc, /* uint128[] memory */

        ) = Portfolios().freeCollateral(account);
        return fc;
    }

    /**
     * @notice Converts a balance between token addresses.
     *
     * @param base base currency
     * @param balance amount to convert
     * @return the converted balance
     */
    function _convertToETHWithHaircut(address base, uint256 balance) internal view returns (uint256) {
        ExchangeRate memory er = exchangeRateOracles[base][WETH];

        // Fetches the latest answer from the chainlink oracle and haircut it by the apporpriate amount.
        int256 answer = IAggregator(er.rateOracle).latestAnswer();
        require(answer > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

        uint256 rate = uint256(answer).mul(er.haircut).div(Common.DECIMALS);

        return balance.mul(rate).div(Common.DECIMALS);
    }

    function _exchangeRate(address base, address quote) internal view returns (uint256) {
        ExchangeRate memory er = exchangeRateOracles[base][WETH];

        int256 rate = IAggregator(er.rateOracle).latestAnswer();
        require(rate > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

        if (quote != WETH) {
            ExchangeRate memory quoteER = exchangeRateOracles[quote][WETH];

            int256 quoteRate = IAggregator(quoteER.rateOracle).latestAnswer();
            require(quoteRate > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

            rate = rate.mul(Common.DECIMALS).div(quoteRate);
        }

        return uint256(rate);
    }

    function _hasCollateral(address account) internal view returns (bool) {
        for (uint256 i; i < depositCurrencies.length; i++) {
            if (currencyBalances[currencyIdToAddress[depositCurrencies[i]]][account] > 0) {
                return true;
            }
        }

        return false;
    }

    function _hasNoAssets(address account) internal view returns (bool) {
        Common.Asset[] memory portfolio = Portfolios().getAssets(account);
        for (uint256 i; i < portfolio.length; i++) {
            // This may be cash receiver or liquidity tokens
            // TODO: does this need to be currency specific?
            if (Common.isReceiver(portfolio[i].swapType)) {
                return false;
            }
        }

        return true;
    }
}
