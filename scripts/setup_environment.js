const Treasurer = artifacts.require("Treasurer")
const ERC20Mintable = artifacts.require("ERC20Mintable.sol")
const { timestamp } = require("../src/utilities.js")

const argv = require("yargs")
  .option("numAccounts", {
    describe: "Number of accounts to register with exchange",
    default: 3,
  })
  .option("daysToMaturity", {
    describe: "Time until maturity in days",
  })
  .help()
  .version(false).argv

module.exports = async function(callback) {
  try {
    const instance = await Treasurer.deployed()
    const collateralToken = await ERC20Mintable.at(await instance.collateralToken.call())
    const settlementToken = await ERC20Mintable.at(await instance.settlementToken.call())

    const accounts = await web3.eth.getAccounts()

    const amount = web3.utils.toWei("3000")

    // Create balance and approval for tokens normal accounts from mnemonic
    for (let account = 0; account < argv.numAccounts; account++) {
      await collateralToken.mint(accounts[account], amount)
      await settlementToken.mint(accounts[account], amount)
      await settlementToken.approve(instance.address, amount, { from: accounts[account] })
      await collateralToken.approve(instance.address, amount, { from: accounts[account] })
    }

    // Create balance for metaMask account:
    const metamaskAccounts = ["0x740a98f8f4fae0986fb3264fe4aacf94ac1ee96f"]
    for (let account = 0; account < 1; account++) {
      // fund with eth
      await web3.eth.sendTransaction({
        from: accounts[argv.numAccounts + 1],
        to: metamaskAccounts[account],
        value: 1000000000000000000,
      })
      // fund with tokens
      await collateralToken.mint(metamaskAccounts[account], amount)
      await settlementToken.mint(metamaskAccounts[account], amount)
    }

    // set initial price feed
    const Oracle = artifacts.require("Oracle")
    const oracle = await Oracle.deployed()
    await instance.setOracle(oracle.address)

    var rate = web3.utils.toWei(".007") // rate = Dai/ETH
    await oracle.set(rate)

    // create first yToken
    const daysToMaturity = argv.daysToMaturity || 30
    const maturityTime = (await timestamp("latest", web3)) + daysToMaturity * 60 * 60 * 24
    await instance.createNewYToken(maturityTime.toString())

    console.log("Environment setup complete")
    callback()
  } catch (error) {
    callback(error)
  }
}
