const YToken = artifacts.require("./yToken")

const truffleAssert = require("truffle-assertions")
const helper = require("ganache-time-traveler")

contract("yToken", async accounts => {
  const [user_1, owner] = accounts

  let YTokenInstance
  var maturityTime = 60 * 60 * 24 * 30
  beforeEach("deploying", async () => {
    var currentTimeStamp = (await web3.eth.getBlock("latest")).timestamp
    YTokenInstance = await YToken.new(maturityTime + currentTimeStamp, { from: owner })
  })
  describe("burnByOwner()", () => {
    it("issues new yTokens and then burns them", async () => {
      await YTokenInstance.mint(user_1, 10, { from: owner })
      await YTokenInstance.burnByOwner(user_1, 10, { from: owner })
    })
    it("fails to burn tokens, if the account does not have them", async () => {
      await YTokenInstance.mint(user_1, 5, { from: owner })
      await truffleAssert.reverts(YTokenInstance.burnByOwner(user_1, 10, { from: owner }), "SafeMath: subtraction overflow")
    })
    it("fails to burn tokens, if tx is not initiated by owner", async () => {
      await YTokenInstance.mint(user_1, 10, { from: owner })
      await truffleAssert.reverts(
        YTokenInstance.burnByOwner(user_1, 10, { from: user_1 }),
        "caller does not have the Minter role"
      )
    })
  })
})
