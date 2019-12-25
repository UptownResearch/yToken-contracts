const timestamp = (block = "latest", web3) => {
  return new Promise((resolve, reject) => {
    web3.eth.getBlock(block, false, (err, { timestamp }) => {
      if (err) {
        return reject(err)
      } else {
        resolve(timestamp)
      }
    })
  })
}

// Wait for n blocks to pass
const waitForNSeconds = async function(seconds, web3Provider = web3) {
  await send("evm_increaseTime", [seconds], web3Provider)
  await send("evm_mine", [], web3Provider)
}

const jsonrpc = "2.0"
const id = 0
const send = function(method, params, web3Provider) {
  return new Promise(function(resolve, reject) {
    web3Provider.currentProvider.send({ id, jsonrpc, method, params }, (error, result) => {
      if (error) {
        reject(error)
      } else {
        resolve(result)
      }
    })
  })
}

const waitUntilMaturity = async (instance, web3Provider = web3) => {
  const time_remaining = (await instance.maturityTime()) - (await timestamp("latest", web3Provider))
  if (time_remaining > 0) await waitForNSeconds(time_remaining + 1, web3Provider)
}

module.exports = {
  timestamp,
  waitForNSeconds,
  waitUntilMaturity,
}
