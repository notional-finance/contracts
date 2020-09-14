# ERC1155Token

Implements the ERC1155 token standard for transferring fCash tokens within Notional. ERC1155 ids
encode an identifier that represents assets that are fungible with each other. For example, two fCash tokens
that asset in the same market and mature at the same time are fungible with each other and therefore will have the
same id. `CASH_PAYER` tokens are not transferrable because they have negative value.


## Methods
- [`constructor(address directory)`](#constructor)
- [`safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)`](#safeTransferFrom)
- [`safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] values, bytes data)`](#safeBatchTransferFrom)



# Methods
### `constructor`
> No description


***

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



