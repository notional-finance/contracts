module.exports = {
  providerOptions: {
    gasLimit: 20000000,
    allowUnlimitedContractSize: true,
    mnemonic:
      "myth like bonus scare over problem client lizard pioneer submit female collect",
    default_balance_ether: 150000
  },
  skipFiles: [
    'interface',
    'lib/ERC20.sol',
    'upgradeable',
    'lib/ERC1155MockReceiver.sol',
    'storage'
  ]
};
