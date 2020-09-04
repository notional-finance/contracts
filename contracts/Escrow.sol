pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./utils/Governed.sol";
import "./utils/Liquidation.sol";

import "./lib/SafeInt256.sol";
import "./lib/SafeMath.sol";
import "./lib/SafeUInt128.sol";
import "./lib/SafeERC20.sol";

import "./interface/IERC20.sol";
import "./interface/IERC777.sol";
import "./interface/IERC777Recipient.sol";
import "./interface/IERC1820Registry.sol";
import "./interface/IAggregator.sol";
import "./interface/IEscrowCallable.sol";
import "./interface/IWETH.sol";

import "./storage/EscrowStorage.sol";
import "@openzeppelin/contracts/utils/SafeCast.sol";

/**
 * @title Escrow
 * @notice Manages a account balances for the entire system including deposits, withdraws,
 * cash balances, collateral lockup for trading, cash transfers (settlement), and liquidation.
 */
contract Escrow is EscrowStorage, Governed, IERC777Recipient, IEscrowCallable {
    using SafeUInt128 for uint128;
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
        uint128 ethHaircut
    ) external initializer {
        Governed.initialize(directory);

        // This registry call is used for the ERC777 token standard.
        IERC1820Registry(registry).setInterfaceImplementer(address(0), TOKENS_RECIPIENT_INTERFACE_HASH, address(this));

        // List ETH as the zero currency and a deposit currency
        WETH = weth;
        currencyIdToAddress[0] = WETH;
        addressToCurrencyId[WETH] = 0;
        currencyIdToDecimals[0] = Common.DECIMALS;
        // Add the ETH haircut for ETH debts
        exchangeRateOracles[0][0] = ExchangeRate(address(0), 0, false, ethHaircut);
        emit NewCurrency(WETH);
    }

    /********** Events *******************************/

    /**
     * @notice A new currency
     * @param token address of the tradable token
     */
    event NewCurrency(address indexed token);

    /**
     * @notice A new exchange rate between two currencies
     * @param base id of the base currency
     * @param quote id of the quote currency
     */
    event UpdateExchangeRate(uint16 indexed base, uint16 indexed quote);

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
     * @param settledAmount the amount settled between the parties
     */
    event SettleCash(
        uint16 localCurrency,
        uint16 depositCurrency,
        address indexed payer,
        uint128 settledAmount
    );

    /**
     * @notice Notice of a successful batch cash settlement. `msg.sender` will be the settler.
     * @param localCurrency currency that was settled
     * @param depositCurrency currency that was exchanged for the local currency
     * @param payers the accounts that paid in the settlement
     * @param settledAmounts the amounts settled between the parties
     */
    event SettleCashBatch(
        uint16 localCurrency,
        uint16 depositCurrency,
        address[] payers,
        uint128[] settledAmounts
    );

    /**
     * @notice Emitted when liquidation and settlement discounts are set
     * @param liquidationDiscount discount given to liquidators when purchasing collateral
     * @param settlementDiscount discount given to settlers when purchasing collateral
     * @param repoIncentive incentive given to liquidators for pulling liquidity tokens to recollateralize an account
     */
    event SetDiscounts(uint128 liquidationDiscount, uint128 settlementDiscount, uint128 repoIncentive);

    /**
     * @notice Emitted when reserve account is set
     * @param reserveAccount account that holds balances in reserve
     */
    event SetReserve(address reserveAccount);

    /********** Events *******************************/

    /********** Governance Settings ******************/

    /**
     * @notice Sets a local cached version of the G_LIQUIDITY_HAIRCUT on the RiskFramework contract. This will be
     * used locally in the settlement and liquidation calculations when we pull local currency liquidity tokens.
     */
    function setLiquidityHaircut(uint128 haircut) external override {
        require(calledByRisk(), $$(ErrorCode(UNAUTHORIZED_CALLER)));
        G_LIQUIDITY_HAIRCUT = haircut;
    }

    /**
     * @notice Sets discounts applied when purchasing collateral during liquidation or settlement. Discounts are
     * represented as percentages multiplied by 1e18. For example, a 5% discount for liquidators will be set as
     * 1.05e18
     * @dev governance
     * @param liquidation discount applied to liquidation
     * @param settlement discount applied to settlement
     * @param repoIncentive incentive to repo liquidity tokens
     */
    function setDiscounts(uint128 liquidation, uint128 settlement, uint128 repoIncentive) external onlyOwner {
        G_LIQUIDATION_DISCOUNT = liquidation;
        G_SETTLEMENT_DISCOUNT = settlement;
        G_LIQUIDITY_TOKEN_REPO_INCENTIVE = repoIncentive;

        emit SetDiscounts(liquidation, settlement, repoIncentive);
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

    function listCurrency(address token, TokenOptions memory options) public onlyOwner {
        require(addressToCurrencyId[token] == 0 && token != WETH, $$(ErrorCode(INVALID_CURRENCY)));

        maxCurrencyId++;
        // We don't do a lot of checking here but since this is purely an administrative
        // activity we just rely on governance not to set this improperly.
        currencyIdToAddress[maxCurrencyId] = token;
        addressToCurrencyId[token] = maxCurrencyId;
        tokenOptions[token] = options;
        uint256 decimals = IERC20(token).decimals();
        currencyIdToDecimals[maxCurrencyId] = 10**(decimals);
        // We need to set this number so that the free collateral check can provision
        // the right number of currencies.
        Portfolios().setNumCurrencies(maxCurrencyId);

        emit NewCurrency(token);
    }

    /**
     * @notice Creates an exchange rate between two currencies.
     * @dev governance
     * @param base the base currency
     * @param quote the quote currency
     * @param rateOracle the oracle that will give the exchange rate between the two
     * @param haircut multiple to apply to the exchange rate that sets the collateralization ratio
     * @param rateDecimals decimals of precision that the rate oracle uses
     * @param mustInvert true if the chainlink oracle must be inverted
     */
    function addExchangeRate(
        uint16 base,
        uint16 quote,
        address rateOracle,
        uint128 haircut,
        uint128 rateDecimals,
        bool mustInvert
    ) external onlyOwner {
        // We require that exchange rate haircuts are always greater than the settlement discount. The reason is
        // that if this is not the case, it opens up the possibility that free collateral actually ends up in a worse
        // position in the event of a third party settlement.
        require(haircut > G_SETTLEMENT_DISCOUNT, $$(ErrorCode(INVALID_HAIRCUT_SIZE)));
        exchangeRateOracles[base][quote] = ExchangeRate(
            rateOracle,
            rateDecimals,
            mustInvert,
            haircut
        );

        emit UpdateExchangeRate(base, quote);
    }

    /********** Governance Settings ******************/

    /********** Getter Methods ***********************/

    /**
     * @notice Evaluates whether or not a currency id is valid
     * @param currency currency id
     * @return true if the currency is valid
     */
    function isValidCurrency(uint16 currency) public override view returns (bool) {
        return currency <= maxCurrencyId;
    }

    /**
     * @notice Getter method for exchange rates
     * @param base token address for the base currency
     * @param quote token address for the quote currency
     * @return ExchangeRate struct
     */
    function getExchangeRate(uint16 base, uint16 quote) external view returns (ExchangeRate memory) {
        return exchangeRateOracles[base][quote];
    }

    /**
     * @notice Returns the net balances of all the currencies owned by an account as
     * an array. Each index of the array refers to the currency id.
     * @param account the account to query
     * @return the balance of each currency net of the account's cash position
     */
    function getBalances(address account) external override view returns (int256[] memory) {
        // We add one here because the zero currency index is unused
        int256[] memory balances = new int256[](maxCurrencyId + 1);

        for (uint256 i; i < balances.length; i++) {
            balances[i] = cashBalances[uint16(i)][account];
        }

        return balances;
    }

    /**
     * @notice Converts the balances given to ETH for the purposes of determining whether an account has
     * sufficient free collateral.
     * @dev - INVALID_CURRENCY: length of the amounts array must match the total number of currencies
     *  - INVALID_EXCHANGE_RATE: exchange rate returned by the oracle is less than 0
     * @param amounts the balance in each currency group as an array, each index refers to the currency group id.
     * @return an array the same length as amounts with each balance denominated in ETH
     */
    function convertBalancesToETH(int256[] memory amounts) public override view returns (int256[] memory) {
        // We expect values for all currencies to be supplied here, we will not do any work on 0 balances.
        require(amounts.length == maxCurrencyId + 1, $$(ErrorCode(INVALID_CURRENCY)));
        int256[] memory results = new int256[](amounts.length);

        // Currency ID = 0 is already ETH so we don't need to convert it, unless it is negative. Then we will
        // haircut it.
        if (amounts[0] < 0) {
            // We store the ETH haircut on the exchange rate back to itself.
            uint128 haircut = exchangeRateOracles[0][0].haircut;
            results[0] = amounts[0].mul(haircut).div(Common.DECIMALS);
        } else {
            results[0] = amounts[0];
        }

        for (uint256 i = 1; i < amounts.length; i++) {
            if (amounts[i] == 0) continue;

            if (amounts[i] < 0) {
                // We haircut negative amounts to enforce collateralization ratios
                results[i] = _convertToETH(uint16(i), amounts[i], true);
            } else {
                // We do not haircut positive amounts so that they can be used to collateralize
                // other debts.
                results[i] = _convertToETH(uint16(i), amounts[i], false);
            }
        }

        return results;
    }

    /********** Getter Methods ***********************/

    /********** Withdraw / Deposit Methods ***********/

    /**
     * @notice receive fallback for WETH transfers
     * @dev skip
     */
    receive() external payable {
        assert(msg.sender == WETH); // only accept ETH via fallback from the WETH contract
    }

    /**
     * @notice This is a special function to handle ETH deposits. Value of ETH to be deposited must be specified in `msg.value`
     * @dev - OVER_MAX_ETH_BALANCE: balance of deposit cannot overflow uint128
     */
    function depositEth() external payable {
        _depositEth(msg.sender);
    }

    function _depositEth(address to) internal {
        require(msg.value <= Common.MAX_UINT_128, $$(ErrorCode(OVER_MAX_ETH_BALANCE)));
        IWETH(WETH).deposit{value: msg.value}();

        cashBalances[0][to] = cashBalances[0][to].add(
            uint128(msg.value)
        );
        emit Deposit(0, to, msg.value);
    }

    /**
     * @notice Withdraw ETH from the contract.
     * @dev - INSUFFICIENT_BALANCE: not enough balance in account
     * - INSUFFICIENT_FREE_COLLATERAL: not enough free collateral to withdraw
     * - TRANSFER_FAILED: eth transfer did not return success
     * @param amount the amount of eth to withdraw from the contract
     */
    function withdrawEth(uint128 amount) external {
        _withdrawEth(msg.sender, amount);
    }

    function _withdrawEth(address to, uint128 amount) internal {
        int256 balance = cashBalances[0][to];
        cashBalances[0][to] = balance.subNoNeg(amount);
        require(_freeCollateral(to) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        IWETH(WETH).withdraw(uint256(amount));
        // solium-disable-next-line security/no-call-value
        (bool success, ) = to.call{value: amount}("");
        require(success, $$(ErrorCode(TRANSFER_FAILED)));
        emit Withdraw(0, to, amount);
    }

    /**
     * @notice Transfers a balance from an ERC20 token contract into the Escrow.
     * @dev - INVALID_CURRENCY: token address supplied is not a valid currency
     * @param token token contract to send from
     * @param amount tokens to transfer
     */
    function deposit(address token, uint128 amount) external {
        _deposit(msg.sender, token, amount);
    }

    function _deposit(address to, address token, uint128 amount) internal {
        uint16 currencyGroupId = addressToCurrencyId[token];
        TokenOptions memory tokenOptions = tokenOptions[token];
        if (currencyGroupId == 0 && token != WETH && !tokenOptions.isERC777) {
            revert($$(ErrorCode(INVALID_CURRENCY)));
        }

        if (tokenOptions.hasTransferFee) {
            // If there is a transfer fee we check the pre and post transfer balance to ensure that we increment
            // the balance by the correct amount after transfer.
            uint256 preTransferBalance = IERC20(token).balanceOf(address(this));
            SafeERC20.safeTransferFrom(IERC20(token), to, address(this), amount);
            uint256 postTransferBalance = IERC20(token).balanceOf(address(this));

            amount = SafeCast.toUint128(postTransferBalance.sub(preTransferBalance));
            cashBalances[currencyGroupId][to] = cashBalances[currencyGroupId][to].add(amount);
        } else {
            SafeERC20.safeTransferFrom(IERC20(token), to, address(this), amount);
            cashBalances[currencyGroupId][to] = cashBalances[currencyGroupId][to].add(amount);
        }

        emit Deposit(currencyGroupId, to, amount);
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
    function withdraw(address token, uint128 amount) external {
       _withdraw(msg.sender, msg.sender, token, amount, true);
    }

    function _withdraw(
        address from,
        address to,
        address token,
        uint128 amount,
        bool checkFC
    ) internal {
        uint16 currencyGroupId = addressToCurrencyId[token];
        require(token != address(0), $$(ErrorCode(INVALID_CURRENCY)));

        if (checkFC) Portfolios().settleMaturedAssets(from);

        int256 balance = cashBalances[currencyGroupId][from];
        cashBalances[currencyGroupId][from] = balance.subNoNeg(amount);

        // We're checking this after the withdraw has been done on currency balances. We skip this check
        // for batch withdraws when we check once after everything is completed.
        if (checkFC) {
            (int256 fc, /* int256[] memory */, /* int256[] memory */) = Portfolios().freeCollateralView(from);
            require(fc >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
        }

        if (tokenOptions[token].isERC777) {
            IERC777(token).send(to, amount, "0x");
        } else {
            SafeERC20.safeTransfer(IERC20(token), to, amount);
        }

        emit Withdraw(currencyGroupId, to, amount);
    }

    /**
     * @notice Deposits on behalf of an account, called via the ERC1155 batchOperation and bridgeTransferFrom.
     * @dev skip
     */
    function depositsOnBehalf(address account, Common.Deposit[] memory deposits) public payable override {
        require(calledByERC1155Trade(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        if (msg.value != 0) {
            _depositEth(account);
        }

        for (uint256 i; i < deposits.length; i++) {
            address tokenAddress = currencyIdToAddress[deposits[i].currencyId];
            _deposit(account, tokenAddress, deposits[i].amount);
        }
    }

    /**
     * @notice Withdraws on behalf of an account, called via the ERC1155 batchOperation and bridgeTransferFrom. Note that
     * this does not handle non-WETH withdraws.
     * @dev skip
     */
    function withdrawsOnBehalf(address account, Common.Withdraw[] memory withdraws) public override {
        require(calledByERC1155Trade(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        for (uint256 i; i < withdraws.length; i++) {
            address tokenAddress = currencyIdToAddress[withdraws[i].currencyId];
            uint128 amount;

            if (withdraws[i].amount == 0) {
                // If the amount is zero then we skip.
                continue;
            } else {
                amount = withdraws[i].amount;
            }

            // We skip the free collateral check here because ERC1155.batchOperation will do the check
            // before it exits.
            _withdraw(account, withdraws[i].to, tokenAddress, amount, false);
        }
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
        cashBalances[currencyGroupId][from] = cashBalances[currencyGroupId][from].add(SafeCast.toUint128(amount));

        emit Deposit(currencyGroupId, from, amount);
    }

    /********** Withdraw / Deposit Methods ***********/

    /********** Collateral / Cash Management *********/

    /**
     * @notice Transfers the collateral required between the Future Cash Market and the specified account. Collateral
     * held by the Future Cash Market is available to purchase in the liquidity pools.
     * @dev skip
     * @param account the account to withdraw collateral from
     * @param futureCashGroupId the future cash group used to authenticate the future cash market
     * @param value the amount of collateral to deposit
     * @param fee the amount of `value` to pay as a fee
     */
    function depositIntoMarket(
        address account,
        uint8 futureCashGroupId,
        uint128 value,
        uint128 fee
    ) external override {
        // Only the future cash market is allowed to call this function.
        Common.FutureCashGroup memory fg = Portfolios().getFutureCashGroup(futureCashGroupId);
        require(msg.sender == fg.futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        if (fee > 0) {
            cashBalances[fg.currency][G_RESERVE_ACCOUNT] = cashBalances[fg.currency][G_RESERVE_ACCOUNT]
                .add(fee);
        }

        cashBalances[fg.currency][msg.sender] = cashBalances[fg.currency][msg.sender].add(value);
        int256 balance = cashBalances[fg.currency][account];
        cashBalances[fg.currency][account] = balance.subNoNeg(value.add(fee));
    }

    /**
     * @notice Transfers the collateral required between the Future Cash Market and the specified account. Collateral
     * held by the Future Cash Market is available to purchase in the liquidity pools.
     * @dev skip
     * @param account the account to withdraw collateral from
     * @param futureCashGroupId the future cash group used to authenticate the future cash market
     * @param value the amount of collateral to deposit
     * @param fee the amount of `value` to pay as a fee
     */
    function withdrawFromMarket(
        address account,
        uint8 futureCashGroupId,
        uint128 value,
        uint128 fee
    ) external override {
        // Only the future cash market is allowed to call this function.
        Common.FutureCashGroup memory fg = Portfolios().getFutureCashGroup(futureCashGroupId);
        require(msg.sender == fg.futureCashMarket, $$(ErrorCode(UNAUTHORIZED_CALLER)));

        if (fee > 0) {
            cashBalances[fg.currency][G_RESERVE_ACCOUNT] = cashBalances[fg.currency][G_RESERVE_ACCOUNT]
                .add(fee);
        }

        cashBalances[fg.currency][account] = cashBalances[fg.currency][account].add(value.sub(fee));

        int256 balance = cashBalances[fg.currency][msg.sender];
        cashBalances[fg.currency][msg.sender] = balance.subNoNeg(value);
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
    ) external override {
        require(calledByPortfolios(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        // The methods that calls this function will handle management of the collateral that is added or removed from
        // the market.
        int256 balance = cashBalances[currency][futureCashMarket];
        cashBalances[currency][futureCashMarket] = balance.subNoNeg(amount);
    }

    /**
     * @notice Can only be called by Portfolios when assets are settled to cash. There is no free collateral
     * check for this function call because asset settlement is an equivalent transformation of a asset
     * to a net cash value. An account's free collateral position will remain unchanged after settlement.
     * @dev skip
     * @param account account where the cash is settled
     * @param settledCash an array of the currency groups that need to have their cash balance updated
     */
    function portfolioSettleCash(address account, int256[] calldata settledCash) external override {
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
     * @dev - INVALID_CURRENCY: currency specified is invalid
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
     * @param values the amount of collateral to transfer
     */
    function settleCashBalanceBatch(
        uint16 currency,
        uint16 depositCurrency,
        address[] calldata payers,
        uint128[] calldata values
    ) external {
        require(isValidCurrency(currency), $$(ErrorCode(INVALID_CURRENCY)));
        require(isValidCurrency(depositCurrency), $$(ErrorCode(INVALID_CURRENCY)));
        require(currency != depositCurrency, $$(ErrorCode(INVALID_CURRENCY)));

        Portfolios().settleMaturedAssetsBatch(payers);
        uint128[] memory settledAmounts = new uint128[](values.length);

        for (uint256 i; i < payers.length; i++) {
            settledAmounts[i] = _settleCashBalance(
                currency,
                depositCurrency,
                payers[i],
                values[i]
            );
        }

        require(_freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL_FOR_SETTLER)));
        emit SettleCashBatch(currency, depositCurrency, payers, settledAmounts);
    }

    /**
     * @notice Settles the cash balance between the payer and the receiver.
     * @dev - INVALID_SWAP: portfolio contains an invalid swap, this would be system level error
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
     * @param value the amount of collateral to transfer
     */
    function settleCashBalance(
        uint16 currency,
        uint16 depositCurrency,
        address payer,
        uint128 value
    ) external {
        require(isValidCurrency(currency), $$(ErrorCode(INVALID_CURRENCY)));
        require(isValidCurrency(depositCurrency), $$(ErrorCode(INVALID_CURRENCY)));
        require(currency != depositCurrency, $$(ErrorCode(INVALID_CURRENCY)));

        // We must always ensure that accounts are settled when we settle cash balances because
        // matured assets that are not converted to cash may cause the _settleCashBalance function
        // to trip into settling with the reserve account.
        Portfolios().settleMaturedAssets(payer);
        uint128 settledAmount = _settleCashBalance(currency, depositCurrency, payer, value);

        require(_freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL_FOR_SETTLER)));
        emit SettleCash(currency, depositCurrency, payer, settledAmount);
    }

    /**
     * @notice Settles the cash balance between the payer and the receiver.
     * @param currency the currency group to settle
     * @param depositCurrency the deposit currency to sell to cover
     * @param payer the party that has a negative cash balance and will transfer collateral to the receiver
     * @param valueToSettle the amount of collateral to transfer
     */
    function _settleCashBalance(
        uint16 currency,
        uint16 depositCurrency,
        address payer,
        uint128 valueToSettle
    ) internal returns (uint128) {
        if (valueToSettle == 0) return 0;

        // This cash account must have enough negative cash to settle against
        require(cashBalances[currency][payer] <= int256(valueToSettle).neg(), $$(ErrorCode(INCORRECT_CASH_BALANCE)));
        (int256 freeCollateral, int256[] memory netCurrencyAvailable, int256[] memory cashClaims) = Portfolios().freeCollateralView(payer);

        uint128 settledAmount;
        if (cashClaims[currency] > 0) {
            // We only try to raise collateral via liquidity tokens if the account has NPV, meaning it has
            // liquidity tokens of this currency in its portfolio
            uint128 remainder = Portfolios().raiseCollateralViaLiquidityToken(
                payer,
                currency,
                valueToSettle
            );

            settledAmount = valueToSettle.sub(remainder);
        }

        if (valueToSettle > settledAmount) {
            if (freeCollateral >= 0) {
                uint128 localCurrencyPurchased = _purchaseDeposit(
                    payer,
                    currency,
                    valueToSettle - settledAmount,
                    depositCurrency,
                    cashClaims[depositCurrency],
                    netCurrencyAvailable,
                    false
                );
                cashBalances[currency][msg.sender] = cashBalances[currency][msg.sender].subNoNeg(localCurrencyPurchased);
                settledAmount = settledAmount.add(localCurrencyPurchased);
            } else if (!_hasCollateral(payer)) {
                settledAmount = settledAmount.add(
                    _attemptToSettleWithFutureCash(
                        payer,
                        currency,
                        valueToSettle - settledAmount
                    )
                );
            }
        }

        // Net out cash balances, the payer no longer owes this cash.
        cashBalances[currency][payer] = cashBalances[currency][payer].add(settledAmount);

        return settledAmount;
    }

    /**
     * @notice Liquidates a batch of accounts in a specific currency.
     * @dev - CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL: account has positive free collateral and cannot be liquidated
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
        require(isValidCurrency(depositCurrency), $$(ErrorCode(INVALID_CURRENCY)));
        require(currency != depositCurrency, $$(ErrorCode(INVALID_CURRENCY)));
        uint128[] memory amountLiquidated = new uint128[](accounts.length);

        for (uint256 i; i < accounts.length; i++) {
            amountLiquidated[i] = _liquidate(accounts[i], currency, depositCurrency);
        }

        require(_freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL_FOR_LIQUIDATOR)));
        emit LiquidateBatch(currency, depositCurrency, accounts, amountLiquidated);
    }

    /**
     * @notice Liquidates a single account if it is undercollateralized
     * @dev - CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL: account has positive free collateral and cannot be liquidated
     *  - CANNOT_LIQUIDATE_SELF: liquidator cannot equal the liquidated account
     *  - INSUFFICIENT_FREE_COLLATERAL_LIQUIDATOR: liquidator does not have sufficient free collateral after liquidating
     * accounts
     *  - CANNOT_LIQUIDATE_TO_WORSE_FREE_COLLATERAL: we cannot liquidate an account and have it end up in a worse free
     *  collateral position than when it started. This is possible if depositCurrency has a larger haircut than currency.
     * @param account the account to liquidate
     * @param currency the currency that is undercollateralized
     * @param depositCurrency the deposit currency to exchange for `currency`
     */
    function liquidate(
        address account,
        uint16 currency,
        uint16 depositCurrency
    ) external {
        require(isValidCurrency(depositCurrency), $$(ErrorCode(INVALID_CURRENCY)));
        require(currency != depositCurrency, $$(ErrorCode(INVALID_CURRENCY)));

        uint128 amountLiquidated = _liquidate(account, currency, depositCurrency);

        require(_freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL_FOR_LIQUIDATOR)));
        emit Liquidate(currency, depositCurrency, account, amountLiquidated);
    }

    function _liquidate(
        address account,
        uint16 localCurrency,
        uint16 depositCurrency
    ) internal returns (uint128) {
        require(account != msg.sender, $$(ErrorCode(CANNOT_LIQUIDATE_SELF)));
        (int256 fc, int256[] memory netCurrencyAvailable, int256[] memory cashClaims) = Portfolios().freeCollateralNoEmit(account);

        require(fc < 0,  $$(ErrorCode(CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL)));

        // This is the amount in local currency that we need to raise in order to bring the account back into collateralization.
        uint128 localCurrencyRequired = uint128(_convertETHTo(localCurrency, fc.neg()));

        uint128 localCurrencyCredit;
        int256 localCurrencySold;
        if (cashClaims[localCurrency] > 0) {
            (
                localCurrencyCredit,
                localCurrencySold,
                localCurrencyRequired,
                netCurrencyAvailable[localCurrency]
            ) = Liquidation.liquidateLocalLiquidityTokens(
                account,
                Liquidation.LocalTokenParameters(
                    localCurrency,
                    localCurrencyRequired,
                    G_LIQUIDITY_HAIRCUT,
                    G_LIQUIDITY_TOKEN_REPO_INCENTIVE,
                    netCurrencyAvailable[localCurrency],
                    Portfolios()
                )
            );
        }

        if (localCurrencyRequired > 0 && netCurrencyAvailable[localCurrency] < 0) {
            uint128 localCurrencyPurchased = _purchaseDeposit(
                account,
                localCurrency,
                localCurrencyRequired,
                depositCurrency,
                cashClaims[depositCurrency],
                netCurrencyAvailable,
                true
            );

            localCurrencyCredit = localCurrencyCredit.add(localCurrencyPurchased);
            localCurrencySold = localCurrencySold.add(localCurrencyPurchased);
        }

        cashBalances[localCurrency][msg.sender] = cashBalances[localCurrency][msg.sender].subNoNeg(localCurrencySold);
        cashBalances[localCurrency][account] = cashBalances[localCurrency][account].add(localCurrencyCredit);

        return localCurrencyCredit;
    }

    function _purchaseDeposit(
        address payer,
        uint16 localCurrency,
        uint128 localCurrencyRequired,
        uint16 depositCurrency,
        int256 postHaircutCashClaim,
        int256[] memory netCurrencyAvailable,
        bool liquidate
    ) internal returns (uint128) {
        Liquidation.DepositCurrencyParameters memory parameters;
        Liquidation.RateParameters memory rateParameters;
        if (true) {
            parameters = Liquidation.DepositCurrencyParameters(
                localCurrencyRequired,
                netCurrencyAvailable[localCurrency],
                depositCurrency,
                postHaircutCashClaim,
                netCurrencyAvailable[depositCurrency],
                liquidate ? G_LIQUIDATION_DISCOUNT : G_SETTLEMENT_DISCOUNT,
                G_LIQUIDITY_HAIRCUT,
                Portfolios()
            );
        }

        if (true) {
            (uint256 rate, uint256 rateDecimals) = _exchangeRate(localCurrency, depositCurrency);
            rateParameters = Liquidation.RateParameters(
                rate,
                rateDecimals,
                currencyIdToDecimals[localCurrency],
                currencyIdToDecimals[depositCurrency]
            );
        }

        int256 payerBalance = cashBalances[depositCurrency][payer];
        uint128 localCurrencyPurchased;
        uint128 depositCurrencySold;

        if (liquidate) {
            uint128 localCurrencyHaircut = exchangeRateOracles[localCurrency][0].haircut;
            ( localCurrencyPurchased, depositCurrencySold, payerBalance ) = Liquidation.liquidate(
                payer,
                payerBalance,
                localCurrencyHaircut,
                parameters,
                rateParameters
            );
        } else {
            ( localCurrencyPurchased, depositCurrencySold, payerBalance ) = Liquidation.settle(
                payer,
                payerBalance,
                parameters,
                rateParameters
            );
        }

        cashBalances[depositCurrency][payer] = payerBalance;
        cashBalances[depositCurrency][msg.sender] = cashBalances[depositCurrency][msg.sender].add(depositCurrencySold);

        return localCurrencyPurchased;
    }

    /********** Settle Cash / Liquidation *************/

    /********** Internal Methods *********************/

    function _attemptToSettleWithFutureCash(
        address payer,
        uint16 currency,
        uint128 localCurrencyRequired
    ) internal returns (uint128) {
        // This call will attempt to sell future cash tokens in return for local currency. We do this as a last ditch effort
        // before we dip into reserves. The free collateral position will not change as a result of this method since positive
        // future cash (in this version) does not affect free collateral.
        uint128 cashShortfall = Portfolios().raiseCollateralViaCashReceiver(payer, currency, localCurrencyRequired);

        if (cashShortfall > 0 && _hasNoAssets(payer)) {
            // At this point, the portfolio has no positive future value associated with it and no collateral. It
            // is completely insolvent and therfore we need to pay out the remaining obligation from the reserve account.
            int256 reserveBalance = cashBalances[currency][G_RESERVE_ACCOUNT];

            if (cashShortfall > reserveBalance && reserveBalance > 0) {
                // Partially settle the cashShortfall if the reserve account does not have enough balance
                cashBalances[currency][G_RESERVE_ACCOUNT] = 0;
                return localCurrencyRequired.sub(cashShortfall).add(uint128(reserveBalance));
            } else if (reserveBalance > cashShortfall) {
                cashBalances[currency][G_RESERVE_ACCOUNT] = reserveBalance - cashShortfall;
                // We have settled out the entire balance here
                return localCurrencyRequired;
            }
        }

        return localCurrencyRequired.sub(cashShortfall);
    }

    /**
     * @notice Internal method for calling free collateral.
     *
     * @param account the account to check free collateral for
     * @return amount of free collateral
     */
    function _freeCollateral(address account) internal returns (int256) {
        (
            int256 fc, /* int256[] memory */, /* int256[] memory */

        ) = Portfolios().freeCollateral(account);
        return fc;
    }

    /**
     * @notice Converts a balance between token addresses.
     *
     * @param base base currency
     * @param balance amount to convert
     * @return the converted balance denominated in ETH with 18 decimal places
     */
    function _convertToETH(uint16 base, int256 balance, bool haircut) internal view returns (int256) {
        ExchangeRate memory er = exchangeRateOracles[base][0];
        uint256 baseDecimals = currencyIdToDecimals[base];

        // Fetches the latest answer from the chainlink oracle and haircut it by the apporpriate amount.
        uint256 rate = _fetchExchangeRate(er, false);
        uint128 absBalance = uint128(balance.abs());

        // We are converting to ETH here so we know that it has Common.DECIMAL precision. The calculation here is:
        // baseDecimals * rateDecimals * Common.DECIMAL /  (rateDecimals * baseDecimals)
        // er.haircut is in Common.DECIMAL precision
        // We use uint256 to do the calculation and then cast back to int256 to avoid overflows.
        int256 result = int256(
            SafeCast.toUint128(rate
                .mul(absBalance)
                .mul(haircut ? er.haircut : Common.DECIMALS)
                .div(er.rateDecimals)
                // Haircut has 18 decimal places of precision
                .div(baseDecimals)
            )
        );

        return balance > 0 ? result : result.neg();
    }

    /**
     * @notice Converts the balance denominated in ETH to the equivalent value in base.
     * @param base currency to convert to
     * @param balance amount (denominated in ETH) to convert
     */
    function _convertETHTo(uint16 base, int256 balance) internal view returns (int256) {
        ExchangeRate memory er = exchangeRateOracles[base][0];
        uint256 baseDecimals = currencyIdToDecimals[base];

        uint256 rate = _fetchExchangeRate(er, true);
        uint128 absBalance = uint128(balance.abs());

        // We are converting from ETH here so we know that it has Common.DECIMAL precision. The calculation here is:
        // ethDecimals * rateDecimals * baseDecimals / (ethDecimals * rateDecimals)
        // er.haircut is in Common.DECIMAL precision
        // We use uint256 to do the calculation and then cast back to int256 to avoid overflows.
        int256 result = int256(
            SafeCast.toUint128(rate
                .mul(absBalance)
                .mul(baseDecimals)
                .div(Common.DECIMALS)
                .div(er.rateDecimals)
            )
        );

        return balance > 0 ? result : result.neg();
    }

    /**
     * @notice Calculates the exchange rate between two currencies. Returns the rate and the decimal
     * precision of the base rate.
     */
    function _exchangeRate(uint16 base, uint16 quote) internal view returns (uint256, uint256) {
        ExchangeRate memory er = exchangeRateOracles[base][0];

        uint256 rate = _fetchExchangeRate(er, false);

        if (quote != 0) {
            ExchangeRate memory quoteER = exchangeRateOracles[quote][0];
            uint256 quoteRate = _fetchExchangeRate(quoteER, false);

            rate = rate.mul(quoteER.rateDecimals).div(quoteRate);
        }

        return (rate, er.rateDecimals);
    }

    function _fetchExchangeRate(ExchangeRate memory er, bool invert) internal view returns (uint256) {
        int256 rate = IAggregator(er.rateOracle).latestAnswer();
        require(rate > 0, $$(ErrorCode(INVALID_EXCHANGE_RATE)));

        if (invert || (er.mustInvert && !invert)) {
            // If the ER is inverted and we're NOT asking to invert then we need to invert the rate here.
            return uint256(er.rateDecimals).mul(er.rateDecimals).div(uint256(rate));
        }

        return uint256(rate);
    }

    function _hasCollateral(address account) internal view returns (bool) {
        for (uint256 i; i <= maxCurrencyId; i++) {
            if (cashBalances[uint16(i)][account] > 0) {
                return true;
            }
        }

        return false;
    }

    function _hasNoAssets(address account) internal view returns (bool) {
        Common.Asset[] memory portfolio = Portfolios().getAssets(account);
        for (uint256 i; i < portfolio.length; i++) {
            // This may be cash receiver or liquidity tokens
            if (Common.isReceiver(portfolio[i].swapType)) {
                return false;
            }
        }

        return true;
    }
}
