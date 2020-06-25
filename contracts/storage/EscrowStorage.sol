pragma solidity ^0.6.0;

contract EscrowStorage {
    // keccak256("ERC777TokensRecipient")
    bytes32 internal constant TOKENS_RECIPIENT_INTERFACE_HASH = 0xb281fc8c12954d22544db45de3159a39272895b169a852b314f9cc762e44c53b;

    // Since ETH does not have a token address, we use the zero address to denominate its location. It also
    // has special functions for deposits.
    address internal constant G_ETH_CURRENCY = address(0);

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

    uint16 public maxCurrencyId;
    mapping(uint16 => address) public currencyIdToAddress;
    mapping(address => uint16) public addressToCurrencyId;
    uint16[] public depositCurrencies;

    // Mapping from base token address to quote token address
    mapping(address => mapping(address => ExchangeRate)) public exchangeRateOracles;
    // Mapping from token address => account address => balance held in escrow
    mapping(address => mapping(address => uint256)) public currencyBalances;

    /**
     * 6: Mapping from currency group id => account address => cash balance. Cash balance is generated
     * when settling swaps and can be positive or negative.
     */
    mapping(uint16 => mapping(address => int256)) public cashBalances;

    /********** Governance Settings ******************/
    // 7: The address of the account that holds reserve balances in each currency. Fees are paid to this
    // account on trading and in the case of a default, this account is drained.
    address public G_RESERVE_ACCOUNT;
    // 8: The discount given to a liquidator when they purchase ETH for the local currency of an obligation.
    // This discount is taken off of the exchange rate oracle price.
    uint128 public G_LIQUIDATION_DISCOUNT;
    // 9: The discount given to an account that settles obligations collateralized by ETH in order to settle
    // cash balances for accounts.
    uint128 public G_SETTLEMENT_DISCOUNT;
    /********** Governance Settings ******************/
}
