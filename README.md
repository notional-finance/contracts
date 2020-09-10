## Testing on Kovan

We use Kovan for integration testing. The Notional contract addresses are found in [kovan.json](kovan.json) in this folder.

### Test Tokens

WETH can be acquired via the kovan faucet and deposited into the WETH contract. DAI and USDC tokens can be acquired by calling 

```
WETH=0xd0a1e359811322d97991e03f863a0c30c2cf029c
DAI=0x9b8B3C0b64bA1E301D221763C00df771514e4b34
USDC=0x95150F67d1C1628AB523D291CB2bC6baD80756ca
```

### Chainlink Oracles

These are the chainlink oracles on Kovan:

| Rate       | Address                                    | Default Rate | Decimals |
|------------|--------------------------------------------|--------------|---------:|
| DAI/ETH    | 0xc82c3ddF5B29c77c38a02D9987A2E329C905A861 | 0.01e18      | 18       |
| USDC/ETH   | 0x6e2591518CA9421bEE9BfeEd66772206D1c0E7CF | 0.01e6       | 6        |




