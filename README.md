## Testing on Kovan

We use Kovan for integration testing. The Notional contract addresses are found in [kovan.json](kovan.json) in this folder.

### Test Tokens

WETH can be acquired via the kovan faucet and deposited into the WETH contract. DAI and USDC tokens can be acquired by calling 

```
WETH=0xd0a1e359811322d97991e03f863a0c30c2cf029c
DAI=0x181D62Ff8C0aEeD5Bc2Bf77A88C07235c4cc6905
USDC=0xF503D5cd87d10Ce8172F9e77f76ADE8109037b4c
```

### Chainlink Oracles

These are the chainlink oracles on Kovan:

| Rate       | Address                                    | Default Rate | Decimals |
|------------|--------------------------------------------|--------------|---------:|
| DAI/ETH    | 0xC013D6Aa5b266F99fe6B282EE7732dB5Dd819628 | 0.01e18      | 18       |
| USDC/ETH   | 0xA2828eff43D61F6347eF95A72A58115CE56e3Ef3 | 0.01e6       | 6        |


## Rinkeby

```
Dai=0x181D62Ff8C0aEeD5Bc2Bf77A88C07235c4cc6905
USDC=0xF503D5cd87d10Ce8172F9e77f76ADE8109037b4c
DAI/ETH=0xC013D6Aa5b266F99fe6B282EE7732dB5Dd819628
USDC/ETH=0xA2828eff43D61F6347eF95A72A58115CE56e3Ef3
```
