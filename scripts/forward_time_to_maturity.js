const { waitUntilMaturity } = require("../src/utilities.js")
const argv = require("yargs")
  .option("series", {
    describe: "series of yToken",
  })
  .demand(["series"])
  .help(false)
  .version(false).argv
module.exports = async callback => {
  try {
    const Treasurer = artifacts.require("Treasurer")
    const instance = await Treasurer.deployed()
    const YToken = artifacts.require("yToken")

    const yToken = await YToken.at(await instance.yTokens.call(argv.series))
    await waitUntilMaturity(yToken, web3)
    console.log("Time forwarded to maturity date")
    callback()
  } catch (error) {
    callback(error)
  }
}
