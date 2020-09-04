pragma solidity ^0.6.0;

contract EscrowStorage {
    // keccak256("ERC777TokensRecipient")
    bytes32 internal constant TOKENS_RECIPIENT_INTERFACE_HASH = 0xb281fc8c12954d22544db45de3159a39272895b169a852b314f9cc762e44c53b;

    // Internally we use WETH to represent ETH
    address public WETH;

    /**
     * Exchange rates are defined by an oracle and an on chain exchange. In the future, these may be combined
     * into a single contract (i.e. via Uniswap V2 price oracles). However, in this version they are separate.
     * The rate oracle is a chainlink price oracle and on the onChainExchange is the Uniswap V1 exchange.
     */
    struct ExchangeRate {
        // The address of the chainlink price oracle
        address rateOracle;
        // The decimals of precision that the rate oracle uses
        uint128 rateDecimals;
        // True of the exchange rate must be inverted
        bool mustInvert;
        // Amount of haircut to apply to the exchange rate, this defines the collateralization ratio
        // between the two currencies. This must be stored with 18 decimal precision because it is used
        // to convert to an ETH balance.
        uint128 haircut;
    }

    // Holds token features that can be used to check certain behaviors on deposit / withdraw.
    struct TokenOptions {
        // Whether or not the token implements the ERC777 standard.
        bool isERC777;
        // Whether or not the token charges transfer fees
        bool hasTransferFee;
    }

    uint16 public maxCurrencyId;
    mapping(uint16 => address) public currencyIdToAddress;
    mapping(uint16 => uint256) public currencyIdToDecimals;
    mapping(address => uint16) public addressToCurrencyId;
    mapping(address => TokenOptions) public tokenOptions;

    // Mapping from base currency id to quote currency id
    mapping(uint16 => mapping(uint16 => ExchangeRate)) public exchangeRateOracles;

    // Holds account cash balances that can be positive or negative.
    mapping(uint16 => mapping(address => int256)) public cashBalances;

    /********** Governance Settings ******************/
    // The address of the account that holds reserve balances in each currency. Fees are paid to this
    // account on trading and in the case of a default, this account is drained.
    address public G_RESERVE_ACCOUNT;
    // The discount given to a liquidator when they purchase ETH for the local currency of an obligation.
    // This discount is taken off of the exchange rate oracle price.
    uint128 public G_LIQUIDATION_DISCOUNT;
    // The discount given to an account that settles obligations collateralized by ETH in order to settle
    // cash balances for accounts.
    uint128 public G_SETTLEMENT_DISCOUNT;
    // This is the incentive given to liquidators who pull liquidity tokens out of an undercollateralized
    // account in order to bring it back into collateralization.
    uint128 public G_LIQUIDITY_TOKEN_REPO_INCENTIVE;
    // Cached copy of the same value on the RiskFramework contract.
    uint128 public G_LIQUIDITY_HAIRCUT;
    /********** Governance Settings ******************/
}
