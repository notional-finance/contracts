# Notional Finance

Notional is a fixed rate, fixed term lending and borrowing protocol on Ethereum. You can find us at https://notional.finance.

## Security

Our contracts have been audited by Open Zeppelin at this [commit hash](https://github.com/notional-finance/contracts/tree/b6fc6be4622422d0e34c90e77f2ec9da18596b8c). You can find their report at https://blog.openzeppelin.com/notional-audit/.

### Bug Bounty

The security of our contracts is our first and foremost priority. If you discover a vulnerability, please contact us at security@notional.finance. We will respond within 24 hours and keep you informed of our progress towards a fix. We will also compensate you for your report based on the severity of the issue.

## Developers

ABI and developer documentation can be found at: https://docs.notional.finance/developers/

- Setting up: `yarn`
- Build Contracts: `yarn run build`
- Test Contracts: `yarn run test`

ABIs can be found in the abi folder.


## Testing on Kovan

We use Kovan for integration testing. The Notional contract addresses are found in [kovan.json](kovan.json) in this folder. The user interface can be found at https://kovan.notional.finance.

### Test Tokens

WETH can be acquired via the kovan faucet and deposited into the WETH contract. DAI and USDC tokens can be acquired by calling the `mint()` method on the Dai and USDC contracts. You can also just find us in Discord and ask: https://discord.gg/62eX3K7

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


## Rinkeby Test Addresses

The Rinkeby user interface can be found at https://rinkeby.notional.finance

```
Dai=0x181D62Ff8C0aEeD5Bc2Bf77A88C07235c4cc6905
USDC=0xF503D5cd87d10Ce8172F9e77f76ADE8109037b4c
DAI/ETH=0x2bEb7f2041F43f3e31eBCc33b7020D9642d1692c
USDC/ETH=0xC9ec73e9369D20d13cA6B44587095A33B3B871Fd
```
