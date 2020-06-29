# ERC1155Token

Implements the ERC1155 token standard for transferring future cash tokens within Swapnet. ERC1155 ids
encode an identifier that represents trades that are fungible with each other. For example, two future cash tokens
that trade in the same market and mature on the same block are fungible with each other and therefore will have the
same id. `CASH_PAYER` tokens are not transferrable because they have negative value.


## Methods
- [`safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)`](#safeTransferFrom)
- [`safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] values, bytes data)`](#safeBatchTransferFrom)
- [`balanceOf(address account, uint256 id)`](#balanceOf)
- [`balanceOfBatch(address[] accounts, uint256[] ids)`](#balanceOfBatch)
- [`encodeTradeId(struct Common.Trade trade)`](#encodeTradeId)
- [`decodeTradeId(uint256 id)`](#decodeTradeId)
- [`setApprovalForAll(address operator, bool approved)`](#setApprovalForAll)
- [`isApprovedForAll(address owner, address operator)`](#isApprovedForAll)


## Governance Methods

# Methods
### safeTransferFrom
> Transfers tokens between from and to addresses.

#### Parameters:
- `from`: Source address

- `to`: Target address

- `id`: ID of the token type

- `value`: Transfer amount

- `data`: Additional data with no specified format, unused by this contract but forwarded unaltered
to the ERC1155TokenReceiver.

***

### safeBatchTransferFrom
> Transfers tokens between from and to addresses in batch.

#### Parameters:
- `from`: Source address

- `to`: Target address

- `ids`: IDs of each token type (order and length must match _values array)

- `values`: Transfer amounts per token type (order and length must match _ids array)

- `data`: Additional data with no specified format, unused by this contract but forwarded unaltered
to the ERC1155TokenReceiver.

***

### balanceOf
> Get the balance of an account's tokens. For a more complete picture of an account's
portfolio, see the method `Portfolios.getTrades()`

#### Parameters:
- `account`: The address of the token holder

- `id`: ID of the token

#### Return Values:
- The account's balance of the token type requested

***

### balanceOfBatch
> Get the balance of multiple account/token pairs. For a more complete picture of an account's
portfolio, see the method `Portfolios.getTrades()`

#### Parameters:
- `accounts`: The addresses of the token holders

- `ids`: ID of the tokens

#### Return Values:
- The account's balance of the token types requested (i.e. balance for each (owner, id) pair)

***

### encodeTradeId
> Encodes a trade object into a uint256 id for ERC1155 compatibility

#### Parameters:
- `trade`: the trade object to encode

#### Return Values:
- a uint256 id that is representative of a matching fungible token

***

### decodeTradeId
> Decodes an ERC1155 id into its attributes

#### Parameters:
- `id`: the trade id to decode


***

### setApprovalForAll
> Sets approval for an operator to transfer tokens on the sender's behalf

#### Parameters:
- `operator`: address of the operator

- `approved`: true for complete appoval, false otherwise

***

### isApprovedForAll
> Determines if the operator is approved for the owner's account

#### Parameters:
- `owner`: address of the token holder

- `operator`: address of the operator

#### Return Values:
- true for complete appoval, false otherwise

***


# Events

# Governance Methods
