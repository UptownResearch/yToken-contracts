const getArgumentsHelper = function() {
  const args = process.argv.slice(4)
  const index = args.indexOf("--network")
  if (index > -1) {
    args.splice(index, 2)
  }
  return args
}

const invokeViewFunction = async function(contract, callback) {
  try {
    const args = getArgumentsHelper()
    if (args.length < 1) {
      callback("Error: This script requires arguments - <functionName> [..args]")
    }
    const [functionName, ...arg] = args

    const instance = await contract.deployed()
    const info = await instance[functionName].call(...arg)

    console.log(info)
    callback()
  } catch (error) {
    callback(error)
  }
}

module.exports = {
  invokeViewFunction,
}
