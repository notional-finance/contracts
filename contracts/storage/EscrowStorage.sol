pragma solidity ^0.6.0;

contract EscrowStorage {
    // keccak256("ERC777TokensRecipient")
    bytes32 internal constant TOKENS_RECIPIENT_INTERFACE_HASH = 0xb281fc8c12954d22544db45de3159a39272895b169a852b314f9cc762e44c53b;

    // Since ETH does not have a token address, we use the zero address to denominate its location. It also
    // has special functions for deposits.
    address internal constant G_ETH_CURRENCY = address(0);

    /**
     * A currency group defines a group of tokens that are practically risk free equivalents of each other.
     * For example, Dai could be a primary currency and offshoots of Dai such as Chai or cDai would be
     * secondary currencies. USDC would be a different primary currency and cUSDC would be a secondary currency.
     * Secondary currencies allow accounts to earn a variable rate of return on top of their collateral. All
     * future cash is still denominated in the primary currency.
     */
    struct CurrencyGroup {
        // This is the token address for the primary currency (e.g. Dai). This is the currency that all the
        // transactions in this currency group will be denominated in.
        address primary;
        // Secondary currencies are tokens that wrap the primary currency and give it different properties
        // and a different exchange rate. cDai, for example, gives Dai an interest rate and has an exchange
        // rate for Dai. There may be multiple secondary currencies for a currency group. In the initial version
        // of the Swapnet protocol, these secondaries are not used.
        address[] secondaries;
    }

    /**
     * Exchange rates are defined by an oracle and an on chain exchange. In the future, these may be combined
     * into a single contract (i.e. via Uniswap V2 price oracles). However, in this version they are separate.
     * The rate oracle is a chainlink price oracle and on the onChainExchange is the Uniswap V1 exchange.
     */
    struct ExchangeRate {
        // The address of the chainlink price oracle
        address rateOracle;
        // The address of the uniswap exchange. This is used for trustlessly settling cash on chain.
        address onChainExchange;
        // Amount of haircut to apply to the exchange rate, this defines the collateralization ratio
        // between the two currencies.
        uint128 haircut;
    }

    // 1: The current currency group id.
    uint16 public currentCurrencyGroupId;

    // 2: Mapping from currencyId to a currency group object.
    mapping(uint16 => CurrencyGroup) public currencyGroups;

    // 3: Mapping from token addresses to a currency group object. Used to check if a token is in a valid
    // currency group when depositing tokens.
    mapping(address => uint16) public tokensToGroups;

    // 4: The address of an exchange rate oracle between two currencies.
    mapping(address => mapping(address => ExchangeRate)) public exchangeRateOracles;

    /**
     * 5: Mapping from currency address => account address => balance. This value is always
     * positive and we convert each of these balances using the exchangeRateOracle
     * the current value in the primary currency. No single token can be used in two different
     * currency groups.
     */
    mapping(address => mapping(address => uint256)) public currencyBalances;

    /**
     * 6: Mapping from currency group id => account address => cash balance. Cash balance is generated
     * when settling swaps and can be positive or negative. It is always denominated in the primary
     * currency of the group.
     */
    mapping(uint16 => mapping(address => int256)) public cashBalances;

    /********** Governance Settings ******************/
    // 7: In this version of Swapnet, we denominate a single currency group (ETH) to be the collateral
    // for all obligations. This means that USDC cannot collateralize Dai and vice versa. This variable
    // holds the currency group id for the ETH currency group.
    uint16 public G_COLLATERAL_CURRENCY;
    // 8: This is the primary token address defined in the G_COLLATERAL_CURRENCY group.
    // TODO: remove this in favor of a lookup in currency group
    address public G_COLLATERAL_TOKEN;
    // 9: The address of the account that holds reserve balances in each currency. Fees are paid to this
    // account on trading and in the case of a default, this account is drained.
    address public G_RESERVE_ACCOUNT;
    // 10: The discount given to a liquidator when they purchase ETH for the local currency of an obligation.
    // This discount is taken off of the exchange rate oracle price.
    uint128 public G_LIQUIDATION_DISCOUNT;
    // 11: The discount given to an account that settles obligations collateralized by ETH in order to settle
    // cash balances for accounts.
    uint128 public G_SETTLEMENT_DISCOUNT;
    /********** Governance Settings ******************/
}
