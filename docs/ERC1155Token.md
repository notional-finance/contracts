# ERC1155Token

Implements the ERC1155 token standard for transferring future cash tokens within Swapnet. ERC1155 ids
encode an identifier that represents assets that are fungible with each other. For example, two future cash tokens
that asset in the same market and mature on the same block are fungible with each other and therefore will have the
same id. `CASH_PAYER` tokens are not transferrable because they have negative value.


## Methods
- [`safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)`](#safeTransferFrom)
- [`safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] values, bytes data)`](#safeBatchTransferFrom)
- [`balanceOf(address account, uint256 id)`](#balanceOf)
- [`balanceOfBatch(address[] accounts, uint256[] ids)`](#balanceOfBatch)
- [`encodeAssetId(struct Common.Asset asset)`](#encodeAssetId)
- [`decodeAssetId(uint256 id)`](#decodeAssetId)
- [`setApprovalForAll(address operator, bool approved)`](#setApprovalForAll)
- [`isApprovedForAll(address owner, address operator)`](#isApprovedForAll)



# Methods
### `safeTransferFrom`
> Transfers tokens between from and to addresses.

#### Parameters:
- `from`: Source address

- `to`: Target address

- `id`: ID of the token type

- `value`: Transfer amount

- `data`: Additional data with no specified format, unused by this contract but forwarded unaltered
to the ERC1155TokenReceiver.

#### Error Codes:
- INVALID_ADDRESS: destination address cannot be 0
- INTEGER_OVERFLOW: value cannot overflow uint128
- CANNOT_TRANSFER_PAYER: cannot transfer assets that confer obligations
- CANNOT_TRANSFER_MATURED_ASSET: cannot transfer asset that has matured
- INSUFFICIENT_BALANCE: from account does not have sufficient tokens
- ERC1155_NOT_ACCEPTED: to contract must accept the transfer


***

### `safeBatchTransferFrom`
> Transfers tokens between from and to addresses in batch.

#### Parameters:
- `from`: Source address

- `to`: Target address

- `ids`: IDs of each token type (order and length must match _values array)

- `values`: Transfer amounts per token type (order and length must match _ids array)

- `data`: Additional data with no specified format, unused by this contract but forwarded unaltered
to the ERC1155TokenReceiver.

#### Error Codes:
- INVALID_ADDRESS: destination address cannot be 0
- INTEGER_OVERFLOW: value cannot overflow uint128
- CANNOT_TRANSFER_PAYER: cannot transfer assets that confer obligations
- CANNOT_TRANSFER_MATURED_ASSET: cannot transfer asset that has matured
- INSUFFICIENT_BALANCE: from account does not have sufficient tokens
- ERC1155_NOT_ACCEPTED: to contract must accept the transfer


***

### `balanceOf`
> Get the balance of an account's tokens. For a more complete picture of an account's
portfolio, see the method `Portfolios.getAssets()`

#### Parameters:
- `account`: The address of the token holder

- `id`: ID of the token

#### Return Values:
- The account's balance of the token type requested


***

### `balanceOfBatch`
> Get the balance of multiple account/token pairs. For a more complete picture of an account's
portfolio, see the method `Portfolios.getAssets()`

#### Parameters:
- `accounts`: The addresses of the token holders

- `ids`: ID of the tokens

#### Return Values:
- The account's balance of the token types requested (i.e. balance for each (owner, id) pair)


***

### `encodeAssetId`
> Encodes a asset object into a uint256 id for ERC1155 compatibility

#### Parameters:
- `asset`: the asset object to encode

#### Return Values:
- a uint256 id that is representative of a matching fungible token


***

### `decodeAssetId`
> Decodes an ERC1155 id into its attributes

#### Parameters:
- `id`: the asset id to decode



***

### `setApprovalForAll`
> Sets approval for an operator to transfer tokens on the sender's behalf

#### Parameters:
- `operator`: address of the operator

- `approved`: true for complete appoval, false otherwise


***

### `isApprovedForAll`
> Determines if the operator is approved for the owner's account

#### Parameters:
- `owner`: address of the token holder

- `operator`: address of the operator

#### Return Values:
- true for complete appoval, false otherwise


***



