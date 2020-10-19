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
| DAI/ETH    | 0x39315F1990CA0E61C84169b29f88350aEfF5443e | 0.01e18      | 18       |
| USDC/ETH   | 0x7F27F5c26a16bcaC8BddAF1d79e1F66CB41b25C2 | 0.01e6       | 6        |


## Rinkeby

```
Dai=0x181D62Ff8C0aEeD5Bc2Bf77A88C07235c4cc6905
USDC=0xF503D5cd87d10Ce8172F9e77f76ADE8109037b4c
DAI/ETH=0x2bEb7f2041F43f3e31eBCc33b7020D9642d1692c
USDC/ETH=0xC9ec73e9369D20d13cA6B44587095A33B3B871Fd
```
