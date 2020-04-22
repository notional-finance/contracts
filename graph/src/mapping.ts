import {
    TransferEth,
    TransferDai,
    TransferAsset,
    UpdateCashBalance,
    SettleCash,
    FutureCash,
    FutureCash__getAccountTradesResultValue0Struct,
    CreateAsset,
    AddLiquidity,
    RemoveLiquidity
} from "../generated/FutureCash/FutureCash";
import {Asset, Account, Transaction} from "../generated/schema";
import {BigInt, Address, log} from "@graphprotocol/graph-ts";

const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";
type AccountTrades = FutureCash__getAccountTradesResultValue0Struct;

export function handleTransferEth(event: TransferEth): void {
    let accountId = event.params.account.toHexString();
    let account = Account.load(accountId);
    if (account == null) {
        account = new Account(accountId);
        account.ethBalance = event.params.amount;
        account.daiBalance = BigInt.fromI32(0);
        account.cashBalance = BigInt.fromI32(0);
        account.portfolio = [];
        account.transactions = [];
    } else {
        // Just resync with the chain so that this is always accurate.
        account.ethBalance = FutureCash.bind(event.address).ethBalances(event.params.account);
    }

    log.debug("Updated eth balance in account {} to {}", [account.id, account.ethBalance.toString()]);
    account.save();
}

export function handleTransferDai(event: TransferDai): void {
    log.debug("Event Data {}, {}", [event.params.account.toHexString(), event.params.amount.toString()]);
    let accountId = event.params.account.toHexString();
    let account = Account.load(accountId);
    if (account == null) {
        account = new Account(accountId);
        account.daiBalance = event.params.amount;
        account.ethBalance = BigInt.fromI32(0);
        account.cashBalance = BigInt.fromI32(0);
        account.portfolio = [];
        account.transactions = [];
    } else {
        // Just resync with the chain so that this is always accurate.
        account.daiBalance = FutureCash.bind(event.address).daiBalances(event.params.account);
    }

    log.debug("Updated dai balance in account {} to {}", [account.id, account.daiBalance.toString()]);
    account.save();
}

function tradeTypeToString(tradeType: i32): string {
    if (tradeType == 1) return "CASH_PAYER";
    if (tradeType == 2) return "CASH_RECEIVER";
    if (tradeType == 3) return "LIQUIDITY_TOKEN";

    return "";
}

function updateAccountPortfolio(account: Account, futureCashAddress: Address): void {
    let accountAddress = Address.fromHexString(account.id) as Address;
    let data = FutureCash.bind(futureCashAddress).getAccountTrades(accountAddress);
    let assetIds: string[] = [];

    for (let i: i32; i < data.length; i++) {
        let id = account.id + ":" + data[i].maturity.toString() + ":" + tradeTypeToString(data[i].tradeType);

        let asset = Asset.load(id);
        if (asset == null) {
            // Create a new asset
            asset = new Asset(id);
            asset.tradeType = tradeTypeToString(data[i].tradeType);
            asset.maturity = data[i].maturity;
            asset.notional = data[i].notional;
        } else if (asset.maturity == data[i].maturity) {
            asset.notional = data[i].notional;
        }
        asset.save();

        assetIds.push(id);
    }
    // TODO: we should filter out the asset ids that are removed

    // When trades are made the dai balance of the account may change so we update that here
    account.daiBalance = FutureCash.bind(futureCashAddress).daiBalances(accountAddress);

    log.debug("Updated portfolio in account {} to {}", [account.id, account.portfolio.join(",")]);

    account.portfolio = assetIds;
    account.save();
}

function createAccount(accountId: string): Account {
    let account = Account.load(accountId);
    if (account == null) {
        account = new Account(accountId);
        account.daiBalance = BigInt.fromI32(0);
        account.ethBalance = BigInt.fromI32(0);
        account.cashBalance = BigInt.fromI32(0);
        account.portfolio = [];
        account.transactions = [];
    }

    return account as Account;
}

export function handleCreateAsset(event: CreateAsset): void {
    let transactionId = event.transaction.hash.toHexString();
    let transaction = new Transaction(transactionId);
    transaction.tradeType = tradeTypeToString(event.params.tradeType);
    transaction.maturity = event.params.maturity;
    transaction.futureCash = event.params.futureCash;
    transaction.daiAmount = event.params.daiAmount;
    transaction.save();

    let accountId = event.params.account.toHexString();
    let account = createAccount(accountId);

    let transactions = account.transactions;
    transactions.push(transactionId);
    account.transactions = transactions;

    updateAccountPortfolio(account as Account, event.address);
}

