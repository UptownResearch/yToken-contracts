module.exports = {
  copyPackages: ["openzeppelin-solidity", "@gnosis.pm"],
  skipFiles: [
    "imports/Imports.sol",
    "interfaces/UniswapExchangeInterface.sol",
    "libraries/ExponentialOperations.sol",
    "oracle/Oracle.sol",
    "test-contracts/*",
  ],
}
