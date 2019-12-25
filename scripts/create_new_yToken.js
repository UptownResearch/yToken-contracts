const Treasurer = artifacts.require("Treasurer")
const { timestamp } = require("../src/utilities.js")

const argv = require("yargs")
  .option("daysToMaturity", {
    describe: "Time until maturity in days",
  })
  .demand(["daysToMaturity"])
  .help(false)
  .version(false).argv

module.exports = async callback => {
  try {
    const maturityTime = (await timestamp("latest", web3)) + argv.daysToMaturity * 60 * 60 * 24
    const instance = await Treasurer.deployed()
    const account = (await web3.eth.getAccounts())[0]

    const receipt = await instance.createNewYToken(maturityTime.toString(), { from: account })
    console.log(`New yToken created. Series number is ${receipt.logs[0].args[0]}`)
    callback()
  } catch (error) {
    callback(error)
  }
}
