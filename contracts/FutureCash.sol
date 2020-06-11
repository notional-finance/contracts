pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./lib/SafeUInt128.sol";
import "./lib/SafeInt256.sol";
import "./lib/ABDKMath64x64.sol";
import "./lib/SafeMath.sol";
import "./lib/UniswapExchangeInterface.sol";

import "./utils/Governed.sol";
import "./utils/Directory.sol";
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

    function initialize(address _directory, address collateralToken) public initializer {
        Governed.initialize(_directory);

        // This sets an immutable parameter that defines the token that this future cash market trades.
        G_COLLATERAL_TOKEN = collateralToken;

        // Setting dependencies can only be done once here. With proxy contracts the addresses shouldn't
        // change as we upgrade the logic.
        Governed.CoreContracts[] memory dependencies = new Governed.CoreContracts[](2);
        dependencies[0] = CoreContracts.Escrow;
        dependencies[1] = CoreContracts.Portfolios;
        address[] memory _contracts = Directory(directory).getContracts(dependencies);

        contracts[uint256(CoreContracts.Escrow)] = _contracts[0];
        contracts[uint256(CoreContracts.Portfolios)] = _contracts[1];
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
    uint8 public INSTRUMENT_GROUP;
    uint16 public INSTRUMENT;
    uint16 public CURRENCY_GROUP;
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
     *
     * @param instrumentGroupId this cannot change once set
     * @param instrumentId cannot change once set
     * @param currency cannot change once set
     * @param precision will only take effect on a new period
     * @param periodSize will take effect immediately, must be careful
     * @param numPeriods will take effect immediately, makers can create new markets
     */
    function setParameters(
        uint8 instrumentGroupId,
        uint16 instrumentId,
        uint16 currency,
        uint32 precision,
        uint32 periodSize,
        uint32 numPeriods,
        uint32 /* maxRate */
    ) external {
        require(msg.sender == contracts[uint256(CoreContracts.Portfolios)], $$(ErrorCode(UNAUTHORIZED_CALLER)));

        // These values cannot be reset once set.
        if (INSTRUMENT_GROUP == 0) {
            INSTRUMENT_GROUP = instrumentGroupId;
            INSTRUMENT = instrumentId;
            CURRENCY_GROUP = currency;
            INSTRUMENT_PRECISION = precision;
            G_PERIOD_SIZE = periodSize;
        }

        // This is the only mutable governance parameter.
        G_NUM_PERIODS = numPeriods;
    }

    function setRateFactors(uint32 rateAnchor, uint16 rateScalar) external onlyOwner {
        require(rateScalar >= 0 && rateAnchor >= 0, $$(ErrorCode(INVALID_RATE_FACTORS)));
        G_RATE_SCALAR = rateScalar;
        G_RATE_ANCHOR = rateAnchor;
    }

    function setMaxTradeSize(uint128 amount) external onlyOwner {
        G_MAX_TRADE_SIZE = amount;
    }

    function setFee(uint32 liquidityFee, uint128 transactionFee) external onlyOwner {
        G_LIQUIDITY_FEE = liquidityFee;
        G_TRANSACTION_FEE = transactionFee;
    }
    /********** Governance Parameters *********************/

    /********** Events ************************************/
    event AddLiquidity(address indexed account, uint32 maturity, uint128 tokens, uint128 futureCash, uint128 currentAmount);
    event RemoveLiquidity(address indexed account, uint32 maturity, uint128 tokens, uint128 futureCash, uint128 currentAmount);
    event TakeCollateral(address indexed account, uint32 maturity, uint128 futureCash, uint128 currentAmount, uint128 fee);
    event TakeFutureCash(address indexed account, uint32 maturity, uint128 futureCash, uint128 currentAmount, uint128 fee);
    /********** Events ************************************/

    /********** Liquidity Tokens **************************/

    /**
     * @notice Adds some amount of future cash to the liquidity pool up to the corresponding amount defined by
     * `maxCollateral`. Mints liquidity tokens back to the sender.
     *
     * @param maturity the period to add liquidity to
     * @param minFutureCash the amount of future cash to add to the pool
     * @param maxCollateral the maximum amount of collateral to add to the pool
     * @param maxBlock after this block the trade will fail
     */
    function addLiquidity(uint32 maturity, uint128 minFutureCash, uint128 maxCollateral, uint32 maxBlock) public {
        _isValidBlock(maturity, maxBlock);
        Market storage market = markets[maturity];
        // We call settle here instead of at the end of the function because if we have matured liquidity
        // tokens this will put collateral back into our portfolio so that we can add it back into the markets.
        Portfolios(contracts[uint256(CoreContracts.Portfolios)]).settleAccount(msg.sender);

        uint128 collateral;
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

            market.totalFutureCash = minFutureCash;
            market.totalCollateral = maxCollateral;
            market.totalLiquidity = minFutureCash;
            // We have to initialize this to the exchange rate implied by the proportion of cash to future cash.
            uint32 blocksToMaturity = maturity - uint32(block.number);
            market.lastImpliedRate = _getImpliedRate(market, blocksToMaturity);

            liquidityTokenAmount = minFutureCash;
            collateral = maxCollateral;
        } else {
            // We calculate the amount of liquidity tokens to mint based on the share of the future cash
            // that the liquidity provider is depositing.
            liquidityTokenAmount = uint128(
                uint256(market.totalLiquidity).mul(minFutureCash).div(market.totalFutureCash)
            );

            // We use the prevailing proportion to calculate the required amount of current cash to deposit.
            collateral = uint128(uint256(market.totalCollateral).mul(minFutureCash).div(market.totalFutureCash));
            // If this proportion has moved beyond what the liquidity provider is willing to pay then we
            // will revert here.
            require(collateral <= maxCollateral, $$(ErrorCode(OVER_MAX_COLLATERAL)));

            // Add the future cash and collateral to the pool.
            market.totalFutureCash = market.totalFutureCash.add(minFutureCash);
            market.totalCollateral = market.totalCollateral.add(collateral);
            market.totalLiquidity = market.totalLiquidity.add(liquidityTokenAmount);
        }

        // Move the collateral into the contract's collateral balances account. This must happen before the trade
        // is placed so that the free collateral check is correct.
        Escrow(contracts[uint256(CoreContracts.Escrow)]).transferFutureCashMarket(
            msg.sender,
            G_COLLATERAL_TOKEN,
            CURRENCY_GROUP,
            INSTRUMENT_GROUP,
            true,
            collateral,
            0 // No fee charged for providing liquidity
        );

        // Providing liquidity results in two tokens generated, a liquidity token and a CASH_PAYER which
        // represents the obligation that offsets the future cash in the market.
        Common.Trade[] memory trades = new Common.Trade[](2);
        // This is the liquidity token
        trades[0] = Common.Trade(
            INSTRUMENT_GROUP,
            INSTRUMENT,
            maturity - G_PERIOD_SIZE,
            G_PERIOD_SIZE,
            Common.getLiquidityToken(),
            INSTRUMENT_PRECISION,
            liquidityTokenAmount
        );

        // This is the CASH_PAYER
        trades[1] = Common.Trade(
            INSTRUMENT_GROUP,
            INSTRUMENT,
            maturity - G_PERIOD_SIZE,
            G_PERIOD_SIZE,
            Common.getFutureCash(true),
            INSTRUMENT_PRECISION,
            minFutureCash
        );

        // This will do a free collateral check before it adds to the portfolio.
        Portfolios(contracts[uint256(CoreContracts.Portfolios)]).upsertAccountTradeBatch(msg.sender, trades);

        emit AddLiquidity(msg.sender, maturity, liquidityTokenAmount, minFutureCash, collateral);
    }

    /**
     * @notice Removes liquidity from the future cash market. The sender's liquidity tokens are burned and they
     * are credited back with future cash and collateral at the prevailing exchange rate. This function
     * only works when removing liquidity from an active market. For markets that are matured, the sender
     * must settle their liquidity token because it involves depositing current cash and settling future
     * cash balances.
     *
     * @param maturity the period to remove liquidity from
     * @param amount the amount of liquidity tokens to burn
     * @param maxBlock after this block the trade will fail
     */
    function removeLiquidity(uint32 maturity, uint128 amount, uint32 maxBlock) public {
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

        // Move the collateral from the contract's collateral balances account back to the sender. This must happen
        // before the free collateral check in the Portfolio call below.
        Escrow(contracts[uint256(CoreContracts.Escrow)]).transferFutureCashMarket(
            msg.sender,
            G_COLLATERAL_TOKEN,
            CURRENCY_GROUP,
            INSTRUMENT_GROUP,
            false,
            collateral,
            0 // No fee charged for removing liquidity
        );

        Common.Trade[] memory trades = new Common.Trade[](2);
        // This will remove the liquidity tokens
        trades[0] = Common.Trade(
            INSTRUMENT_GROUP,
            INSTRUMENT,
            maturity - G_PERIOD_SIZE,
            G_PERIOD_SIZE,
            // We mark this as a "PAYER" liquidity token so the portfolio reduces the balance
            Common.makeCounterparty(Common.getLiquidityToken()),
            INSTRUMENT_PRECISION,
            amount
        );

        // This is the CASH_RECEIVER
        trades[1] = Common.Trade(
            INSTRUMENT_GROUP,
            INSTRUMENT,
            maturity - G_PERIOD_SIZE,
            G_PERIOD_SIZE,
            Common.getFutureCash(false),
            INSTRUMENT_PRECISION,
            futureCashAmount
        );

        // This function call will check if the account in question actually has enough liquidity tokens to remove.
        Portfolios(contracts[uint256(CoreContracts.Portfolios)]).upsertAccountTradeBatch(msg.sender, trades);

        emit RemoveLiquidity(msg.sender, maturity, amount, futureCashAmount, collateral);
    }

    /**
     * @notice Settles a liquidity token into future cash and collateral. Can only be called by the Portfolios contract.
     *
     * @param account the account that is holding the token
     * @param tokenAmount the amount of token to settle
     * @param maturity when the token matures
     * @return the amount of cash to settle to the account
     */
    function settleLiquidityToken(address account, uint128 tokenAmount, uint32 maturity) public returns (uint128) {
        require(msg.sender == contracts[uint256(CoreContracts.Portfolios)], $$(ErrorCode(UNAUTHORIZED_CALLER)));

        (uint128 collateral, uint128 futureCash) = _settleLiquidityToken(tokenAmount, maturity);

        // Move the collateral from the contract's collateral balances account back to the sender
        Escrow(contracts[uint256(CoreContracts.Escrow)]).transferFutureCashMarket(
            account,
            G_COLLATERAL_TOKEN,
            CURRENCY_GROUP,
            INSTRUMENT_GROUP,
            false,
            collateral,
            0 // No fee charged on liquidity removal
        );

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
     *
     * @param maturity the maturity of the future cash
     * @param futureCashAmount the amount of future cash to input
     * @return the amount of collateral this would purchase, returns 0 if the trade will fail
     */
    function getFutureCashToCollateral(uint32 maturity, uint128 futureCashAmount) public view returns (uint128) {
        return getFutureCashToCollateralBlock(maturity, futureCashAmount, uint32(block.number));
    }

    /**
     * @notice Given the amount of future cash put into a market, how much collateral this would
     * purchase at the given block
     *
     * @param maturity the maturity of the future cash
     * @param futureCashAmount the amount of future cash to input
     * @param blockNum the specified block number
     * @return the amount of collateral this would purchase, returns 0 if the trade will fail
     */
    function getFutureCashToCollateralBlock(uint32 maturity, uint128 futureCashAmount, uint32 blockNum) public view returns (uint128) {
        Market memory interimMarket = markets[maturity];
        uint32 blocksToMaturity = maturity - blockNum;

        (/* market */, uint128 currentAmount) = _tradeCalculation(interimMarket, futureCashAmount, blocksToMaturity, true);
        // On trade failure, we will simply return 0
        return currentAmount;
    }

    /**
     * @notice Receive collateral in exchange for a future cash obligation. Equivalent to borrowing
     * collateral at a fixed rate.
     *
     * @param maturity the maturity block of the future cash being exchange for current cash
     * @param futureCashAmount the amount of future cash to deposit, will convert this amount to current cash
     *  at the prevailing exchange rate
     * @param maxBlock after this block the trade will not settle
     * @param minCollateral the minimum amount of collateral this trade should purchase, this is the slippage amount
     * @return the amount of collateral purchased
     */
    function takeCollateral(
        uint32 maturity,
        uint128 futureCashAmount,
        uint32 maxBlock,
        uint128 minCollateral
    ) public returns (uint128) {
        _isValidBlock(maturity, maxBlock);
        require(futureCashAmount <= G_MAX_TRADE_SIZE, $$(ErrorCode(TRADE_FAILED_TOO_LARGE)));

        // In this block we calculate what the market will look like after we trade future cash amount.
        Market memory interimMarket = markets[maturity];
        uint128 currentAmount;
        uint32 blocksToMaturity = maturity - uint32(block.number);
        (interimMarket, currentAmount) = _tradeCalculation(interimMarket, futureCashAmount, blocksToMaturity, true);

        require(currentAmount > 0, $$(ErrorCode(TRADE_FAILED_LACK_OF_LIQUIDITY)));
        require(currentAmount >= minCollateral, $$(ErrorCode(TRADE_FAILED_SLIPPAGE)));

        // Here we update all the required storage values.
        Market storage market = markets[maturity];
        market.totalFutureCash = interimMarket.totalFutureCash;
        market.totalCollateral = interimMarket.totalCollateral;
        market.lastImpliedRate = interimMarket.lastImpliedRate;
        market.rateAnchor = interimMarket.rateAnchor;

        // This will reduce the `currentAmount` that the sender receives as a result of their borrowing.
        uint128 fee = currentAmount.mul(G_TRANSACTION_FEE).div(Common.DECIMALS);

        // Move the collateral from the contract's collateral balances account to the sender. This must happen before
        // the call to insert the trade below in order for the free collateral check to work properly.
        Escrow(contracts[uint256(CoreContracts.Escrow)]).transferFutureCashMarket(
            msg.sender,
            G_COLLATERAL_TOKEN,
            CURRENCY_GROUP,
            INSTRUMENT_GROUP,
            false,
            currentAmount,
            fee
        );

        // The sender now has an obligation to pay cash at maturity.
        Portfolios(contracts[uint256(CoreContracts.Portfolios)]).upsertAccountTrade(
            msg.sender,
            Common.Trade(
                INSTRUMENT_GROUP,
                INSTRUMENT,
                maturity - G_PERIOD_SIZE,
                G_PERIOD_SIZE,
                Common.getFutureCash(true),
                INSTRUMENT_PRECISION,
                futureCashAmount
            )
        );

        emit TakeCollateral(
            msg.sender,
            maturity,
            futureCashAmount,
            currentAmount,
            fee
        );

        return currentAmount - fee;
    }

    /**
     * @notice Given the amount of future cash to purchase, returns the amount of collateral this would cost at the current
     * block.
     *
     * @param maturity the maturity of the future cash
     * @param futureCashAmount the amount of future cash to purchase
     * @return the amount of collateral this would cost, returns 0 on trade failure
     */
    function getCollateralToFutureCash(uint32 maturity, uint128 futureCashAmount) public view returns (uint128) {
        return getCollateralToFutureCashBlock(maturity, futureCashAmount, uint32(block.number));
    }

    /**
     * @notice Given the amount of future cash to purchase, returns the amount of collateral this would cost.
     *
     * @param maturity the maturity of the future cash
     * @param futureCashAmount the amount of future cash to purchase
     * @param blockNum the block to calculate the price at
     * @return the amount of collateral this would cost, returns 0 on trade failure
     */
    function getCollateralToFutureCashBlock(uint32 maturity, uint128 futureCashAmount, uint32 blockNum) public view returns (uint128) {
        Market memory interimMarket = markets[maturity];
        uint32 blocksToMaturity = maturity - blockNum;

        (/* market */, uint128 currentAmount) = _tradeCalculation(interimMarket, futureCashAmount, blocksToMaturity, false);
        // On trade failure, we will simply return 0
        return currentAmount;
    }

    /**
     * @notice Deposit collateral in return for the right to receive cash at the specified maturity. Equivalent to lending
     * your collateral at a fixed rate.
     *
     * @param maturity the period to receive future cash in
     * @param futureCashAmount the amount of future cash to purchase
     * @param maxBlock after this block the trade will not settle
     * @param maxCollateral the maximum amount of collateral to deposit for this future cash, this is the slippage amount
     * @return the amount of collateral deposited to the market
     */
    function takeFutureCash(
        uint32 maturity,
        uint128 futureCashAmount,
        uint32 maxBlock,
        uint128 maxCollateral
    ) public returns (uint128) {
        _isValidBlock(maturity, maxBlock);
        require(futureCashAmount <= G_MAX_TRADE_SIZE, $$(ErrorCode(TRADE_FAILED_TOO_LARGE)));

        Market storage market = markets[maturity];
        Market memory interimMarket = markets[maturity];

        uint128 currentAmount;
        uint32 blocksToMaturity = maturity - uint32(block.number);
        (interimMarket, currentAmount) = _tradeCalculation(interimMarket, futureCashAmount, blocksToMaturity, false);

        uint128 fee = currentAmount.mul(G_TRANSACTION_FEE).div(Common.DECIMALS);
        // The collateral required to deposit is the amount plus the fee.
        currentAmount = currentAmount + fee;

        require(currentAmount > 0, $$(ErrorCode(TRADE_FAILED_LACK_OF_LIQUIDITY)));
        require(currentAmount <= maxCollateral, $$(ErrorCode(TRADE_FAILED_SLIPPAGE)));

        // Here we update all the required storage values.
        market.totalFutureCash = interimMarket.totalFutureCash;
        market.totalCollateral = interimMarket.totalCollateral;
        market.lastImpliedRate = interimMarket.lastImpliedRate;
        market.rateAnchor = interimMarket.rateAnchor;

        // Move the collateral from the sender to the contract address. This must happen before the
        // insert trade call below.
        Escrow(contracts[uint256(CoreContracts.Escrow)]).transferFutureCashMarket(
            msg.sender,
            G_COLLATERAL_TOKEN,
            CURRENCY_GROUP,
            INSTRUMENT_GROUP,
            true,
            currentAmount,
            fee
        );

        // The sender is now owed a future cash balance at maturity
        Portfolios(contracts[uint256(CoreContracts.Portfolios)]).upsertAccountTrade(
            msg.sender,
            Common.Trade(
                INSTRUMENT_GROUP,
                INSTRUMENT,
                maturity - G_PERIOD_SIZE,
                G_PERIOD_SIZE,
                Common.getFutureCash(false),
                INSTRUMENT_PRECISION,
                futureCashAmount
            )
        );

        emit TakeFutureCash(
            msg.sender,
            maturity,
            futureCashAmount,
            currentAmount,
            fee
        );

        return currentAmount - fee;
    }

    /********** Trading Cash ******************************/

    /********** Liquidation *******************************/

    /**
     * @notice Uses collateralAvailable to purchase future cash in order to offset the obligation amount at
     * the specified maturity. Used by the Portfolio contract during liquidation.
     *
     * @param collateralAvailable amount of collateral available to purchase offsetting obligations
     * @param obligation the max amount of obligations to offset
     * @param maturity the maturity of the obligation
     * @return (collateral cost of offsetting future cash, the amount of obligation offset)
     */
    function closeObligation(
        uint128 collateralAvailable,
        uint128 obligation,
        uint32 maturity
    ) public returns (uint128, uint128) {
        require(msg.sender == contracts[uint256(CoreContracts.Portfolios)], $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Market storage market = markets[maturity];
        Market memory interimMarket = markets[maturity];
        uint32 blocksToMaturity = maturity - uint32(block.number);
        uint128 receiverCost;

        // The floor for the value these positions is at a 1-1 exchange rate. This is the least favorable rate
        // for the liquidated account since we guarantee that exchange rates cannot go below zero.
        if (collateralAvailable >= obligation && market.totalFutureCash >= obligation) {
            // We can purchase more future cash than we have in this asset so let's get the cost to
            // just offset this position.
            (interimMarket, receiverCost) = _tradeCalculation(interimMarket, obligation, blocksToMaturity, false);

            // A cost of 0 signifies a failed trade.
            if (receiverCost > 0) {
                market.totalFutureCash = interimMarket.totalFutureCash;
                market.totalCollateral = interimMarket.totalCollateral;
                market.lastImpliedRate = interimMarket.lastImpliedRate;
                market.rateAnchor = interimMarket.rateAnchor;

                return (receiverCost, obligation);
            }
        } else if (market.totalFutureCash >= collateralAvailable) {
            // We cannot accurately calculate how much future cash we can possibly offset here, but
            // we know that it is at least "collateralAvailable". Figure out the cost for that and then
            // proceed.
            (interimMarket, receiverCost) = _tradeCalculation(interimMarket, collateralAvailable, blocksToMaturity, false);

            if (receiverCost > 0) {
                // We can only partially offset the future cash we have in the asset so just update
                // the asset.
                market.totalFutureCash = interimMarket.totalFutureCash;
                market.totalCollateral = interimMarket.totalCollateral;
                market.lastImpliedRate = interimMarket.lastImpliedRate;
                market.rateAnchor = interimMarket.rateAnchor;

                return (receiverCost, collateralAvailable);
            }
        }

        // Closing out the obligation was unsuccessful.
        return (0, 0);
    }

    /**
     * @notice Turns future cash tokens into a current collateral. Used by portfolios when settling cash.
     * This method currently sells `maxFutureCash` every time since it's not possible to calculate the
     * amount of future cash to sell from `collateralRequired`.
     *
     * @param account that holds the future cash
     * @param collateralRequired amount of collateral that needs to be raised
     * @param maxFutureCash the maximum amount of future cash that can be sold
     * @param maturity the maturity of the future cash
     */
    function extractFutureCash(
        address account,
        uint128 collateralRequired,
        uint128 maxFutureCash,
        uint32 maturity
    ) public returns (uint128) {
        require(msg.sender == contracts[uint256(CoreContracts.Portfolios)], $$(ErrorCode(UNAUTHORIZED_CALLER)));

        Market storage market = markets[maturity];
        Market memory interimMarket = markets[maturity];
        uint128 currentAmount;
        uint32 blocksToMaturity = maturity - uint32(block.number);
        uint128 futureCashAmount = maxFutureCash;

        if (maxFutureCash > market.totalFutureCash) {
            // Don't sell future cash than is in the market.
            futureCashAmount = market.totalFutureCash;
        }

        // Here we are selling future cash in return for collateral
        (interimMarket, currentAmount) = _tradeCalculation(interimMarket, futureCashAmount, blocksToMaturity, true);

        // Here we update all the required storage values.
        market.totalFutureCash = interimMarket.totalFutureCash;
        market.totalCollateral = interimMarket.totalCollateral;
        market.lastImpliedRate = interimMarket.lastImpliedRate;
        market.rateAnchor = interimMarket.rateAnchor;

        // Here we've sold collateral in excess of what was required, so we credit the remaining back
        // to the account that was holding the trade.
        if (currentAmount > collateralRequired) {
            Escrow(contracts[uint256(CoreContracts.Escrow)]).transferFutureCashMarket(
                account,
                G_COLLATERAL_TOKEN,
                CURRENCY_GROUP,
                INSTRUMENT_GROUP,
                false,
                currentAmount - collateralRequired,
                0 // No fee charged
            );

            currentAmount = collateralRequired;
        }

        return currentAmount;
    }

    /**
     * @notice Called by the portfolios contract when a liquidity token is being converted for collateral.
     *
     * @param collateralRequired the amount of collateral required
     * @param maxTokenAmount the max balance of tokens available
     * @param maturity when the token matures
     * @return the amount of collateral raised, future cash raised, tokens removed
     */
    function extractCashLiquidityToken(
        uint128 collateralRequired,
        uint128 maxTokenAmount,
        uint32 maturity
    ) public returns (uint128, uint128, uint128) {
        require(msg.sender == contracts[uint256(CoreContracts.Portfolios)], $$(ErrorCode(UNAUTHORIZED_CALLER)));
        Market memory market = markets[maturity];

        // This is the total claim on collateral that the tokens have.
        uint128 tokensToRemove = maxTokenAmount;
        uint128 collateralAmount = uint128(
            uint256(market.totalCollateral).mul(tokensToRemove).div(market.totalLiquidity)
        );

        if (collateralAmount > collateralRequired) {
            // If the total claim is greater than required, we only want to remove part of the liquidity.
            tokensToRemove = uint128(uint256(collateralRequired).mul(market.totalLiquidity).div(market.totalCollateral));
            collateralAmount = collateralRequired;
        }

        // This method will credit the collateralAmount back to the balances on the escrow contract.
        (/* uint128 */, uint128 futureCashAmount) = _settleLiquidityToken(tokensToRemove, maturity);

        return (collateralAmount, futureCashAmount, tokensToRemove);
    }

    /********** Liquidation *******************************/

    /********** Rate Methods ******************************/

    /**
     * @notice Returns the current discount rate for the market. Will not return negative interest rates
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
     * @notice Checks if the maturity and max block supplied are valid. The requirements are:
     *  - blockNum <= maxBlock < maturity <= maxMaturity
     *  - maturity % G_PERIOD_SIZE == 0
     * Reverts if the block is not valid.
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
     * @notice Does the trade calculation and returns the required objects for the contract methods to interpret.
     *
     * @param interimMarket the market to do the calculations over
     * @param futureCashAmount the future cash amount specified
     * @param futureCashPositive true if future cash is positive (borrowing), false if future cash is negative (lending)
     * @return (new market object, currentAmount)
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

        // The fee amount will decrease as we roll down to maturity
        uint32 fee = uint32(uint256(G_LIQUIDITY_FEE).mul(blocksToMaturity).div(G_PERIOD_SIZE));
        if (futureCashPositive) {
            tradeExchangeRate = tradeExchangeRate + fee;
        } else {
            tradeExchangeRate = tradeExchangeRate - fee;
        }

        if (tradeExchangeRate < INSTRUMENT_PRECISION) {
            // We do not allow negative exchange rates.
            return (interimMarket, 0);
        }

        // currentAmount = futureCashAmount / exchangeRate
        uint128 currentAmount = uint128(
            uint256(futureCashAmount).mul(INSTRUMENT_PRECISION).div(tradeExchangeRate)
        );

        // Update the markets accordingly.
        if (futureCashPositive) {
            if (interimMarket.totalCollateral < currentAmount) {
                // There is not enough collateral to support this trade.
                return (interimMarket, 0);
            }

            interimMarket.totalFutureCash = interimMarket.totalFutureCash.add(futureCashAmount);
            interimMarket.totalCollateral = interimMarket.totalCollateral.sub(currentAmount);
        } else {
            interimMarket.totalFutureCash = interimMarket.totalFutureCash.sub(futureCashAmount);
            interimMarket.totalCollateral = interimMarket.totalCollateral.add(currentAmount);
        }

        // Now calculate the implied rate, this will be used for future rolldown calculations.
        interimMarket.lastImpliedRate = _getImpliedRate(interimMarket, blocksToMaturity);

        return (interimMarket, currentAmount);
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
        uint256 proportion = numerator.mul(Common.DECIMALS).div(
            market.totalFutureCash.add(market.totalCollateral)
        );

        // proportion' = proportion / (1 - proportion)
        proportion = proportion.mul(Common.DECIMALS).div(uint256(Common.DECIMALS).sub(proportion));

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
