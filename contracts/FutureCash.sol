pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./lib/SafeUInt128.sol";
import "./lib/SafeInt256.sol";
import "./lib/ABDKMath64x64.sol";
import "./lib/SafeMath.sol";
import "./lib/UniswapExchangeInterface.sol";

import "./utils/Governed.sol";
import "./utils/Common.sol";

import "./Escrow.sol";
import "./Portfolios.sol";

/**
 * @title Future Cash Market
 * @notice Marketplace for trading future cash tokens to create fixed rate entitlements or obligations.
 */
contract FutureCash is Governed {
    using SafeUInt128 for uint128;
    using SafeMath for uint256;
    using SafeInt256 for int256;

    // This is used in _tradeCalculation to shift the ln calculation
    int128 internal constant PRECISION_64x64 = 0x3b9aca000000000000000000;
    uint256 internal constant MAX64 = 0x7FFFFFFFFFFFFFFF;
    int64 internal constant LN_1E18 = 0x09a667e259;

    /**
     * @dev skip
     * @param _directory reference to other contracts
     * @param collateralToken address of the token that will be used in this market
     */
    function initialize(address _directory, address collateralToken) public initializer {
        Governed.initialize(_directory);

        // This sets an immutable parameter that defines the token that this future cash market trades.
        G_COLLATERAL_TOKEN = collateralToken;

        // Setting dependencies can only be done once here. With proxy contracts the addresses shouldn't
        // change as we upgrade the logic.
        Governed.CoreContracts[] memory dependencies = new Governed.CoreContracts[](2);
        dependencies[0] = CoreContracts.Escrow;
        dependencies[1] = CoreContracts.Portfolios;
        _fetchDependencies(dependencies);
    }

    // Defines the fields for each market in each maturity.
    struct Market {
        // Total amount of future cash available for purchase in the market.
        uint128 totalFutureCash;
        // Total amount of liquidity tokens (representing a claim on liquidity) in the market.
        uint128 totalLiquidity;
        // Total amount of collateral available for purchase in the market.
        uint128 totalCollateral;
        // These factors are set when the market is instantiated by a liquidity provider via the global
        // settings and then held constant for the duration of the maturity. We cannot change them without
        // really messing up the market rates.
        uint16 rateScalar;
        uint32 rateAnchor;
        // This is the implied rate that we use to smooth the anchor rate between trades.
        uint32 lastImpliedRate;
    }

    // This is a mapping between a maturity and its corresponding market.
    mapping(uint32 => Market) public markets;

    /********** Governance Parameters *********************/

    // Represents the address of the token that will be the collateral in the marketplace.
    address public G_COLLATERAL_TOKEN;
    // These next parameters are set by the Portfolios contract and are immutable, except for
    // G_NUM_PERIODS
    uint8 public FUTURE_CASH_GROUP;
    uint16 public INSTRUMENT;
    uint32 public INSTRUMENT_PRECISION;
    uint32 public G_PERIOD_SIZE;
    uint32 public G_NUM_PERIODS;

    // These are governance parameters for the market itself and can be set by the owner.

    // The maximum trade size denominated in local currency
    uint128 public G_MAX_TRADE_SIZE;

    // The y-axis shift of the rate curve
    uint32 public G_RATE_ANCHOR;
    // The slope of the rate curve
    uint16 public G_RATE_SCALAR;
    // The fee in basis points given to liquidity providers
    uint32 public G_LIQUIDITY_FEE;
    // The fee as a percentage of the collateral traded given to the protocol
    uint128 public G_TRANSACTION_FEE;

    /**
     * @notice Sets governance parameters on the rate oracle.
     * @dev skip
     * @param futureCashGroupId this cannot change once set
     * @param instrumentId cannot change once set
     * @param precision will only take effect on a new period
     * @param periodSize will take effect immediately, must be careful
     * @param numPeriods will take effect immediately, makers can create new markets
     */
    function setParameters(
        uint8 futureCashGroupId,
        uint16 instrumentId,
        uint32 precision,
        uint32 periodSize,
        uint32 numPeriods,
        uint32 /* maxRate */
    ) external {
        require(calledByPortfolios(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        // These values cannot be reset once set.
        if (FUTURE_CASH_GROUP == 0) {
            FUTURE_CASH_GROUP = futureCashGroupId;
            INSTRUMENT = instrumentId;
            INSTRUMENT_PRECISION = precision;
            G_PERIOD_SIZE = periodSize;
        }

        // This is the only mutable governance parameter.
        G_NUM_PERIODS = numPeriods;
    }

    /**
     * @notice Sets rate factors that will determine the liquidity curve
     * @dev governance
     * @param rateAnchor the offset of the liquidity curve
     * @param rateScalar the sensitivity of the liquidity curve to changes
     */
    function setRateFactors(uint32 rateAnchor, uint16 rateScalar) external onlyOwner {
        require(rateScalar > 0 && rateAnchor > 0, $$(ErrorCode(INVALID_RATE_FACTORS)));
        G_RATE_SCALAR = rateScalar;
        G_RATE_ANCHOR = rateAnchor;

        emit UpdateRateFactors(rateAnchor, rateScalar);
    }

    /**
     * @notice Sets the maximum amount that can be traded in a single trade
     * @dev governance
     * @param amount the max trade size
     */
    function setMaxTradeSize(uint128 amount) external onlyOwner {
        G_MAX_TRADE_SIZE = amount;

        emit UpdateMaxTradeSize(amount);
    }

    /**
     * @notice Sets fee parameters for the market
     * @dev governance
     * @param liquidityFee a change in the traded exchange rate paid to liquidity providers
     * @param transactionFee percentage of a transaction that accrues to the reserve account
     */
    function setFee(uint32 liquidityFee, uint128 transactionFee) external onlyOwner {
        G_LIQUIDITY_FEE = liquidityFee;
        G_TRANSACTION_FEE = transactionFee;

        emit UpdateFees(liquidityFee, transactionFee);
    }

    /********** Governance Parameters *********************/

    /********** Events ************************************/
    /**
     * @notice Emitted when rate factors are updated, will take effect at the next maturity
     * @param rateAnchor the new rate anchor
     * @param rateScalar the new rate scalar
     */
    event UpdateRateFactors(uint32 rateAnchor, uint16 rateScalar);

    /**
     * @notice Emitted when max trade size is updated, takes effect immediately
     * @param maxTradeSize the new max trade size
     */
    event UpdateMaxTradeSize(uint128 maxTradeSize);

    /**
     * @notice Emitted when fees are updated, takes effect immediately
     * @param liquidityFee the new liquidity fee
     * @param transactionFee the new transaction fee
     */
    event UpdateFees(uint32 liquidityFee, uint128 transactionFee);

    /**
     * @notice Emitted when liquidity is added to a maturity
     * @param account the account that performed the trade
     * @param maturity the maturity that this trade affects
     * @param tokens amount of liquidity tokens issued
     * @param futureCash amount of future cash tokens added
     * @param collateral amount of collateral tokens added
     */
    event AddLiquidity(
        address indexed account,
        uint32 maturity,
        uint128 tokens,
        uint128 futureCash,
        uint128 collateral
    );

    /**
     * @notice Emitted when liquidity is removed from a maturity
     * @param account the account that performed the trade
     * @param maturity the maturity that this trade affects
     * @param tokens amount of liquidity tokens burned
     * @param futureCash amount of future cash tokens removed
     * @param collateral amount of collateral tokens removed
     */
    event RemoveLiquidity(
        address indexed account,
        uint32 maturity,
        uint128 tokens,
        uint128 futureCash,
        uint128 collateral
    );

    /**
     * @notice Emitted when collateral is taken from a maturity
     * @param account the account that performed the trade
     * @param maturity the maturity that this trade affects
     * @param futureCash amount of future cash tokens added
     * @param collateral amount of collateral tokens removed
     * @param fee amount of transaction fee charged
     */
    event TakeCollateral(address indexed account, uint32 maturity, uint128 futureCash, uint128 collateral, uint128 fee);

    /**
     * @notice Emitted when future cash is taken from a maturity
     * @param account the account that performed the trade
     * @param maturity the maturity that this trade affects
     * @param futureCash amount of future cash tokens removed
     * @param collateral amount of collateral tokens added
     * @param fee amount of transaction fee charged
     */
    event TakeFutureCash(address indexed account, uint32 maturity, uint128 futureCash, uint128 collateral, uint128 fee);

    /********** Events ************************************/

    /********** Liquidity Tokens **************************/

    /**
     * @notice Adds some amount of collateral to the liquidity pool up to the corresponding amount defined by
     * `maxFutureCash`. Mints liquidity tokens back to the sender.
     * @dev - TRADE_FAILED_MAX_TIME: maturity specified is not yet active
     * - MARKET_INACTIVE: maturity is not a valid one
     * - OVER_MAX_FUTURE_CASH: depositing collateral would require more future cash than specified
     * - INSUFFICIENT_BALANCE: insufficient collateral to deposit into market
     * @param maturity the period to add liquidity to
     * @param minCollateral the amount of collateral to add to the pool
     * @param maxFutureCash the maximum amount of future cash to add to the pool
     * @param maxTime after this time the trade will fail
     */
    function addLiquidity(
        uint32 maturity,
        uint128 minCollateral,
        uint128 maxFutureCash,
        uint32 maxTime
    ) public {
        _isValidBlock(maturity, maxTime);
        Market storage market = markets[maturity];
        // We call settle here instead of at the end of the function because if we have matured liquidity
        // tokens this will put collateral back into our portfolio so that we can add it back into the markets.
        Portfolios().settleAccount(msg.sender);

        uint128 futureCash;
        uint128 liquidityTokenAmount;
        if (market.totalLiquidity == 0) {
            // We check the rateScalar to determine if the market exists or not. The reason for this is that once we
            // initialize a market we will set the rateScalar and rateAnchor based on global values for the duration
            // of the market. The proportion of future cash to collateral that the first liquidity provider sets here will
            // determine the initial exchange rate of the market (taking into account rateScalar and rateAnchor, of course).
            // Governance will never allow rateScalar to be set to 0.
            if (market.rateScalar == 0) {
                market.rateAnchor = G_RATE_ANCHOR;
                market.rateScalar = G_RATE_SCALAR;
            }

            market.totalFutureCash = maxFutureCash;
            market.totalCollateral = minCollateral;
            market.totalLiquidity = minCollateral;
            // We have to initialize this to the exchange rate implied by the proportion of cash to future cash.
            uint32 timeToMaturity = maturity - uint32(block.timestamp);
            market.lastImpliedRate = _getImpliedRateRequire(market, timeToMaturity);

            liquidityTokenAmount = minCollateral;
            futureCash = maxFutureCash;
        } else {
            // We calculate the amount of liquidity tokens to mint based on the share of the future cash
            // that the liquidity provider is depositing.
            liquidityTokenAmount = uint128(
                uint256(market.totalLiquidity).mul(minCollateral).div(market.totalCollateral)
            );

            // We use the prevailing proportion to calculate the required amount of current cash to deposit.
            futureCash = uint128(uint256(market.totalFutureCash).mul(minCollateral).div(market.totalCollateral));
            // If this proportion has moved beyond what the liquidity provider is willing to pay then we
            // will revert here.
            require(futureCash <= maxFutureCash, $$(ErrorCode(OVER_MAX_FUTURE_CASH)));

            // Add the future cash and collateral to the pool.
            market.totalFutureCash = market.totalFutureCash.add(futureCash);
            market.totalCollateral = market.totalCollateral.add(minCollateral);
            market.totalLiquidity = market.totalLiquidity.add(liquidityTokenAmount);
        }

        // Move the collateral into the contract's collateral balances account. This must happen before the trade
        // is placed so that the free collateral check is correct.
        Escrow().depositIntoMarket(msg.sender, G_COLLATERAL_TOKEN, FUTURE_CASH_GROUP, minCollateral, 0);

        // Providing liquidity results in two tokens generated, a liquidity token and a CASH_PAYER which
        // represents the obligation that offsets the future cash in the market.
        Common.Asset[] memory assets = new Common.Asset[](2);
        // This is the liquidity token
        assets[0] = Common.Asset(
            FUTURE_CASH_GROUP,
            INSTRUMENT,
            maturity - G_PERIOD_SIZE,
            G_PERIOD_SIZE,
            Common.getLiquidityToken(),
            INSTRUMENT_PRECISION,
            liquidityTokenAmount
        );

        // This is the CASH_PAYER
        assets[1] = Common.Asset(
            FUTURE_CASH_GROUP,
            INSTRUMENT,
            maturity - G_PERIOD_SIZE,
            G_PERIOD_SIZE,
            Common.getCashPayer(),
            INSTRUMENT_PRECISION,
            futureCash
        );

        // This will do a free collateral check before it adds to the portfolio.
        Portfolios().upsertAccountAssetBatch(msg.sender, assets);

        emit AddLiquidity(msg.sender, maturity, liquidityTokenAmount, futureCash, minCollateral);
    }

    /**
     * @notice Removes liquidity from the future cash market. The sender's liquidity tokens are burned and they
     * are credited back with future cash and collateral at the prevailing exchange rate. This function
     * only works when removing liquidity from an active market. For markets that are matured, the sender
     * must settle their liquidity token via `Portfolios().settleAccount()`.
     * @dev - TRADE_FAILED_MAX_TIME: maturity specified is not yet active
     * - MARKET_INACTIVE: maturity is not a valid one
     * - INSUFFICIENT_BALANCE: account does not have sufficient tokens to remove
     * @param maturity the period to remove liquidity from
     * @param amount the amount of liquidity tokens to burn
     * @param maxTime after this block the trade will fail
     */
    function removeLiquidity(
        uint32 maturity,
        uint128 amount,
        uint32 maxTime
    ) public {
        // This method only works when the market is active.
        _isValidBlock(maturity, maxTime);
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

        // Move the collateral from the contract's collateral balances account back to the sender. This must happen
        // before the free collateral check in the Portfolio call below.
        Escrow().withdrawFromMarket(msg.sender, G_COLLATERAL_TOKEN, FUTURE_CASH_GROUP, collateral, 0);

        Common.Asset[] memory assets = new Common.Asset[](2);
        // This will remove the liquidity tokens
        assets[0] = Common.Asset(
            FUTURE_CASH_GROUP,
            INSTRUMENT,
            maturity - G_PERIOD_SIZE,
            G_PERIOD_SIZE,
            // We mark this as a "PAYER" liquidity token so the portfolio reduces the balance
            Common.makeCounterparty(Common.getLiquidityToken()),
            INSTRUMENT_PRECISION,
            amount
        );

        // This is the CASH_RECEIVER
        assets[1] = Common.Asset(
            FUTURE_CASH_GROUP,
            INSTRUMENT,
            maturity - G_PERIOD_SIZE,
            G_PERIOD_SIZE,
            Common.getCashReceiver(),
            INSTRUMENT_PRECISION,
            futureCashAmount
        );

        // This function call will check if the account in question actually has enough liquidity tokens to remove.
        Portfolios().upsertAccountAssetBatch(msg.sender, assets);

        emit RemoveLiquidity(msg.sender, maturity, amount, futureCashAmount, collateral);
    }

    /**
     * @notice Settles a liquidity token into future cash and collateral. Can only be called by the Portfolios contract.
     * @dev skip
     * @param account the account that is holding the token
     * @param tokenAmount the amount of token to settle
     * @param maturity when the token matures
     * @return the amount of cash to settle to the account
     */
    function settleLiquidityToken(
        address account,
        uint128 tokenAmount,
        uint32 maturity
    ) public returns (uint128) {
        require(calledByPortfolios(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        (uint128 collateral, uint128 futureCash) = _settleLiquidityToken(tokenAmount, maturity);

        // Move the collateral from the contract's collateral balances account back to the sender
        Escrow().withdrawFromMarket(account, G_COLLATERAL_TOKEN, FUTURE_CASH_GROUP, collateral, 0);

        // No need to remove the liquidity token from the portfolio, the calling function will take care of this.

        // The liquidity token carries with it an obligation to pay a certain amount of future cash and we credit that
        // amount plus any appreciation here. This amount will be added to the cashBalances for the account to offset
        // the CASH_PAYER token that was created when the liquidity token was minted.
        return futureCash;
    }

    /**
     * @notice Internal method for settling liquidity tokens, calculates the values for collateral and future cash
     *
     * @param tokenAmount the amount of token to settle
     * @param maturity when the token matures
     * @return the amount of collateral and future cash
     */
    function _settleLiquidityToken(uint128 tokenAmount, uint32 maturity) internal returns (uint128, uint128) {
        Market storage market = markets[maturity];

        // Here we calculate the amount of collateral that the liquidity token represents.
        uint128 collateral = uint128(uint256(market.totalCollateral).mul(tokenAmount).div(market.totalLiquidity));
        market.totalCollateral = market.totalCollateral.sub(collateral);

        // This is the amount of future cash that the liquidity token has a claim to.
        uint128 futureCash = uint128(uint256(market.totalFutureCash).mul(tokenAmount).div(market.totalLiquidity));
        market.totalFutureCash = market.totalFutureCash.sub(futureCash);

        // We do this calculation after the previous two so that we do not mess with the totalLiquidity
        // figure when calculating futureCash and collateral.
        market.totalLiquidity = market.totalLiquidity.sub(tokenAmount);

        return (collateral, futureCash);
    }

    /********** Liquidity Tokens **************************/

    /********** Trading Cash ******************************/

    /**
     * @notice Given the amount of future cash put into a market, how much collateral this would
     * purchase at the current block.
     * @param maturity the maturity of the future cash
     * @param futureCashAmount the amount of future cash to input
     * @return the amount of collateral this would purchase, returns 0 if the trade will fail
     */
    function getFutureCashToCollateral(uint32 maturity, uint128 futureCashAmount) public view returns (uint128) {
        return getFutureCashToCollateralAtTime(maturity, futureCashAmount, uint32(block.timestamp));
    }

    /**
     * @notice Given the amount of future cash put into a market, how much collateral this would
     * purchase at the given time. Future cash exchange rates change as we go towards maturity.
     * @dev - CANNOT_GET_PRICE_FOR_MATURITY: can only get prices before the maturity
     * @param maturity the maturity of the future cash
     * @param futureCashAmount the amount of future cash to input
     * @param blockTime the specified block time
     * @return the amount of collateral this would purchase, returns 0 if the trade will fail
     */
    function getFutureCashToCollateralAtTime(
        uint32 maturity,
        uint128 futureCashAmount,
        uint32 blockTime
    ) public view returns (uint128) {
        Market memory interimMarket = markets[maturity];
        require(blockTime < maturity, $$(ErrorCode(CANNOT_GET_PRICE_FOR_MATURITY)));

        uint32 timeToMaturity = maturity - blockTime;

        ( /* market */, uint128 collateral) = _tradeCalculation(interimMarket, int256(futureCashAmount), timeToMaturity);
        uint128 fee = collateral.mul(G_TRANSACTION_FEE).div(Common.DECIMALS);
        // On trade failure, we will simply return 0
        return collateral - fee;
    }

    /**
     * @notice Receive collateral in exchange for a future cash obligation. Equivalent to borrowing
     * collateral at a fixed rate.
     * @dev - TRADE_FAILED_MAX_TIME: maturity specified is not yet active
     * - MARKET_INACTIVE: maturity is not a valid one
     * - TRADE_FAILED_TOO_LARGE: trade is larger than allowed by the governance settings
     * - TRADE_FAILED_LACK_OF_LIQUIDITY: there is insufficient liquidity in this maturity to handle the trade
     * - TRADE_FAILED_SLIPPAGE: trade is greater than the max implied rate set
     * - INSUFFICIENT_FREE_COLLATERAL: insufficient free collateral to take on the debt
     * @param maturity the maturity of the future cash being exchange for current cash
     * @param futureCashAmount the amount of future cash to deposit, will convert this amount to current cash
     *  at the prevailing exchange rate
     * @param maxTime after this time the trade will not settle
     * @param maxImpliedRate the maximum implied period rate that the borrower will accept
     * @return the amount of collateral purchased
     */
    function takeCollateral(
        uint32 maturity,
        uint128 futureCashAmount,
        uint32 maxTime,
        uint32 maxImpliedRate
    ) public returns (uint128) {
        _isValidBlock(maturity, maxTime);
        require(futureCashAmount <= G_MAX_TRADE_SIZE, $$(ErrorCode(TRADE_FAILED_TOO_LARGE)));

        uint128 collateral = _updateMarket(maturity, int256(futureCashAmount));
        require(collateral > 0, $$(ErrorCode(TRADE_FAILED_LACK_OF_LIQUIDITY)));

        uint128 fee = collateral.mul(G_TRANSACTION_FEE).div(Common.DECIMALS);

        uint32 timeToMaturity = maturity - uint32(block.timestamp);
        uint32 impliedRate = _calculateImpliedRate(collateral - fee, futureCashAmount, timeToMaturity);
        require(impliedRate <= maxImpliedRate, $$(ErrorCode(TRADE_FAILED_SLIPPAGE)));

        // Move the collateral from the contract's collateral balances account to the sender. This must happen before
        // the call to insert the trade below in order for the free collateral check to work properly.
        Escrow().withdrawFromMarket(msg.sender, G_COLLATERAL_TOKEN, FUTURE_CASH_GROUP, collateral, fee);

        // The sender now has an obligation to pay cash at maturity.
        Portfolios().upsertAccountAsset(
            msg.sender,
            Common.Asset(
                FUTURE_CASH_GROUP,
                INSTRUMENT,
                maturity - G_PERIOD_SIZE,
                G_PERIOD_SIZE,
                Common.getCashPayer(),
                INSTRUMENT_PRECISION,
                futureCashAmount
            )
        );

        emit TakeCollateral(msg.sender, maturity, futureCashAmount, collateral, fee);

        return collateral;
    }

    /**
     * @notice Given the amount of future cash to purchase, returns the amount of collateral this would cost at the current
     * block.
     * @param maturity the maturity of the future cash
     * @param futureCashAmount the amount of future cash to purchase
     * @return the amount of collateral this would cost, returns 0 on trade failure
     */
    function getCollateralToFutureCash(uint32 maturity, uint128 futureCashAmount) public view returns (uint128) {
        return getCollateralToFutureCashAtTime(maturity, futureCashAmount, uint32(block.timestamp));
    }

    /**
     * @notice Given the amount of future cash to purchase, returns the amount of collateral this would cost.
     * @dev - CANNOT_GET_PRICE_FOR_MATURITY: can only get prices before the maturity
     * @param maturity the maturity of the future cash
     * @param futureCashAmount the amount of future cash to purchase
     * @param blockTime the time to calculate the price at
     * @return the amount of collateral this would cost, returns 0 on trade failure
     */
    function getCollateralToFutureCashAtTime(
        uint32 maturity,
        uint128 futureCashAmount,
        uint32 blockTime
    ) public view returns (uint128) {
        Market memory interimMarket = markets[maturity];
        require(blockTime < maturity, $$(ErrorCode(CANNOT_GET_PRICE_FOR_MATURITY)));

        uint32 timeToMaturity = maturity - blockTime;

        ( /* market */, uint128 collateral) = _tradeCalculation(interimMarket, int256(futureCashAmount).neg(), timeToMaturity);
        uint128 fee = collateral.mul(G_TRANSACTION_FEE).div(Common.DECIMALS);
        // On trade failure, we will simply return 0
        return collateral + fee;
    }

    /**
     * @notice Deposit collateral in return for the right to receive cash at the specified maturity. Equivalent to lending
     * your collateral at a fixed rate.
     * @dev - TRADE_FAILED_MAX_TIME: maturity specified is not yet active
     * - MARKET_INACTIVE: maturity is not a valid one
     * - TRADE_FAILED_TOO_LARGE: trade is larger than allowed by the governance settings
     * - TRADE_FAILED_LACK_OF_LIQUIDITY: there is insufficient liquidity in this maturity to handle the trade
     * - TRADE_FAILED_SLIPPAGE: trade is lower than the min implied rate set
     * - INSUFFICIENT_BALANCE: not enough collateral to complete this trade
     * @param maturity the period to receive future cash in
     * @param futureCashAmount the amount of future cash to purchase
     * @param maxTime after this time the trade will not settle
     * @param minImpliedRate the minimum implied rate that the lender will accept
     * @return the amount of collateral deposited to the market
     */
    function takeFutureCash(
        uint32 maturity,
        uint128 futureCashAmount,
        uint32 maxTime,
        uint128 minImpliedRate
    ) public returns (uint128) {
        _isValidBlock(maturity, maxTime);
        require(futureCashAmount <= G_MAX_TRADE_SIZE, $$(ErrorCode(TRADE_FAILED_TOO_LARGE)));

        uint128 collateral = _updateMarket(maturity, int256(futureCashAmount).neg());
        require(collateral > 0, $$(ErrorCode(TRADE_FAILED_LACK_OF_LIQUIDITY)));

        uint128 fee = collateral.mul(G_TRANSACTION_FEE).div(Common.DECIMALS);

        uint32 timeToMaturity = maturity - uint32(block.timestamp);
        uint32 impliedRate = _calculateImpliedRate(collateral + fee, futureCashAmount, timeToMaturity);
        require(impliedRate >= minImpliedRate, $$(ErrorCode(TRADE_FAILED_SLIPPAGE)));

        // Move the collateral from the sender to the contract address. This must happen before the
        // insert trade call below.
        Escrow().depositIntoMarket(msg.sender, G_COLLATERAL_TOKEN, FUTURE_CASH_GROUP, collateral, fee);

        // The sender is now owed a future cash balance at maturity
        Portfolios().upsertAccountAsset(
            msg.sender,
            Common.Asset(
                FUTURE_CASH_GROUP,
                INSTRUMENT,
                maturity - G_PERIOD_SIZE,
                G_PERIOD_SIZE,
                Common.getCashReceiver(),
                INSTRUMENT_PRECISION,
                futureCashAmount
            )
        );

        emit TakeFutureCash(msg.sender, maturity, futureCashAmount, collateral, fee);

        return collateral;
    }

    /********** Trading Cash ******************************/

    /********** Liquidation *******************************/

    /**
     * @notice Uses collateralAvailable to purchase future cash in order to offset the obligation amount at
     * the specified maturity. Used by the Portfolio contract during liquidation.
     * @dev skip
     * @param collateralAvailable amount of collateral available to purchase offsetting obligations
     * @param obligation the max amount of obligations to offset
     * @param maturity the maturity of the obligation
     * @return (collateral cost of offsetting future cash, the amount of obligation offset)
     */
    function tradeCashPayer(
        uint128 collateralAvailable,
        uint128 obligation,
        uint32 maturity
    ) public returns (uint128, uint128) {
        require(calledByPortfolios(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        uint128 totalFutureCash = markets[maturity].totalFutureCash;
        uint128 futureCashToRepay;
        // The floor for the value these positions is at a 1-1 exchange rate. This is the least favorable rate
        // for the liquidated account since we guarantee that exchange rates cannot go below zero.
        if (collateralAvailable >= obligation && totalFutureCash >= obligation) {
            futureCashToRepay = obligation;
        } else if (totalFutureCash >= collateralAvailable) {
            // We cannot accurately calculate how much future cash we can possibly offset here, but
            // we know that it is at least "collateralAvailable". Figure out the cost for that and then
            // proceed.
            futureCashToRepay = collateralAvailable;
        }

        uint128 repayCost = _updateMarket(maturity, int256(futureCashToRepay).neg());

        if (repayCost > 0) {
            return (repayCost, futureCashToRepay);
        } else {
            // Closing out the obligation was unsuccessful.
            return (0, 0);
        }
    }

    /**
     * @notice Turns future cash tokens into a current collateral. Used by portfolios when settling cash.
     * This method currently sells `maxFutureCash` every time since it's not possible to calculate the
     * amount of future cash to sell from `collateralRequired`.
     * @dev skip
     * @param account that holds the future cash
     * @param collateralRequired amount of collateral that needs to be raised
     * @param maxFutureCash the maximum amount of future cash that can be sold
     * @param maturity the maturity of the future cash
     */
    function tradeCashReceiver(
        address account,
        uint128 collateralRequired,
        uint128 maxFutureCash,
        uint32 maturity
    ) public returns (uint128) {
        require(calledByPortfolios(), $$(ErrorCode(UNAUTHORIZED_CALLER)));

        uint128 futureCashAmount = maxFutureCash;
        uint128 totalFutureCash = markets[maturity].totalFutureCash;
        if (maxFutureCash > totalFutureCash) {
            // Don't sell future cash than is in the market.
            futureCashAmount = totalFutureCash;
        }

        uint128 collateral = _updateMarket(maturity, int256(futureCashAmount));

        // Here we've sold collateral in excess of what was required, so we credit the remaining back
        // to the account that was holding the trade.
        if (collateral > collateralRequired) {
            Escrow().withdrawFromMarket(
                account,
                G_COLLATERAL_TOKEN,
                FUTURE_CASH_GROUP,
                collateral - collateralRequired,
                0
            );

            collateral = collateralRequired;
        }

        return collateral;
    }

    /**
     * @notice Called by the portfolios contract when a liquidity token is being converted for collateral.
     * @dev skip
     * @param collateralRequired the amount of collateral required
     * @param maxTokenAmount the max balance of tokens available
     * @param maturity when the token matures
     * @return the amount of collateral raised, future cash raised, tokens removed
     */
    function tradeLiquidityToken(
        uint128 collateralRequired,
        uint128 maxTokenAmount,
        uint32 maturity
    )
        public
        returns (
            uint128,
            uint128,
            uint128
        )
    {
        require(calledByPortfolios(), $$(ErrorCode(UNAUTHORIZED_CALLER)));
        Market memory market = markets[maturity];

        // This is the total claim on collateral that the tokens have.
        uint128 tokensToRemove = maxTokenAmount;
        uint128 collateralAmount = uint128(
            uint256(market.totalCollateral).mul(tokensToRemove).div(market.totalLiquidity)
        );

        if (collateralAmount > collateralRequired) {
            // If the total claim is greater than required, we only want to remove part of the liquidity.
            tokensToRemove = uint128(
                uint256(collateralRequired).mul(market.totalLiquidity).div(market.totalCollateral)
            );
            collateralAmount = collateralRequired;
        }

        // This method will credit the collateralAmount back to the balances on the escrow contract.
        (
            ,
            /* uint128 */
            uint128 futureCashAmount
        ) = _settleLiquidityToken(tokensToRemove, maturity);

        return (collateralAmount, futureCashAmount, tokensToRemove);
    }

    /********** Liquidation *******************************/

    /********** Rate Methods ******************************/

    /**
     * @notice Returns the current discount rate for the market. Will not return negative interest rates
     * @param maturity the maturity to get the rate for
     * @return a tuple where the first value is the simple discount rate and the second value is a boolean indicating
     *  whether or not the maturity has passed
     */
    function getRate(uint32 maturity) public view returns (uint32, bool) {
        Market memory market = markets[maturity];
        if (block.timestamp >= maturity) {
            // The exchange rate is 1 after we hit maturity for the future cash market.
            return (INSTRUMENT_PRECISION, true);
        } else {
            uint32 timeToMaturity = maturity - uint32(block.timestamp);
            market.rateAnchor = _getNewRateAnchor(market, timeToMaturity);
            uint32 rate = _getExchangeRate(market, timeToMaturity, 0);
            return (rate, false);
        }
    }

    /**
     * @notice Gets the rates for all the active markets.
     * @return an array of rates starting from the most current maturity to the furthest maturity
     */
    function getMarketRates() external view returns (uint32[] memory) {
        uint32[] memory marketRates = new uint32[](G_NUM_PERIODS);
        uint32 maturity = uint32(block.timestamp) - (uint32(block.timestamp) % G_PERIOD_SIZE) + G_PERIOD_SIZE;
        for (uint256 i; i < marketRates.length; i++) {
            (uint32 rate, ) = getRate(maturity);
            marketRates[i] = rate;

            maturity = maturity + G_PERIOD_SIZE;
        }

        return marketRates;
    }

    /**
     * @notice Gets the maturities for all the active markets.
     * @return an array of blocks where the currently active markets will mature at
     */
    function getActiveMaturities() public view returns (uint32[] memory) {
        uint32[] memory ids = new uint32[](G_NUM_PERIODS);
        uint32 blockTime = uint32(block.timestamp);
        uint32 currentMaturity = blockTime - (blockTime % G_PERIOD_SIZE) + G_PERIOD_SIZE;
        for (uint256 i; i < ids.length; i++) {
            ids[i] = currentMaturity + uint32(i) * G_PERIOD_SIZE;
        }
        return ids;
    }

    /*********** Internal Methods ********************/

    function _updateMarket(uint32 maturity, int256 futureCashAmount) internal returns (uint128) {
        Market memory interimMarket = markets[maturity];
        uint32 timeToMaturity = maturity - uint32(block.timestamp);
        uint128 collateral;
        // Here we are selling future cash in return for collateral
        (interimMarket, collateral) = _tradeCalculation(interimMarket, futureCashAmount, timeToMaturity);

        // Collateral value of 0 signifies a failed trade
        if (collateral > 0) {
            Market storage market = markets[maturity];
            market.totalFutureCash = interimMarket.totalFutureCash;
            market.totalCollateral = interimMarket.totalCollateral;
            market.lastImpliedRate = interimMarket.lastImpliedRate;
            market.rateAnchor = interimMarket.rateAnchor;
        }

        return collateral;
    }

    /**
     * @notice Checks if the maturity and max time supplied are valid. The requirements are:
     *  - blockTime <= maxTime < maturity <= maxMaturity
     *  - maturity % G_PERIOD_SIZE == 0
     * Reverts if the block is not valid.
     */
    function _isValidBlock(uint32 maturity, uint32 maxTime) internal view returns (bool) {
        uint32 blockTime = uint32(block.timestamp);
        require(blockTime <= maxTime, $$(ErrorCode(TRADE_FAILED_MAX_TIME)));
        require(blockTime < maturity, $$(ErrorCode(MARKET_INACTIVE)));
        // If the number of periods is set to zero then we prevent all new trades.
        require(maturity % G_PERIOD_SIZE == 0, $$(ErrorCode(MARKET_INACTIVE)));
        require(G_NUM_PERIODS > 0, $$(ErrorCode(MARKET_INACTIVE)));

        uint32 maxMaturity = blockTime - (blockTime % G_PERIOD_SIZE) + (G_PERIOD_SIZE * G_NUM_PERIODS);
        require(maturity <= maxMaturity, $$(ErrorCode(MARKET_INACTIVE)));
    }

    /**
     * @notice Does the trade calculation and returns the required objects for the contract methods to interpret.
     *
     * @param interimMarket the market to do the calculations over
     * @param futureCashAmount the future cash amount specified
     * @param timeToMaturity number of seconds until maturity
     * @return (new market object, collateral)
     */
    function _tradeCalculation(
        Market memory interimMarket,
        int256 futureCashAmount,
        uint32 timeToMaturity
    ) internal view returns (Market memory, uint128) {
        if (futureCashAmount < 0 && interimMarket.totalFutureCash < futureCashAmount.neg()) {
            // We return false if there is not enough future cash to support this trade.
            return (interimMarket, 0);
        }

        // Get the new rate anchor for this market, this accounts for the anchor rate changing as we
        // roll down to maturity. This needs to be saved to the market if we actually trade.
        interimMarket.rateAnchor = _getNewRateAnchor(interimMarket, timeToMaturity);

        // Calculate the exchange rate the user will actually trade at, we simulate the future cash amount
        // added or subtracted to the numerator of the proportion.
        uint32 tradeExchangeRate = _getExchangeRate(interimMarket, timeToMaturity, futureCashAmount);

        // The fee amount will decrease as we roll down to maturity
        uint32 fee = uint32(uint256(G_LIQUIDITY_FEE).mul(timeToMaturity).div(G_PERIOD_SIZE));
        if (futureCashAmount > 0) {
            tradeExchangeRate = tradeExchangeRate + fee;
        } else {
            tradeExchangeRate = tradeExchangeRate - fee;
        }

        if (tradeExchangeRate < INSTRUMENT_PRECISION) {
            // We do not allow negative exchange rates.
            return (interimMarket, 0);
        }

        // collateral = futureCashAmount / exchangeRate
        uint128 collateral = uint128(uint256(futureCashAmount.abs()).mul(INSTRUMENT_PRECISION).div(tradeExchangeRate));

        // Update the markets accordingly.
        if (futureCashAmount > 0) {
            if (interimMarket.totalCollateral < collateral) {
                // There is not enough collateral to support this trade.
                return (interimMarket, 0);
            }

            interimMarket.totalFutureCash = interimMarket.totalFutureCash.add(uint128(futureCashAmount));
            interimMarket.totalCollateral = interimMarket.totalCollateral.sub(collateral);
        } else {
            interimMarket.totalFutureCash = interimMarket.totalFutureCash.sub(uint128(futureCashAmount.abs()));
            interimMarket.totalCollateral = interimMarket.totalCollateral.add(collateral);
        }

        // Now calculate the implied rate, this will be used for future rolldown calculations.
        interimMarket.lastImpliedRate = _getImpliedRate(interimMarket, timeToMaturity);

        return (interimMarket, collateral);
    }

    /**
     * The rate anchor will update as the market rolls down to maturity. The calculation is:
     * newAnchor = anchor - [currentImpliedRate - lastImpliedRate] * (timeToMaturity / PERIOD_SIZE)
     * where:
     * lastImpliedRate = (exchangeRate' - 1) * (PERIOD_SIZE / timeToMaturity')
     *      (calculated when the last trade in the market was made)
     * timeToMaturity = maturity - currentBlockTime
     */
    function _getNewRateAnchor(Market memory market, uint32 timeToMaturity) internal view returns (uint32) {
        int256 rateDifference = (int256(_getImpliedRate(market, timeToMaturity)).sub(market.lastImpliedRate))
            .mul(timeToMaturity)
            .div(G_PERIOD_SIZE);

        return uint32(int256(market.rateAnchor).sub(rateDifference));
    }

    /**
     * This is the implied rate calculated after a trade is made or when liquidity is added to the pool initially.
     */
    function _getImpliedRate(Market memory market, uint32 timeToMaturity) internal view returns (uint32) {
        return
            uint32(
                // It is impossible for the final exchange rate to go negative (i.e. below 1)
                uint256(_getExchangeRate(market, timeToMaturity, 0) - INSTRUMENT_PRECISION).mul(G_PERIOD_SIZE).div(
                    timeToMaturity
                )
            );
    }

    /**
     * @notice This function reverts if the implied rate is negative.
     */
    function _getImpliedRateRequire(Market memory market, uint32 timeToMaturity) internal view returns (uint32) {
        return
            uint32(
                uint256(_getExchangeRate(market, timeToMaturity, 0)).sub(INSTRUMENT_PRECISION).mul(G_PERIOD_SIZE).div(
                    timeToMaturity
                )
            );
    }

    function _calculateImpliedRate(
        uint128 collateral,
        uint128 futureCash,
        uint32 timeToMaturity
    ) internal view returns (uint32) {
        uint256 exchangeRate = uint256(futureCash).mul(INSTRUMENT_PRECISION).div(collateral);
        return uint32(exchangeRate.sub(INSTRUMENT_PRECISION).mul(G_PERIOD_SIZE).div(timeToMaturity));
    }

    /**
     * @dev It is important that this call does not revert, if it does it may prevent liquidation
     * or settlement from finishing. We return a rate of 0 to signify a failure.
     *
     * Takes a market in memory and calculates the following exchange rate:
     * (1 / G_RATE_SCALAR) * ln(proportion / (1 - proportion)) + G_RATE_ANCHOR
     * where:
     * proportion = totalFutureCash / (totalFutureCash + totalCollateral)
     */
    function _getExchangeRate(
        Market memory market,
        uint32 timeToMaturity,
        int256 futureCashAmount
    ) internal view returns (uint32) {
        // These two conditions will result in divide by zero errors.
        if (market.totalFutureCash.add(market.totalCollateral) == 0 || market.totalCollateral == 0) {
            return 0;
        }

        // This will always be positive, we do a check beforehand in _tradeCalculation
        uint256 numerator = uint256(int256(market.totalFutureCash).add(futureCashAmount));
        // This is always less than DECIMALS
        uint256 proportion = numerator.mul(Common.DECIMALS).div(market.totalFutureCash.add(market.totalCollateral));

        // proportion' = proportion / (1 - proportion)
        proportion = proportion.mul(Common.DECIMALS).div(uint256(Common.DECIMALS).sub(proportion));

        // The rate scalar will increase towards maturity, this will lower the impact of changes
        // to the proportion as we get towards maturity.
        int64 rateScalar = int64(uint256(market.rateScalar).mul(G_PERIOD_SIZE).div(timeToMaturity));

        // (1 / scalar) * ln(proportion') + anchor_rate
        (int64 abdkResult, bool success) = _abdkMath(proportion);

        if (!success) return 0;

        // This is ln(1e18), subtract this to scale proportion back
        // TODO: rateScalar and rateAnchor math must not lose precision?
        int64 rate = (((abdkResult - LN_1E18) / rateScalar) + market.rateAnchor);

        // These checks simply prevent math errors, not negative interest rates.
        if (rate < 0 || rate > 0xffffffff) {
            return 0;
        } else {
            return uint32(rate);
        }
    }

    function _abdkMath(uint256 proportion) internal pure returns (int64, bool) {
        // This is the max 64 bit integer for ABDKMath
        if (proportion > MAX64) return (0, false);

        int128 abdkProportion = ABDKMath64x64.fromUInt(proportion);
        // If abdkProportion is negative, this means that it is less than 1 and will
        // return a negative log so we exit here
        if (abdkProportion <= 0) return (0, false);

        int256 abdkLog = ABDKMath64x64.ln(abdkProportion);
        // This is the ABDK 64x64 multiplication with the 64x64 represenation of 1e18
        int256 result = (abdkLog * PRECISION_64x64) >> 64;

        if (result < ABDKMath64x64.MIN_64x64 || result > ABDKMath64x64.MAX_64x64) {
            return (0, false);
        }

        // Must to int128 conversion after the overflow checks above.
        return (ABDKMath64x64.toInt(int128(result)), true);
    }
}
