pragma solidity ^0.6.0;


/**
 * @title Swapnet rate oracle interface
 * @notice Contracts implementing this interface are able to provide rates to the swap
 *  risk and valuation framework.
 */
interface IRateOracle {
    /* is IERC165 */
    /**
     * This event is emitted whenever the rate is updated. The mechanism for how this mid rate is updated will
     * depend on the risk framework implementation.
     *
     * @param by is the address that caused the mid rate to change
     * @param periodId is the period id that was affected
     * @param rate is the new rate for the periodic swap
     */
    event RateChange(address indexed by, uint32 indexed periodId, uint32 rate, bool settled);

    /**
     * Returns the currently active periods. Note that this may read state to confirm whether or not
     * the market for a period has been created.
     *
     * @return an array of the active period ids
     */
    function getActivePeriods() external view returns (uint32[] memory);

    /**
     * Called when settling swaps, will return a rate an and a boolean field indicating if the
     * rate has been settled or not. If not settled, the the rate returned will be the market rate
     * that can be used to calculate the market NPV of the swap. The reason for this is that there
     * will be some time delay between maturity and the actual settlement of the swap rate.
     *
     * @param periodId the period id in question
     * @return the inferred or settled rate of the period that ends at periodId and a boolean flag
     *  indicating whether or no the period has been settled.
     */
    function getRate(uint32 periodId) external view returns (uint32, bool);

    /**
     * Returns the set of forward market rates based on the instrument group's period size.
     * @return a set of market rates defined by the number of periods
     */
    function getMarketRates() external view returns (uint32[] memory);

    /**
     * Settles a period at a rate when it matures. Can only be called by the Settlement Oracle. Emits
     * a RateChange event with the SettlementOracle as the the operator.
     *
     * @param periodId the period to settle
     * @param rate the rate to settle at
     */
    function settlePeriod(uint32 periodId, uint32 rate) external;

    /**
     * Sets governance parameters on the rate oracle.
     *
     * @param instrumentGroupId this cannot change once set
     * @param instrumentId cannot change once set
     * @param currency cannot change once set
     * @param precision will only take effect on a new period
     * @param periodSize will take effect immediately, must be careful
     * @param numPeriods will take effect immediately, makers can create new markets
     * @param maxRate will take effect immediately
     */
    function setParameters(
        uint8 instrumentGroupId,
        uint16 instrumentId,
        uint16 currency,
        uint32 precision,
        uint32 periodSize,
        uint32 numPeriods,
        uint32 maxRate
    ) external;
}
