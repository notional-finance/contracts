// keccak256 hash of InitializeableAdminUpgradeabilityProxy creationCode
// const proxyCreationCodeHash = "0xf4088da406c79381cd1d8c9f9af63888ea285b7f2a9e095b072a227afda16833";

export const ErrorCodes = {
  EXCHANGE_RATE_UNDERFLOW: '1',
  EXCHANGE_RATE_OVERFLOW: '2',
  MARKET_INACTIVE: '3',
  OVER_MAX_COLLATERAL: '4',
  INSUFFICIENT_FREE_COLLATERAL: '5',
  INSUFFICIENT_CASH_BALANCE: '6',
  INVALID_SWAP: '7',
  INSUFFICIENT_BALANCE: '8',
  TRANSFER_FAILED: '9',
  INVALID_TRANSFER_TYPE: '10',
  COUNTERPARTY_CANNOT_BE_SELF: '11',
  CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL: '12',
  RAISE_CASH_FROM_PORTFOLIO_ERROR: '13',
  INVALID_RATE_FACTORS: '14',
  TRADE_FAILED_LACK_OF_LIQUIDITY: '15',
  TRADE_FAILED_TOO_LARGE: '16',
  TRADE_FAILED_SLIPPAGE: '17',
  TRADE_FAILED_MAX_TIME: '18',
  INVALID_CURRENCY: '19',
  UNAUTHORIZED_CALLER: '20',
  INCORRECT_CASH_BALANCE: '21',
  UNIMPLEMENTED: '22',
  CANNOT_TRANSFER_PAYER: '23',
  INVALID_ADDRESS: '24',
  ERC1155_NOT_ACCEPTED: '25',
  INTEGER_OVERFLOW: '26',
  OVER_MAX_ETH_BALANCE: '27',
  INVALID_EXCHANGE_RATE: '28',
  INSUFFICIENT_COLLATERAL_BALANCE: '29',
  INSUFFICIENT_COLLATERAL_FOR_SETTLEMENT: '30',
  OUT_OF_IMPLIED_RATE_BOUNDS: '31',
  OVER_CASH_GROUP_LIMIT: '32',
  INVALID_CASH_GROUP: '33',
  PORTFOLIO_TOO_LARGE: '34',
  CANNOT_TRANSFER_MATURED_ASSET: '35',
  MUST_HAVE_NET_POSITIVE_COLLATERAL: '36',
  INSUFFICIENT_FREE_COLLATERAL_LIQUIDATOR: '37',
  // NONE: '38',
  // NONE: '39',
  CANNOT_LIQUIDATE_SELF: '40',
  CANNOT_GET_PRICE_FOR_MATURITY: '41',
  CANNOT_SETTLE_PRICE_DISCREPENCY: '42',
  OVER_MAX_FCASH: '43',
  OVER_MAX_UINT128_AMOUNT: '44',
  PAST_MAX_MATURITY: '45',
  TRADE_MATURITY_ALREADY_PASSED: '46',
  INSUFFICIENT_LOCAL_CURRENCY_DEBT: '47',
  CANNOT_SETTLE_SELF: '48',
  INVALID_HAIRCUT_SIZE: '49',
  RATE_OVERFLOW: '50',
  INVALID_INSTRUMENT_PRECISION: '51',
  RAISING_LIQUIDITY_TOKEN_BALANCE_ERROR: '52',
  INVALID_ASSET_BATCH: '53',
  ASSET_NOT_FOUND: '54',
  ACCOUNT_HAS_COLLATERAL: '55',
  PORTFOLIO_HAS_LIQUIDITY_TOKENS: '56',
  PORTFOLIO_HAS_NO_RECEIVERS: '57',

  INT256_ADDITION_OVERFLOW: '100',
  INT256_MULTIPLICATION_OVERFLOW: '101',
  INT256_DIVIDE_BY_ZERO: '102',
  INT256_NEGATE_MIN_INT: '103',

  UINT128_ADDITION_OVERFLOW: '104',
  UINT128_SUBTRACTION_UNDERFLOW: '105',
  UINT128_MULTIPLICATION_OVERFLOW: '106',
  UINT128_DIVIDE_BY_ZERO: '107',

  UINT256_ADDITION_OVERFLOW: '108',
  UINT256_SUBTRACTION_UNDERFLOW: '109',
  UINT256_MULTIPLICATION_OVERFLOW: '110',
  UINT256_DIVIDE_BY_ZERO: '111',
  UINT256_MODULO_BY_ZERO: '112',

  ABDK_INT256_OVERFLOW: '113',
  ABDK_UINT256_OVERFLOW: '114',
  ABDK_MULTIPLICATION_OVERFLOW: '115',
  ABDK_NEGATIVE_LOG: '116',

  ErrorCode: function (code: number) {
    const matches = Object.values(ErrorCodes).filter((v) => {
      if (typeof v === 'string') {
        return v === code.toString();
      }
      return false;
    });

    if (matches.length === 0) {
      throw new Error(`Unknown error code value: ${code}`);
    }

    return `"${code}"`;
  },
};

export class ErrorDecoder {
  public static codeMap: Map<string, string>;

  private static reasonRegex = /VM Exception while processing transaction: revert (.+)$/;

  private static loadCodeMap() {
    this.codeMap = new Map<string, string>();
    for (const [key, val] of Object.entries(ErrorCodes)) {
      if (typeof val == 'string') {
        this.codeMap.set(val, key);
      }
    }
  }

  public static decodeError(reason: any) {
    if (this.codeMap == null) {
      this.loadCodeMap();
    }

    reason = reason instanceof Object && 'message' in reason ? reason.message : reason;
    const code = reason.toString().match(this.reasonRegex);
    if (code == null) {
      return reason;
    } else if (code[1] != null) {
      return code[1];
    } else {
      return reason;
    }
  }

  public static encodeError(errorCode: string) {
    return `VM Exception while processing transaction: revert ${errorCode}`;
  }
}
