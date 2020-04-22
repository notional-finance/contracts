pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./lib/SafeUInt128.sol";
import "./lib/SafeInt256.sol";
import "./lib/UniswapExchangeInterface.sol";
import "./lib/ABDKMath64x64.sol";

import "./lib/SafeMath.sol";
import "./lib/Ownable.sol";
import "./lib/IERC20.sol";


/** A demo contract of the future cash market */
contract FutureCash is Ownable {
    using SafeUInt128 for uint128;
    using SafeMath for uint256;
    using SafeInt256 for int256;

    uint32 public G_NUM_PERIODS;
    uint128 public G_ETH_HAIRCUT;
    uint128 public G_PORTFOLIO_HAIRCUT;
    uint128 public G_MAX_TRADE_SIZE;

    uint32 public G_RATE_ANCHOR;
    uint16 public G_RATE_SCALAR;

    uint32 public G_LIQUIDITY_FEE;
    uint128 public G_LIQUIDATION_BONUS;
    uint128 public G_LIQUIDATION_BUFFER;
    uint128 public constant DECIMALS = 1e18;
    uint32 public constant INSTRUMENT_PRECISION = 1e9;
    int128 internal constant PRECISION_64x64 = 0x3b9aca000000000000000000;
    uint128 internal constant MAX_UINT_128 = (2**128)-1;

    // These are constants set at deployment.
    uint32 public G_PERIOD_SIZE;
    address public G_DAI_CONTRACT;
    address public G_UNISWAP_DAI_CONTRACT;

    constructor(uint32 periodSize, address daiContract, address exchange) public {
        G_PERIOD_SIZE = periodSize;
        G_DAI_CONTRACT = daiContract;
        G_UNISWAP_DAI_CONTRACT = exchange;
    }

    function setRateFactors(uint32 rateAnchor, uint16 rateScalar) external onlyOwner {
        require(rateScalar >= 0 && rateAnchor >= 0, $$(ErrorCode(INVALID_RATE_FACTORS)));
        G_RATE_SCALAR = rateScalar;
        G_RATE_ANCHOR = rateAnchor;
    }

    function setHaircutSize(uint128 eth, uint128 portfolio) external onlyOwner {
        G_ETH_HAIRCUT = eth;
        // This buffer accounts for slippage when selling off ETH for Dai.
        G_LIQUIDATION_BUFFER = DECIMALS.sub(eth.add(5e16));
        // We expect this to be DECIMALS + a fractional amount
        G_PORTFOLIO_HAIRCUT = portfolio;
    }

    function setMaxTradeSize(uint128 amount) external onlyOwner {
        G_MAX_TRADE_SIZE = amount;
    }

    function setNumPeriods(uint32 numPeriods) external onlyOwner {
        G_NUM_PERIODS = numPeriods;
    }

    function setFee(uint32 liquidityFee) external onlyOwner {
        G_LIQUIDITY_FEE = liquidityFee;
    }

    // Holds the total balance of future cash and current cash in the corresponding market. Future cash
    // matures at its corresponding period id.
    struct Market {
        uint128 totalFutureCash;
        uint128 totalLiquidity;
        uint128 totalCollateral;
        // These factors are set when the market is instantiated by a liquidity provider via the global
        // settings and then held constant for the duration of the maturity. We cannot change them without
        // really messing up the market rates.
        uint16 rateScalar;
        uint32 rateAnchor;
        // This is the implied rate that we use to smooth the anchor rate between trades.
        uint32 lastImpliedRate;
    }

    /** Types of Trades **/
    // Represents an obligation of the holder to pay the notional amount at maturity
    uint8 public constant CASH_PAYER = 1;
    // Represents an future cash flow that the holder will receive at maturity
    uint8 public constant CASH_RECEIVER = 2;
    // Represents an share of a liquidity pool at the designated maturity
    uint8 public constant LIQUIDITY_TOKEN = 3;

    // This holds a trade object that goes into an account's portfolio
    struct Trade {
        // The type of trade, can only be one of the trades noted above
        uint8 tradeType;
        // The block that this trade matures at
        uint32 maturity;
        // The amount of notional for the trade.
        uint128 notional;
    }

    // This is a mapping between period ids and a market. Each market contains the balance of future cash
    // (cash that matures at the periodId) and current cash. The exchange rate between these two pools defines
    // a discount rate.
    mapping(uint32 => Market) public markets;

    // Collateral Balances
    mapping(address => uint128) public ethBalances;
    mapping(address => uint128) public daiBalances;

    // Portfolios
    mapping(address => Trade[]) public accountTrades;

    // Current Cash Balances
    mapping(address => int256) public daiCashBalances;

    /** Returns the trade array */
    function getAccountTrades(address account) public view returns (Trade[] memory) {
        return accountTrades[account];
    }

    event TransferEth(address indexed account, uint256 amount, bool isDeposit);
    event TransferDai(address indexed account, uint256 amount, bool isDeposit);
    event TransferAsset(address indexed from, address indexed to, uint8 tradeType, uint32 maturity, uint128 notional);
    event CreateAsset(address indexed account, uint8 tradeType, uint32 maturity, uint128 futureCash, uint128 daiAmount);
    event AddLiquidity(address indexed account, uint32 maturity, uint128 tokens, uint128 futureCash, uint128 daiAmount);
    event RemoveLiquidity(
        address indexed account,
        uint32 maturity,
        uint128 tokens,
        uint128 futureCash,
        uint128 daiAmount
    );
    event UpdateCashBalance(address indexed account, int256 amount);
    event SettleCash(address indexed from, address indexed to, uint128 amount);

    /**
     * @notice Deposit ETH to use as collateral for loans. All future cash is denominated in Dai so this is only
     * useful as collateral for borrowing. Lenders will have to deposit dai in order to purchase future cash.
     * The amount of eth deposited should be set in `msg.value`.
     */
    function depositEth() public payable {
        require(msg.value <= MAX_UINT_128, $$(ErrorCode(OVER_MAX_ETH_BALANCE)));
        ethBalances[msg.sender] = ethBalances[msg.sender].add(uint128(msg.value));

        emit TransferEth(msg.sender, msg.value, true);
    }

    /**
     * @notice Withdraw ETH from the contract. This can only be done after a successful free collateral check.
     * @dev We do not use `msg.sender.transfer` or `msg.sender.send` as recommended by Consensys:
     * https://diligence.consensys.net/blog/2019/09/stop-using-soliditys-transfer-now/
     *
     * @param amount the amount of eth to withdraw from the contract
     */
    function withdrawEth(uint128 amount) public {
        uint128 balance = ethBalances[msg.sender];
        // Do all of these checks before we actually transfer the ETH to limit re-entrancy.
        require(balance >= amount, $$(ErrorCode(INSUFFICIENT_BALANCE)));
        ethBalances[msg.sender] = balance.sub(amount);
        require(_settleAndFreeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        // solium-disable-next-line security/no-call-value
        (bool success, ) = msg.sender.call.value(amount)("");
        require(success, $$(ErrorCode(TRANSFER_FAILED)));

        emit TransferEth(msg.sender, amount, false);
    }

    /**
     * @notice Deposit DAI into the contract for lending. The Dai contract must give proper allowances to this
     * contract in order to do the transfer from the sender.
     *
     * @param amount the amount of dai to deposit into the contract
     */
    function depositDai(uint128 amount) public {
        daiBalances[msg.sender] = daiBalances[msg.sender].add(amount);
        IERC20(G_DAI_CONTRACT).transferFrom(msg.sender, address(this), amount);

        emit TransferDai(msg.sender, amount, true);
    }

    /**
     * @notice Withdraw Dai from the contract back to the sender. Can only be done if the sender passes a free
     * collateral check.
     *
     * @param amount the amount of dai to withdraw
     */
    function withdrawDai(uint128 amount) public {
        uint128 balance = daiBalances[msg.sender];
        require(balance >= amount, $$(ErrorCode(INSUFFICIENT_BALANCE)));

        daiBalances[msg.sender] = balance.sub(amount);
        require(_settleAndFreeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        IERC20(G_DAI_CONTRACT).transferFrom(address(this), msg.sender, amount);
        emit TransferDai(msg.sender, amount, false);
    }

    /**
     * @notice Transfers the future cash from the sender to the specified destination address. This can only be done
     * with CASH_RECEIVER or LIQUIDITY_TOKEN objects. CASH_PAYER represents and obligation and therefore it
     * cannot be transferred. The sender must pass a free collateral check, the receiver will be NPV positive
     * after the transfer so they do not require a free collateral check.
     *
     * @param to the destination account to send the token to
     * @param index the position in an account's portfolio to transfer
     * @param amount the amount of notional to transfer
     */
    function transferFutureCash(address to, uint256 index, uint128 amount) public {
        // Check that this is cash receiver or liquidity token
        Trade memory trade = accountTrades[msg.sender][index];
        require(
            trade.tradeType == CASH_RECEIVER || trade.tradeType == LIQUIDITY_TOKEN,
            $$(ErrorCode(INVALID_TRANSFER_TYPE))
        );
        require(trade.notional <= amount, $$(ErrorCode(INSUFFICIENT_BALANCE)));

        // Subtract the balance of this token from the account and then check if it is still collateralized.
        if (trade.notional == amount) {
            _removeTrade(accountTrades[msg.sender], index);
        } else {
            accountTrades[msg.sender][index].notional = trade.notional - amount;
        }
        require(_settleAndFreeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        // If the check passes, then we can finish the transfer.
        trade.notional = amount;
        _upsertTrade(to, trade);

        emit TransferAsset(msg.sender, to, trade.tradeType, trade.maturity, trade.notional);
    }

    /**
     * @notice Settles all matured cash trades and liquidity tokens in a user's portfolio. This method is
     * unauthenticated, anyone may settle the trades in any account. This is required for accounts that
     * have negative cash and counterparties need to settle against them.
     *
     * @param account the address of the account to settle
     */
    function settle(address account) public {
        uint32 blockNum = uint32(block.number);
        Trade[] storage portfolio = accountTrades[account];
        int256 cashBalance = daiCashBalances[account];

        // Loop through the list of portfolio and find the ones that have matured.
        for (uint256 i; i < portfolio.length; i++) {
            if (portfolio[i].maturity <= blockNum) {
                if (portfolio[i].tradeType == CASH_PAYER) {
                    // If the trade is a payer, we subtract from the cash balance
                    cashBalance = cashBalance.sub(portfolio[i].notional);
                } else if (portfolio[i].tradeType == CASH_RECEIVER) {
                    // If the trade is a receiver, we add to the cash balance
                    cashBalance = cashBalance.add(portfolio[i].notional);
                } else if (portfolio[i].tradeType == LIQUIDITY_TOKEN) {
                    // Settling liquidity tokens is a bit more involved since we need to remove
                    // money from the collateral pools. This function returns the amount of future cash
                    // the liquidity token has a claim to.
                    cashBalance = cashBalance.add(
                        _settleLiquidityToken(account, portfolio[i].notional, portfolio[i].maturity)
                    );
                }

                // Remove trade from the portfolio
                _removeTrade(portfolio, i);
                // The portfolio has gotten smaller, so we need to go back to account
                // for the removed trade.
                i--;
            }
        }

        daiCashBalances[account] = cashBalance;
        emit UpdateCashBalance(account, cashBalance);
    }

    /**
     * @notice The batch version of the `settle` call.
     *
     * @param accounts an array of addresses to settle
     */
    function settleBatch(address[] calldata accounts) external {
        for (uint256 i; i < accounts.length; i++) {
            settle(accounts[i]);
        }
    }

    /**
     * @notice Settles cash balances that parties hold. This is an important concept in Swapnet because we cannot settle
     * trades directly to collateral. Parties must find counterparty with enough of a negative current cash balance
     * to settle against before they can withdraw their collateral.
     *
     * @param counterparty the counterparty to settle a cash balance against
     * @param value the amount of cash (positive or negative) to settle
     */
    function settleCash(address counterparty, int256 value) external {
        require(msg.sender != counterparty, $$(ErrorCode(COUNTERPARTY_CANNOT_BE_SELF)));
        // First we settle any matured trades in both parties portfolios.
        settle(msg.sender);
        settle(counterparty);

        // Nothing to do if value is set to 0
        if (value == 0) return;
        // We now calculate who receiving cash and who is paying cash in this scenario.
        address payer;
        address receiver;
        // This is the absolute value of `value` once we know the direction of the cash flow.
        uint128 positiveValue;

        if (value > 0) {
            // Settling a positive balance so collateral will flow from counterparty -> msg.sender
            (payer, receiver) = (counterparty, msg.sender);
            positiveValue = uint128(value);
        } else {
            // Settling a negative balance so collateral will flow from msg.sender -> counterparty
            (payer, receiver) = (msg.sender, counterparty);
            positiveValue = uint128(value.neg());
        }

        // This cash account must have enough negative cash balance to actually owe this amount.
        require(daiCashBalances[payer] <= int256(positiveValue).neg(), $$(ErrorCode(INSUFFICIENT_CASH_BALANCE)));

        // Cash balances can only be settled against accounts with free collateral. If the account has insuffient
        // free collateral, they must be liquidated instead.
        require(_settleAndFreeCollateral(payer) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        // Net out cash balances, the payer no longer owes this cash. The receiver is no longer owed this cash.
        daiCashBalances[payer] = daiCashBalances[payer].add(positiveValue);
        daiCashBalances[receiver] = daiCashBalances[receiver].sub(positiveValue);

        uint128 payerDaiBalance = daiBalances[payer];
        if (payerDaiBalance < positiveValue) {
            // If the payer has free collateral but not enough dai balance to actually transfer to the receiver,
            // we have two options: convert their ETH to Dai via Uniswap or sell out their positive NPV posititions
            // in the market for dai. In Swapnet Lite we will first trade away ETH collateral for dai in order to make
            // the payment.

            uint256 daiRemaining = uint256(positiveValue - payerDaiBalance);
            // This is the remaining amount of dai required.
            daiRemaining = _liquidate(payer, daiRemaining);

            // At this point we need to raise sufficient dai from liquidity tokens in order to cash out. Because
            // we do not allow cross margin between periods, the only way that an account can be in this situation
            // is if they have a negative cash balance and their free collateral comes from a daiClaim from liquidity
            // tokens in the future.
            if (daiRemaining > 0) {
                daiBalances[payer] = _raiseCashFromPortfolio(payer, daiRemaining);
            } else {
                // Otherwise, all the dai balance the payer had is removed here.
                delete daiBalances[payer];
            }

            // Pay the receiver the dai they are owed.
            daiBalances[receiver] = daiBalances[receiver].add(positiveValue);
        } else {
            // Here the payer has enough Dai to cover the imbalance outright.
            daiBalances[payer] = daiBalances[payer].sub(positiveValue);
            daiBalances[receiver] = daiBalances[receiver].add(positiveValue);
        }

        emit SettleCash(payer, receiver, positiveValue);
    }

    /**
     * @notice Liquidates an account when it becomes undercollateralized. It does this by selling off
     * any ETH. Then it pays a liquidity reward to the liquidator. Finally, it uses the remaining dai
     * to purchase offsetting positions to any outstanding obligations (i.e. CASH_PAYER tokens) to de-risk
     * the portfolio.
     *
     * @param account the account to liquidate
     */
    function liquidate(address account) public {
        settle(account);
        (int256 daiRequired, int256[] memory cashLadder) = freeCollateralAndCashLadder(account);
        require(daiRequired < 0, $$(ErrorCode(CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL)));
        // We increase the daiRequired to account for the loss in value of the ETH that
        // we need to sell here.
        daiRequired = daiRequired.neg().mul(DECIMALS).div(G_LIQUIDATION_BUFFER);
        // If this returns a positive number then we are in trouble since the
        // account will end up under collateralized. However, can't revert here and we
        // will just continue.
        _liquidate(account, uint256(daiRequired).add(G_LIQUIDATION_BONUS));

        // Pay G_LIQUIDATION_BONUS back to msg.sender
        daiBalances[msg.sender] = daiBalances[msg.sender].add(G_LIQUIDATION_BONUS);

        // This second read is a bit inefficient but we only need to go as far into the portfolio
        // in order to spend all the dai.
        uint128 daiRemaining = uint128(daiRequired);
        uint32 blockNum = uint32(block.number);
        Trade[] storage portfolio = accountTrades[account];
        for (uint256 i; i < portfolio.length; i++) {
            if (portfolio[i].tradeType == CASH_PAYER) {
                Trade memory asset = portfolio[i];
                uint256 offset = (portfolio[i].maturity - blockNum) / G_PERIOD_SIZE;
                if (cashLadder[offset] > 0) {
                    // If the cashLadder for this maturity is positive, then we keep iterating.
                    continue;
                }

                Market storage market = markets[asset.maturity];
                // The floor for the value these positions is at a 1-1 exchange rate. This is the least favorable rate
                // for the liquidated account since we guarantee that exchange rates cannot go below zero.
                if (daiRemaining >= asset.notional && market.totalFutureCash >= asset.notional) {
                    // We can purchase more future cash than we have in this asset so let's get the cost to
                    // just offset this position.
                    uint128 daiCost = getFutureCashToDai(asset.maturity, asset.notional);

                    // A dai cost of 0 signifies a failed trade.
                    if (daiCost > 0) {
                        market.totalCollateral = market.totalCollateral.add(daiCost);
                        // Already did overflow check above.
                        market.totalFutureCash = market.totalFutureCash - asset.notional;
                        daiRemaining = daiRemaining - daiCost;

                        _removeTrade(portfolio, i);
                        i--;
                    }
                } else if (market.totalFutureCash >= daiRemaining) {
                    // We cannot accurately calculate how much future cash we can possibly offset here, but
                    // we know that it is at least "daiRemaining". Figure out the cost for that and then
                    // proceed.
                    uint128 daiCost = getFutureCashToDai(asset.maturity, daiRemaining);

                    if (daiCost > 0) {
                        // We can only partially offset the future cash we have in the asset so just update
                        // the asset.
                        market.totalCollateral = market.totalCollateral.add(daiCost);
                        // Already did overflow check above.
                        market.totalFutureCash = market.totalFutureCash - daiRemaining;
                        portfolio[i].notional = asset.notional - daiRemaining;
                        daiRemaining = daiRemaining - daiCost;
                    }
                }

                // No dai left so just return.
                if (daiRemaining == 0) {
                    return;
                }
            }
        }

        // In the case that there is dai left over, we add it back to the balances here.
        daiBalances[account] = daiBalances[account].add(daiRemaining);
    }

    /**
     * Internal function that liquidates an account in order to raise `daiRequired`. It always raises this amount
     * exactly. We know that this amount is available in the portfolio because of the freeCollateral check.
     */
    function _liquidate(address account, uint256 daiRequired) internal returns (uint256) {
        uint256 ethBalance = uint256(ethBalances[account]);
        uint256 daiRemaining = daiRequired;
        if (ethBalance > 0) {
            // First determine how much dai the ethBalance would trade for. If it is enough then we will just trade what is
            // required. If not then we will trade all the ETH and move on to the account's portfolio.
            uint256 ethRequired = UniswapExchangeInterface(G_UNISWAP_DAI_CONTRACT).getEthToTokenOutputPrice(
                daiRequired
            );
            if (ethBalance >= ethRequired) {
                // This will trade exactly the amount of ethRequired for exactly the amount of dai required.
                UniswapExchangeInterface(G_UNISWAP_DAI_CONTRACT).ethToTokenSwapOutput.value(ethRequired)(
                    daiRequired,
                    block.timestamp
                    // solium-disable-previous-line security/no-block-members
                );

                // Reduce the eth balance by the amount traded.
                ethBalances[account] = uint128(ethBalance - ethRequired);
                daiRemaining = 0;
            } else {
                // In here we will sell off all the ETH that the account holds. When settling cash, we can then move on to
                // removing liquidity tokens for dai claims. When liquidating an account, we do not need to do that so this
                // should not occur during liquidation.
                uint256 daiTraded = UniswapExchangeInterface(G_UNISWAP_DAI_CONTRACT).ethToTokenSwapInput.value(
                    ethBalance
                )(1, block.timestamp);
                // solium-disable-previous-line security/no-block-members

                delete ethBalances[account];
                daiRemaining = daiRemaining - daiTraded;
            }
        }

        return daiRemaining;
    }

    /**
     * @notice Checks that an account has sufficient collateral to cover its obligations. This works by calculating the
     * difference between two amounts, the net present value of the portfolio and the value of the cash and collateral
     * on hand, denominated in dai.
     *
     * @param account the account to do the check for
     * @return the free collateral figure
     */
    function freeCollateral(address account) public view returns (int256) {
        (
            int256 fc, /*int256[] memory*/

        ) = freeCollateralAndCashLadder(account);
        return fc;
    }

    function freeCollateralAndCashLadder(address account) public view returns (int256, int256[] memory) {
        Trade[] memory portfolio = accountTrades[account];
        uint32 blockNum = uint32(block.number);
        // Each position in this array will hold the value of the portfolio in each maturity.
        int256[] memory cashLadder = new int256[](G_NUM_PERIODS);
        // This will hold the current collateral balance.
        int256 currentCollateral;

        // This will work regardless of whether or not the trades in the portfolio have matured or not since the
        // discount rate == 0 after the trade has matured. However, the internal version of this function will
        // settle any trades before doing this loop.
        for (uint256 i; i < portfolio.length; i++) {
            int256 futureCash;

            if (portfolio[i].tradeType == LIQUIDITY_TOKEN) {
                Market memory market = markets[portfolio[i].maturity];
                // These are the claims on the collateral and future cash in the markets. The dai claim
                // goes to current collateral. This is important to note since we will use this daiClaim
                // to settle negative cash balances if required.
                uint128 daiClaim = uint128(
                    uint256(market.totalCollateral).mul(portfolio[i].notional).div(market.totalLiquidity)
                );
                currentCollateral = currentCollateral.add(daiClaim);

                futureCash = int256(
                    uint256(market.totalFutureCash).mul(portfolio[i].notional).div(market.totalLiquidity)
                );
            } else if (portfolio[i].tradeType == CASH_PAYER) {
                futureCash = int256(portfolio[i].notional).neg();
            } else {
                futureCash = int256(portfolio[i].notional);
            }

            if (blockNum >= portfolio[i].maturity) {
                // This is a matured future cash claim.
                currentCollateral = currentCollateral.add(futureCash);
            } else {
                // This is an actual future cash claim, we add it to the correct part of the
                // cash ladder.
                uint256 offset = (portfolio[i].maturity - blockNum) / G_PERIOD_SIZE;
                cashLadder[offset] = cashLadder[offset].add(futureCash);
            }
        }

        // If the account has an ethereum balance, convert it to the current dai value.
        uint256 ethBalance = uint256(ethBalances[account]);
        if (ethBalance > 0) {
            // The collateralization ratio is used as a discount factor for the amount of
            // dai that the ETH is worth. This will give us some buffer in the case of exchange
            // rate fluctuations.
            uint128 daiValue = uint128(
                UniswapExchangeInterface(G_UNISWAP_DAI_CONTRACT)
                    .getEthToTokenInputPrice(ethBalance)
                    .mul(G_ETH_HAIRCUT)
                    .div(DECIMALS)
            );
            currentCollateral = currentCollateral.add(daiValue);
        }

        // Net out cash balances and dai balances
        currentCollateral = currentCollateral.add(daiCashBalances[account]);
        currentCollateral = currentCollateral.add(daiBalances[account]);

        // Now we check to determine the aggregate negative amount in the cashLadder and see if
        // the amount of current collateral is sufficient.
        uint128 requiredCollateral;
        for (uint256 i; i < cashLadder.length; i++) {
            if (cashLadder[i] < 0) {
                // We do a negative haircut on cash ladder balances.
                uint128 postHaircut = uint128(cashLadder[i].neg().mul(G_PORTFOLIO_HAIRCUT).div(DECIMALS));
                requiredCollateral = requiredCollateral.add(postHaircut);
            }
        }

        return (currentCollateral.sub(requiredCollateral), cashLadder);
    }

    /**
     * @notice Adds some amount of future cash to the liquidity pool up to the corresponding amount defined by
     * `maxDai`. Mints liquidity tokens back to the sender.
     *
     * @param maturity the period to add liquidity to
     * @param minFutureCash the amount of future cash to add to the pool
     * @param maxDai the maximum amount of dai to add to the pool
     * @param maxBlock after this block the trade will fail
     */
    function addLiquidity(uint32 maturity, uint128 minFutureCash, uint128 maxDai, uint32 maxBlock) public {
        _isValidBlock(maturity, maxBlock);
        Market storage market = markets[maturity];
        // We call settle here instead of at the end of the function because if we have matured liquidity
        // tokens this will put dai back into our portfolio so that we can add it back into the markets.
        settle(msg.sender);

        uint128 collateral;
        uint128 liquidityTokenAmount;
        if (market.rateScalar == 0) {
            // We check the rateScalar to determine if the market exists or not. The reason for this is that once we
            // initialize a market we will set the rateScalar and rateAnchor based on global values for the duration
            // of the market. The proportion of future cash to dai that the first liquidity provider sets here will
            // determine the initial exchange rate of the market (taking into account rateScalar and rateAnchor, of course).
            // Governance will never allow rateScalar to be set to 0.
            market.totalFutureCash = minFutureCash;
            market.totalCollateral = maxDai;
            market.totalLiquidity = minFutureCash;
            market.rateAnchor = G_RATE_ANCHOR;
            market.rateScalar = G_RATE_SCALAR;
            // We have to initialize this to the exchange rate implied by the proportion of cash to future cash.
            uint32 blocksToMaturity = maturity - uint32(block.number);
            market.lastImpliedRate = _getImpliedRate(market, blocksToMaturity);

            liquidityTokenAmount = minFutureCash;
            collateral = maxDai;
        } else {
            // We calculate the amount of liquidity tokens to mint based on the share of the future cash
            // that the liquidity provider is depositing.
            liquidityTokenAmount = uint128(
                uint256(market.totalLiquidity).mul(minFutureCash).div(market.totalFutureCash)
            );

            // We use the prevailing exchange rate to calculate the required amount of current cash to deposit,
            // this ensures that the prevailing exchange rate does not change.
            collateral = uint128(uint256(market.totalCollateral).mul(minFutureCash).div(market.totalFutureCash));
            // If this exchange rate has moved beyond what the liquidity provider is willing to pay then we
            // will revert here.
            require(collateral <= maxDai, $$(ErrorCode(OVER_MAX_COLLATERAL)));

            // Add the future cash and collateral to the pool.
            market.totalFutureCash = market.totalFutureCash.add(minFutureCash);
            market.totalCollateral = market.totalCollateral.add(collateral);
            market.totalLiquidity = market.totalLiquidity.add(liquidityTokenAmount);
        }

        // Move the collateral into the contract's dai balances account.
        daiBalances[msg.sender] = daiBalances[msg.sender].sub(collateral);
        daiBalances[address(this)] = daiBalances[address(this)].add(collateral);

        // Add the liquidity tokens to the sender's balances.
        _upsertTrade(msg.sender, Trade(LIQUIDITY_TOKEN, maturity, liquidityTokenAmount));

        // Mark that this account now has a future cash obligation
        _upsertTrade(msg.sender, Trade(CASH_PAYER, maturity, minFutureCash));

        // We do not use the internal version of free collateral since we've already called settle earlier.
        require(freeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        emit AddLiquidity(msg.sender, maturity, liquidityTokenAmount, minFutureCash, collateral);
    }

    /**
     * @notice Removes liquidity from the future cash market. The sender's liquidity tokens are burned and they
     * are credited back with future cash and dai at the prevailing exchange rate. This function
     * only works when removing liquidity from an active market. For markets that are matured, the sender
     * must settle their liquidity token because it involves depositing current cash and settling future
     * cash balances.
     *
     * @param maturity the period to remove liquidity from
     * @param amount the amount of liquidity tokens to burn
     * @param index the index in the portfolio where the liquidity tokens are located
     * @param maxBlock after this block the trade will fail
     */
    function removeLiquidity(uint32 maturity, uint128 amount, uint256 index, uint32 maxBlock) public {
        Trade memory trade = accountTrades[msg.sender][index];
        require(trade.tradeType == LIQUIDITY_TOKEN, $$(ErrorCode(INVALID_TRADE)));
        require(trade.notional >= amount, $$(ErrorCode(INSUFFICIENT_BALANCE)));

        // This method only works when the market is active.
        _isValidBlock(maturity, maxBlock);
        Market storage market = markets[maturity];

        // Here we calculate the amount of current cash that the liquidity token represents.
        uint128 collateral = uint128(uint256(market.totalCollateral).mul(amount).div(market.totalLiquidity));
        market.totalCollateral = market.totalCollateral.sub(collateral);

        // This is the amount of future cash that the liquidity token has a claim to.
        uint128 futureCashAmount = uint128(uint256(market.totalFutureCash).mul(amount).div(market.totalLiquidity));
        market.totalFutureCash = market.totalFutureCash.sub(futureCashAmount);

        // We do this calculation after the previous two so that we do not mess with the totalLiquidity
        // figure when calculating futureCash and collateral.
        market.totalLiquidity = market.totalLiquidity.sub(amount);

        // Move the collateral from the contract's dai balances account back to the sender
        daiBalances[msg.sender] = daiBalances[msg.sender].add(collateral);
        daiBalances[address(this)] = daiBalances[address(this)].sub(collateral);

        // Remove the liquidity tokens from the sender's balance
        if (trade.notional == amount) {
            _removeTrade(accountTrades[msg.sender], index);
        } else {
            accountTrades[msg.sender][index].notional = trade.notional - amount;
        }

        // Credit the portfolio with a CASH_RECEIVER amount which will offset the future cash obligation the
        // provider had before.
        _upsertTrade(msg.sender, Trade(CASH_RECEIVER, maturity, futureCashAmount));

        require(_settleAndFreeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));

        emit RemoveLiquidity(msg.sender, maturity, amount, futureCashAmount, collateral);
    }

    /**
     * @notice Given the amount of future cash put into a market, how much current dai this would
     * purchase.
     *
     * @param maturity the maturity of the future cash
     * @param futureCashAmount the amount of future cash to input
     * @return the amount of current dai this would purchase, returns 0 if the trade will fail
     */
    function getFutureCashToDai(uint32 maturity, uint128 futureCashAmount) public view returns (uint128) {
        Market memory interimMarket = markets[maturity];
        uint32 blocksToMaturity = maturity - uint32(block.number);

        (/* market */, uint128 daiAmount) = _tradeCalculation(interimMarket, futureCashAmount, blocksToMaturity, true);
        // On trade failure, we will simply return 0
        return daiAmount;
    }

    /**
     * @notice Receive dai in exchange for a future cash obligation which must be collateralized
     * by ETH or other future cash receiver obligations. Equivalent to borrowing dai at a fixed rate.
     *
     * @param maturity the maturity block of the future cash being exchange for current cash
     * @param futureCashAmount the amount of future cash to deposit, will convert this amount to current cash
     *  at the prevailing exchange rate
     * @param maxBlock after this block the trade will not settle
     * @param minDai the minimum amount of dai this trade should purchase, this is the slippage amount
     * @return the amount of dai purchased
     */
    function takeDai(uint32 maturity, uint128 futureCashAmount, uint32 maxBlock, uint128 minDai)
        public
        returns (uint128)
    {
        _isValidBlock(maturity, maxBlock);
        require(futureCashAmount <= G_MAX_TRADE_SIZE, $$(ErrorCode(TRADE_FAILED_TOO_LARGE)));
        Market storage market = markets[maturity];
        Market memory interimMarket = markets[maturity];
        uint128 daiAmount;
        uint32 blocksToMaturity = maturity - uint32(block.number);
        (interimMarket, daiAmount) = _tradeCalculation(interimMarket, futureCashAmount, blocksToMaturity, true);

        require(daiAmount > 0, $$(ErrorCode(TRADE_FAILED_LACK_OF_LIQUIDITY)));
        require(daiAmount >= minDai, $$(ErrorCode(TRADE_FAILED_SLIPPAGE)));

        // Here we update all the required storage values.
        market.totalFutureCash = interimMarket.totalFutureCash;
        market.totalCollateral = interimMarket.totalCollateral;
        market.lastImpliedRate = interimMarket.lastImpliedRate;
        market.rateAnchor = interimMarket.rateAnchor;

        // Move the collateral from the contract's dai balances account to the sender
        daiBalances[msg.sender] = daiBalances[msg.sender].add(daiAmount);
        daiBalances[address(this)] = daiBalances[address(this)].sub(daiAmount);

        // The sender now has an obligation to pay cash at maturity.
        Trade memory trade = Trade(CASH_PAYER, maturity, futureCashAmount);
        _upsertTrade(msg.sender, trade);

        require(_settleAndFreeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
        emit CreateAsset(msg.sender, trade.tradeType, trade.maturity, trade.notional, daiAmount);

        return daiAmount;
    }

    /**
     * @notice Given the amount of future cash to purchase, returns the amount of dai thsi would cost.
     *
     * @param maturity the maturity of the future cash
     * @param futureCashAmount the amount of future cash to purchase
     * @return the amount of dai this would cost, returns 0 on trade failure
     */
    function getDaiToFutureCash(uint32 maturity, uint128 futureCashAmount) public view returns (uint128) {
        Market memory interimMarket = markets[maturity];
        uint32 blocksToMaturity = maturity - uint32(block.number);

        (/* market */, uint128 daiAmount) = _tradeCalculation(interimMarket, futureCashAmount, blocksToMaturity, false);
        // On trade failure, we will simply return 0
        return daiAmount;
    }

    /**
     * @notice Deposit dai in return for the right to receive cash at the specified maturity. Equivalent to lending
     * your dai at a fixed rate.
     *
     * @param maturity the period to receive future cash in
     * @param futureCashAmount the amount of future cash to purchase
     * @param maxBlock after this block the trade will not settle
     * @param maxDai the maximum amount of dai to deposit for this future cash, this is the slippage amount
     * @return the amount of future cash purchased
     */
    function takeFutureCash(uint32 maturity, uint128 futureCashAmount, uint32 maxBlock, uint128 maxDai)
        public
        returns (uint128)
    {
        _isValidBlock(maturity, maxBlock);
        require(futureCashAmount <= G_MAX_TRADE_SIZE, $$(ErrorCode(TRADE_FAILED_TOO_LARGE)));
        Market storage market = markets[maturity];
        Market memory interimMarket = markets[maturity];
        uint128 daiAmount;
        uint32 blocksToMaturity = maturity - uint32(block.number);
        (interimMarket, daiAmount) = _tradeCalculation(interimMarket, futureCashAmount, blocksToMaturity, false);

        require(daiAmount > 0, $$(ErrorCode(TRADE_FAILED_LACK_OF_LIQUIDITY)));
        require(daiAmount <= maxDai, $$(ErrorCode(TRADE_FAILED_SLIPPAGE)));

        // Here we update all the required storage values.
        market.totalFutureCash = interimMarket.totalFutureCash;
        market.totalCollateral = interimMarket.totalCollateral;
        market.lastImpliedRate = interimMarket.lastImpliedRate;
        market.rateAnchor = interimMarket.rateAnchor;

        // Move the collateral from the sender to the contract address
        daiBalances[msg.sender] = daiBalances[msg.sender].sub(daiAmount);
        daiBalances[address(this)] = daiBalances[address(this)].add(daiAmount);

        // The sender is now owed a future cash balance at maturity
        Trade memory trade = Trade(CASH_RECEIVER, maturity, futureCashAmount);
        _upsertTrade(msg.sender, trade);

        require(_settleAndFreeCollateral(msg.sender) >= 0, $$(ErrorCode(INSUFFICIENT_FREE_COLLATERAL)));
        emit CreateAsset(msg.sender, trade.tradeType, trade.maturity, trade.notional, daiAmount);
    }

    /**
     * @notice Returns the current discount rate for the market. This will return 0 when presented with a negative
     * interest rate.
     *
     * @param maturity the maturity to get the rate for
     * @return a tuple where the first value is the simple discount rate and the second value is a boolean indicating
     *  whether or not the maturity has passed
     */
    function getRate(uint32 maturity) public view returns (uint32, bool) {
        Market memory market = markets[maturity];
        if (block.number >= maturity) {
            // The exchange rate is 1 after we hit maturity for the future cash market.
            return (INSTRUMENT_PRECISION, true);
        } else {
            uint32 blocksToMaturity = maturity - uint32(block.number);
            market.rateAnchor = _getNewRateAnchor(market, blocksToMaturity);
            uint32 rate = _getExchangeRate(market, blocksToMaturity, 0);
            return (rate, false);
        }
    }

    /**
     * @notice Gets the rates for all the active markets.
     *
     * @return an array of rates starting from the most current maturity to the furthest maturity
     */
    function getMarketRates() external view returns (uint32[] memory) {
        uint32[] memory marketRates = new uint32[](G_NUM_PERIODS);
        uint32 maturity = uint32(block.number) - (uint32(block.number) % G_PERIOD_SIZE) + G_PERIOD_SIZE;
        for (uint256 i; i < marketRates.length; i++) {
            (uint32 rate, ) = getRate(maturity);
            marketRates[i] = rate;

            maturity = maturity + G_PERIOD_SIZE;
        }

        return marketRates;
    }

    /**
     * @notice Gets the maturities for all the active markets.
     *
     * @return an array of blocks where the currently active markets will mature at
     */
    function getActiveMaturities() public view returns (uint32[] memory) {
        uint32[] memory ids = new uint32[](G_NUM_PERIODS);
        uint32 blockNum = uint32(block.number);
        uint32 currentMaturity = blockNum - (blockNum % G_PERIOD_SIZE) + G_PERIOD_SIZE;
        for (uint256 i; i < ids.length; i++) {
            ids[i] = currentMaturity + uint32(i) * G_PERIOD_SIZE;
        }
        return ids;
    }

    /*********** Internal Methods ********************/

    /**
     * Internal version of freeCollateral, settles any trades in the account before actually
     * doing the calculation. We do this to prevent portfolios from growing too large.
     */
    function _settleAndFreeCollateral(address account) internal returns (int256) {
        settle(account);
        return freeCollateral(account);
    }

    /**
     * Raises cash from the trades in the portfolio from liquidity tokens.
     *
     * @param account the account to raise cash from
     * @param daiRequired the amount of dai required
     * @return the amount of dai to return to balances
     */
    function _raiseCashFromPortfolio(address account, uint256 daiRequired) internal returns (uint128) {
        Trade[] memory portfolio = accountTrades[account];
        uint128 daiRemaining = uint128(daiRequired);
        uint128 daiToReturn;
        uint256[] memory indexesToRemove = new uint256[](G_NUM_PERIODS);
        Trade[] memory futureCashToAdd = new Trade[](G_NUM_PERIODS);
        uint256 indexes;

        // Look for any liquidity tokens in the portfolio. We will remove them from the market and put the dai and
        // future cash back into the account's portfolio
        for (uint256 i; i < portfolio.length; i++) {
            if (portfolio[i].tradeType == LIQUIDITY_TOKEN) {
                Market memory market = markets[portfolio[i].maturity];

                uint128 dai = uint128(
                    uint256(market.totalCollateral).mul(portfolio[i].notional).div(market.totalLiquidity)
                );

                uint128 futureCash = uint128(
                    uint256(market.totalFutureCash).mul(portfolio[i].notional).div(market.totalLiquidity)
                );

                // Update the market to remove the dai, futureCash and liquidiy tokens.
                markets[portfolio[i].maturity].totalCollateral = market.totalCollateral.sub(dai);
                markets[portfolio[i].maturity].totalFutureCash = market.totalFutureCash.sub(futureCash);
                markets[portfolio[i].maturity].totalLiquidity = market.totalLiquidity.sub(portfolio[i].notional);

                // Mark the index for removal and marke the amount of future cash to return to the portfolio
                indexesToRemove[indexes] = i;
                futureCashToAdd[indexes] = Trade(CASH_RECEIVER, portfolio[i].maturity, futureCash);
                indexes++;

                if (dai >= daiRemaining) {
                    daiToReturn = dai - daiRemaining;
                    daiRemaining = 0;
                    break;
                } else {
                    daiRemaining = daiRemaining - dai;
                }
            }
        }

        // We should have raised at least daiRequired here.
        assert(daiRemaining == 0);

        for (uint256 i; i < indexes; i++) {
            _removeTrade(accountTrades[account], indexesToRemove[i]);
            _upsertTrade(account, futureCashToAdd[i]);
        }

        return daiToReturn;
    }

    /**
     * Internal method called by settle to turn liquidity tokens into the required collateral and cash balances.
     *
     * @param account the account that is holding the token
     * @param tokenAmount the amount of token to settle
     * @param maturity when the token matures
     * @return the amount of cash to settle to the account
     */
    function _settleLiquidityToken(address account, uint128 tokenAmount, uint32 maturity) internal returns (uint128) {
        Market storage market = markets[maturity];

        // Here we calculate the amount of current cash that the liquidity token represents.
        uint128 collateral = uint128(uint256(market.totalCollateral).mul(tokenAmount).div(market.totalLiquidity));
        market.totalCollateral = market.totalCollateral.sub(collateral);

        // This is the amount of future cash that the liquidity token has a claim to.
        uint128 futureCash = uint128(uint256(market.totalFutureCash).mul(tokenAmount).div(market.totalLiquidity));
        market.totalFutureCash = market.totalFutureCash.sub(futureCash);

        // We do this calculation after the previous two so that we do not mess with the totalLiquidity
        // figure when calculating futureCash and collateral.
        market.totalLiquidity = market.totalLiquidity.sub(tokenAmount);

        // Move the collateral from the contract's dai balances account back to the sender
        daiBalances[account] = daiBalances[account].add(collateral);
        daiBalances[address(this)] = daiBalances[address(this)].sub(collateral);

        // No need to remove the liquidity token from the portfolio, the parent function will take care of this.

        // The liquidity token carries with it an obligation to pay a certain amount of future cash and we credit that
        // amount plus any appreciation here. This amount will be added to the daiCashBalances for the account to offset
        // the CASH_PAYER token that was created when the liquidity token was minted.
        return futureCash;
    }

    /**
     * Checks if the maturity and max block supplied are valid. The requirements are:
     *  * blockNum <= maxBlock < maturity <= maxMaturity
     *  * maturity % G_PERIOD_SIZE == 0
     */
    function _isValidBlock(uint32 maturity, uint32 maxBlock) internal view returns (bool) {
        uint32 blockNum = uint32(block.number);
        require(blockNum <= maxBlock, $$(ErrorCode(TRADE_FAILED_MAX_BLOCK)));
        require(blockNum < maturity, $$(ErrorCode(MARKET_INACTIVE)));
        // If the number of periods is set to zero then we prevent all new trades.
        require(maturity % G_PERIOD_SIZE == 0, $$(ErrorCode(MARKET_INACTIVE)));
        require(G_NUM_PERIODS > 0, $$(ErrorCode(MARKET_INACTIVE)));

        uint32 maxMaturity = blockNum - (blockNum % G_PERIOD_SIZE) + (G_PERIOD_SIZE * G_NUM_PERIODS);
        require(maturity <= maxMaturity, $$(ErrorCode(MARKET_INACTIVE)));
    }

    /**
     * Adds a trade to the account's portfolio. Ensures that trades will compact with other trades of
     * the same type and maturity. Cash paid and received will net out against each other.
     *
     * @param account the account to add the trade to
     * @param trade the trade to add to the account
     */
    function _upsertTrade(address account, Trade memory trade) internal {
        Trade[] storage portfolio = accountTrades[account];

        if (portfolio.length > 0) {
            // Loop over the existing portfolio and see if there is an existing trade that this new
            // trade can compact with.
            for (uint256 i; i < portfolio.length; i++) {
                // Only trades of matching maturities compact
                if (portfolio[i].maturity != trade.maturity) continue;
                uint8 portfolioTradeType = portfolio[i].tradeType;

                if (portfolioTradeType == trade.tradeType) {
                    // If the trade types match then we can simply aggregate the notional amounts.
                    portfolio[i].notional = portfolio[i].notional + trade.notional;
                    return;
                } else if (
                    (portfolioTradeType == CASH_PAYER && trade.tradeType == CASH_RECEIVER) ||
                    (portfolioTradeType == CASH_RECEIVER && trade.tradeType == CASH_PAYER)
                ) {
                    // If the cash trade has an offsetting cash position in the same maturity we can
                    // compact the two trades.
                    if (portfolio[i].notional == trade.notional) {
                        // Simply remove the trade since these positions cancel out.
                        _removeTrade(portfolio, i);
                        return;
                    } else if (portfolio[i].notional > trade.notional) {
                        // Leave the current trade type and just subtract the notional amount since this
                        // new trade will just net out part of the existing position
                        portfolio[i].notional = portfolio[i].notional - trade.notional;
                        return;
                    } else {
                        // Switch the trade to the new trade type since the new trade will cancel out
                        // all of the previous amount and have some amount left over
                        portfolio[i].notional = trade.notional - portfolio[i].notional;
                        portfolio[i].tradeType = trade.tradeType;
                        return;
                    }
                }
            }
        }

        // If the trade has not been found then we just append it.
        portfolio.push(trade);
    }

    /** Removes a trade from a portfolio **/
    function _removeTrade(Trade[] storage portfolio, uint256 index) internal {
        uint256 lastIndex = portfolio.length - 1;
        if (index != lastIndex) {
            Trade memory lastTrade = portfolio[lastIndex];
            portfolio[index] = lastTrade;
        }
        portfolio.pop();
    }

    /**
     * Does the trade calculation and returns the required objects for the contract methods to interpret.
     *
     * @param interimMarket the market to do the calculations over
     * @param futureCashAmount the future cash amount specified
     * @param futureCashPositive true if future cash is positive (borrowing), false if future cash is negative (lending)
     * @return (new market object, daiAmount)
     */
    function _tradeCalculation(
        Market memory interimMarket,
        uint128 futureCashAmount,
        uint32 blocksToMaturity,
        bool futureCashPositive
    ) internal view returns (Market memory, uint128) {
        if (!futureCashPositive && interimMarket.totalFutureCash < futureCashAmount) {
            // We return false if there is not enough future cash to support this trade.
            return (interimMarket, 0);
        }

        // Get the new rate anchor for this market, this accounts for the anchor rate changing as we
        // roll down to maturity. This needs to be saved to the market if we actually trade.
        interimMarket.rateAnchor = _getNewRateAnchor(interimMarket, blocksToMaturity);

        // Calculate the exchange rate the user will actually trade at, we simulate the future cash amount
        // added or subtracted to the numerator of the proportion.
        uint32 tradeExchangeRate;
        if (futureCashPositive) {
            tradeExchangeRate = _getExchangeRate(interimMarket, blocksToMaturity, int256(futureCashAmount));
        } else {
            tradeExchangeRate = _getExchangeRate(interimMarket, blocksToMaturity, int256(futureCashAmount).neg());
        }

        if (tradeExchangeRate < INSTRUMENT_PRECISION) {
            // We do not allow negative exchange rates.
            return (interimMarket, 0);
        }

        // The fee amount will decrease as we roll down to maturity
        uint32 fee = uint32(uint256(G_LIQUIDITY_FEE).mul(blocksToMaturity).div(G_PERIOD_SIZE));
        if (futureCashPositive) {
            tradeExchangeRate = tradeExchangeRate + fee;
        } else {
            tradeExchangeRate = tradeExchangeRate - fee;
        }

        // daiAmount = futureCashAmount / exchangeRate
        uint128 daiAmount = uint128(
            uint256(futureCashAmount).mul(INSTRUMENT_PRECISION).div(tradeExchangeRate)
        );

        // Update the markets accordingly.
        if (futureCashPositive) {
            if (interimMarket.totalCollateral < daiAmount) {
                // There is not enough dai to support this trade.
                return (interimMarket, 0);
            }

            interimMarket.totalFutureCash = interimMarket.totalFutureCash.add(futureCashAmount);
            interimMarket.totalCollateral = interimMarket.totalCollateral.sub(daiAmount);
        } else {
            interimMarket.totalFutureCash = interimMarket.totalFutureCash.sub(futureCashAmount);
            interimMarket.totalCollateral = interimMarket.totalCollateral.add(daiAmount);
        }

        // Now calculate the implied rate, this will be used for future rolldown calculations.
        interimMarket.lastImpliedRate = _getImpliedRate(interimMarket, blocksToMaturity);

        return (interimMarket, daiAmount);
    }

    /**
     * The rate anchor will update as the market rolls down to maturity. The calculation is:
     * newAnchor = anchor - [currentImpliedRate - lastImpliedRate] * (blocksToMaturity / PERIOD_SIZE)
     * where:
     * lastImpliedRate = (exchangeRate' - 1) * (PERIOD_SIZE / blocksToMaturity')
     *      (calculated when the last trade in the market was made)
     * blocksToMaturity = maturity - currentBlockNum
     */
    function _getNewRateAnchor(Market memory market, uint32 blocksToMaturity) internal view returns (uint32) {
        int256 rateDifference = (int256(_getImpliedRate(market, blocksToMaturity))
            .sub(market.lastImpliedRate))
            .mul(blocksToMaturity)
            .div(G_PERIOD_SIZE);

        return uint32(int256(market.rateAnchor).sub(rateDifference));
    }

    /**
     * This is the implied rate calculated after a trade is made or when liquidity is added to the pool initially.
     */
    function _getImpliedRate(Market memory market, uint32 blocksToMaturity) internal view returns (uint32) {
        return uint32(
            // It is impossible for the final exchange rate to go negative (i.e. below 1)
            uint256(_getExchangeRate(market, blocksToMaturity, 0) - INSTRUMENT_PRECISION)
                .mul(G_PERIOD_SIZE)
                .div(blocksToMaturity)
        );
    }

    /**
     * Takes a market in memory and calculates the following exchange rate:
     * (1 / G_RATE_SCALAR) * ln(proportion / (1 - proportion)) + G_RATE_ANCHOR
     * where:
     * proportion = totalFutureCash / (totalFutureCash + totalCollateral)
     */
    function _getExchangeRate(Market memory market, uint32 blocksToMaturity, int256 futureCashAmount) internal view returns (uint32) {
        // These two conditions will result in divide by zero errors.
        if (market.totalFutureCash.add(market.totalCollateral) == 0 || market.totalCollateral == 0) {
            revert($$(ErrorCode(EXCHANGE_RATE_UNDERFLOW)));
        }

        // This will always be positive, we do a check beforehand in _tradeCalculation
        uint256 numerator = uint256(int256(market.totalFutureCash).add(futureCashAmount));
        // This is always less than DECIMALS
        uint256 proportion = numerator.mul(DECIMALS).div(
            market.totalFutureCash.add(market.totalCollateral)
        );

        // proportion' = proportion / (1 - proportion)
        proportion = proportion.mul(DECIMALS).div(uint256(DECIMALS).sub(proportion));

        // The rate scalar will increase towards maturity, this will lower the impact of changes
        // to the proportion as we get towards maturity.
        int64 rateScalar = int64(uint256(market.rateScalar).mul(G_PERIOD_SIZE).div(blocksToMaturity));

        // (1 / scalar) * ln(proportion') + anchor_rate
        int64 rate = (((ABDKMath64x64.toInt(
            ABDKMath64x64.mul(
                ABDKMath64x64.ln(ABDKMath64x64.fromUInt(proportion)),
                PRECISION_64x64 // This is the 64x64 represntation of INSTRUMENT_PRECISION
            )
            // This is ln(1e18), subtract this to scale proportion back
        ) - 0x09a667e259) / rateScalar) + market.rateAnchor);

        // These checks simply prevent math errors, not negative interest rates.
        if (rate < 0) {
            revert($$(ErrorCode(EXCHANGE_RATE_UNDERFLOW)));
        } else {
            require(rate < 0xffffffff, $$(ErrorCode(EXCHANGE_RATE_OVERFLOW)));
            return uint32(rate);
        }
    }
}
