export const ErrorCodes = {
    EXCHANGE_RATE_UNDERFLOW: "1",
    EXCHANGE_RATE_OVERFLOW: "2",
    MARKET_INACTIVE: "3",
    OVER_MAX_COLLATERAL: "4",
    INSUFFICIENT_FREE_COLLATERAL: "5",
    INSUFFICIENT_CASH_BALANCE: "6",
    INVALID_SWAP: "7",
    INSUFFICIENT_BALANCE: "8",
    TRANSFER_FAILED: "9",
    INVALID_TRANSFER_TYPE: "10",
    COUNTERPARTY_CANNOT_BE_SELF: "11",
    CANNOT_LIQUIDATE_SUFFICIENT_COLLATERAL: "12",
    RAISE_CASH_FROM_PORTFOLIO_ERROR: "13",
    INVALID_RATE_FACTORS: "14",
    TRADE_FAILED_LACK_OF_LIQUIDITY: "15",
    TRADE_FAILED_TOO_LARGE: "16",
    TRADE_FAILED_SLIPPAGE: "17",
    TRADE_FAILED_MAX_BLOCK: "18",
    INVALID_CURRENCY: "19",
    UNAUTHORIZED_CALLER: "20",
    INCORRECT_CASH_BALANCE: "21",
    UNIMPLEMENTED: "22",
    CANNOT_SETTLE_PRICE_DISCREPENCY: "23",
    CANNOT_TRANSFER_PAYER: "23",
    INVALID_ADDRESS: "24",
    ERC1155_NOT_ACCEPTED: "25",
    INTEGER_OVERFLOW: "26",
    OVER_MAX_ETH_BALANCE: "27",
    INVALID_EXCHANGE_RATE: "28",
    INSUFFICIENT_COLLATERAL_BALANCE: "29",
    INSUFFICIENT_COLLATERAL_FOR_SETTLEMENT: "30",
    OVER_MAX_FUTURE_CASH: "31",
    OVER_FUTURE_CASH_GROUP_LIMIT: "32",
    INVALID_FUTURE_CASH_GROUP: "33",
    PORTFOLIO_TOO_LARGE: "34",
    CANNOT_TRANSFER_MATURED_ASSET: "35",
    NO_EXCHANGE_LISTED_FOR_PAIR: "36",
    INVALID_DEPOSIT_CURRENCY: "37",
    INVALID_TRADABLE_CURRENCY: "38",
    RESERVE_ACCOUNT_HAS_INSUFFICIENT_BALANCE: "39",

    INT256_ADDITION_OVERFLOW: "100",
    INT256_MULTIPLICATION_OVERFLOW: "101",
    INT256_DIVIDE_BY_ZERO: "102",
    INT256_NEGATE_MIN_INT: "103",

    UINT128_ADDITION_OVERFLOW: "104",
    UINT128_SUBTRACTION_UNDERFLOW: "105",
    UINT128_MULTIPLICATION_OVERFLOW: "106",
    UINT128_DIVIDE_BY_ZERO: "107",

    UINT256_ADDITION_OVERFLOW: "108",
    UINT256_SUBTRACTION_UNDERFLOW: "109",
    UINT256_MULTIPLICATION_OVERFLOW: "110",
    UINT256_DIVIDE_BY_ZERO: "111",
    UINT256_MODULO_BY_ZERO: "112",

    ABDK_INT256_OVERFLOW: "113",
    ABDK_UINT256_OVERFLOW: "114",
    ABDK_MULTIPLICATION_OVERFLOW: "115",
    ABDK_NEGATIVE_LOG: "116",

    ErrorCode: function(code: number) {
        const matches = Object.values(ErrorCodes).filter((v) => {
            if (typeof v === "string") {
                return v === code.toString();
            }
            return false;
        });

        if (matches.length === 0) {
            throw new Error(`Unknown error code value: ${code}`);
        }

        return `"${code}"`;
    }
};

export class ErrorDecoder {
    public static codeMap: Map<string, string>;

    private static reasonRegex = new RegExp("VM Exception while processing transaction: revert (?<code>.+)$");

    private static loadCodeMap() {
        this.codeMap = new Map<string, string>();
        for (const [key, val] of Object.entries(ErrorCodes)) {
            if (typeof val == "string") {
                this.codeMap.set(val, key);
            }
        }
    }

    public static decodeError(reason: any) {
        if (this.codeMap == null) {
            this.loadCodeMap();
        }

        reason = reason instanceof Object && "message" in reason ? reason.message : reason;
        let code = reason.toString().match(this.reasonRegex);
        if (code == null) {
            return reason;
        } else if (this.codeMap.has(code.groups.code)) {
            return this.codeMap.get(code.groups.code);
        } else {
            return reason;
        }
    }

    public static encodeError(errorCode: string) {
        return `VM Exception while processing transaction: revert ${errorCode}`;
    }
}