export function handleAddLiquidity(event: AddLiquidity): void {
    let transactionId = event.transaction.hash.toHexString();
    let transaction = new Transaction(transactionId);
    transaction.tradeType = "LIQUIDITY_TOKEN";
    transaction.maturity = event.params.maturity;
    transaction.futureCash = event.params.futureCash;
    transaction.daiAmount = event.params.daiAmount;
    transaction.tokens = event.params.tokens;
    transaction.save();

    let accountId = event.params.account.toHexString();
    let account = createAccount(accountId);

    let transactions = account.transactions;
    transactions.push(transactionId);
    account.transactions = transactions;

    updateAccountPortfolio(account as Account, event.address);
}

export function handleRemoveLiquidity(event: RemoveLiquidity): void {
    let transactionId = event.transaction.hash.toHexString();
    let transaction = new Transaction(transactionId);
    transaction.tradeType = "LIQUIDITY_TOKEN";
    transaction.maturity = event.params.maturity;
    transaction.futureCash = event.params.futureCash;
    transaction.daiAmount = event.params.daiAmount;
    transaction.tokens = event.params.tokens.times(new BigInt(-1));
    transaction.save();

    let accountId = event.params.account.toHexString();
    let account = createAccount(accountId);

    let transactions = account.transactions;
    transactions.push(transactionId);
    account.transactions = transactions;

    updateAccountPortfolio(account as Account, event.address);
}

export function handleTransferAsset(event: TransferAsset): void {
    let accountId = event.params.to.toHexString();
    let account = Account.load(accountId);
    if (account == null) {
        account = new Account(accountId);
        account.daiBalance = BigInt.fromI32(0);
        account.ethBalance = BigInt.fromI32(0);
        account.cashBalance = BigInt.fromI32(0);
        account.portfolio = [];
        account.transactions = [];
    }

    updateAccountPortfolio(account as Account, event.address);
    log.debug("From param is {}", [event.params.from.toHexString()]);

    if (event.params.from.toHexString() != ADDRESS_ZERO) {
        // The from address should already exist here otherwise it could not send
        // any sort of value.
        let from = Account.load(event.params.from.toHexString());
        if (from == null) {
            log.critical("Account {} could not be found!", [event.params.from.toHexString()]);
            return;
        }

        updateAccountPortfolio(from as Account, event.address);
    }
}

export function handleUpdateCashBalance(event: UpdateCashBalance): void {
    let account = Account.load(event.params.account.toHexString());
    if (account == null) {
        log.critical("Account {} could not be found!", [event.params.account.toHexString()]);
        return;
    }

    account.cashBalance = account.cashBalance.plus(event.params.amount);
    log.debug("Updated cashBalance in account {} to {}", [account.id, account.cashBalance.toString()]);

    updateAccountPortfolio(account as Account, event.address);
}

export function handleSettleCash(event: SettleCash): void {
    let from = Account.load(event.params.from.toHexString());
    if (from == null) {
        log.critical("Account {} could not be found!", [event.params.from.toHexString()]);
        return;
    }

    let to = Account.load(event.params.to.toHexString());
    if (to == null) {
        log.critical("Account {} could not be found!", [event.params.to.toHexString()]);
        return;
    }

    let fromAddress = Address.fromHexString(from.id) as Address;
    from.cashBalance = FutureCash.bind(event.address).daiCashBalances(fromAddress);
    from.daiBalance = FutureCash.bind(event.address).daiBalances(fromAddress);
    from.ethBalance = FutureCash.bind(event.address).ethBalances(fromAddress);
    updateAccountPortfolio(from as Account, event.address);
    log.debug("Settled cash in account {} to cashBalance: {}, daiBalance: {}, ethBalance: {}", [
        from.id,
        from.cashBalance.toString(),
        from.daiBalance.toString(),
        from.ethBalance.toString()
    ]);

    let toAddress = Address.fromHexString(to.id) as Address;
    to.cashBalance = FutureCash.bind(event.address).daiCashBalances(toAddress);
    to.daiBalance = FutureCash.bind(event.address).daiBalances(toAddress);
    to.ethBalance = FutureCash.bind(event.address).ethBalances(toAddress);
    updateAccountPortfolio(to as Account, event.address);
    log.debug("Settled cash in account {} to cashBalance: {}, daiBalance: {}, ethBalance: {}", [
        to.id,
        to.cashBalance.toString(),
        to.daiBalance.toString(),
        to.ethBalance.toString()
    ]);
}
