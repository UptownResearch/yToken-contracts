const Treasurer = artifacts.require("Treasurer")
const { invokeViewFunction } = require("./script_utilities.js")

module.exports = async callback => {
  await invokeViewFunction(Treasurer, callback)
}
