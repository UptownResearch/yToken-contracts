const Treasurer = artifacts.require("./Treasurer")
const YToken = artifacts.require("./yToken")
const MockContract = artifacts.require("./MockContract")
const Oracle = artifacts.require("./Oracle")
const ERC20 = artifacts.require("ERC20")

const truffleAssert = require("truffle-assertions")
const helper = require("ganache-time-traveler")
const { timestamp } = require("./../src/utilities")
var OracleMock = null
const SECONDS_IN_DAY = 86400

contract("Treasurer", async accounts => {
  const collateralRatio = web3.utils.toWei("1.5")
  const minCollateralRatio = web3.utils.toWei("1.05")
  let TreasurerInstance
  let collateralToken
  let erc20
  beforeEach("deploy and setup", async () => {
    erc20 = await ERC20.new()
    collateralToken = await MockContract.new()
    await collateralToken.givenAnyReturnBool(true)
    settlementToken = await MockContract.new()
    await settlementToken.givenAnyReturnBool(true)
    TreasurerInstance = await Treasurer.new(
      collateralToken.address,
      settlementToken.address,
      collateralRatio,
      minCollateralRatio
    )
    OracleMock = await MockContract.new()
    await TreasurerInstance.setOracle(OracleMock.address)
  })
  describe("createNewYToken()", () => {
    it("should refuse to issue a new yToken with old maturity date", async () => {
      var number = await web3.eth.getBlockNumber()
      var currentTimeStamp = (await web3.eth.getBlock(number)).timestamp
      currentTimeStamp = currentTimeStamp - 1
      await truffleAssert.fails(TreasurerInstance.createNewYToken(currentTimeStamp), truffleAssert.REVERT)
    })

    it("should issue a new yToken", async () => {
      var number = await web3.eth.getBlockNumber()
      var currentTimeStamp = (await web3.eth.getBlock(number)).timestamp
      var era = currentTimeStamp + SECONDS_IN_DAY
      let series = await TreasurerInstance.createNewYToken.call(era.toString())
      await TreasurerInstance.createNewYToken(era.toString())
      let address = await TreasurerInstance.yTokens(series)
      var yTokenInstance = await YToken.at(address)
      assert.equal(await yTokenInstance.maturityTime(), era, "New yToken has incorrect era")
    })
  })
  describe("topUpCollateral()", () => {
    it("should accept collateral", async () => {
      await TreasurerInstance.topUpCollateral(web3.utils.toWei("1"), 0, {
        from: accounts[1],
      })
      var result = await TreasurerInstance.repos(0, accounts[1])
      assert.equal(result[0].toString(), web3.utils.toWei("1"), "Did not accept collateral")
    })
    it("fail if collateral transfer fails ", async () => {
      await collateralToken.givenAnyReturnBool(false)

      await truffleAssert.reverts(
        TreasurerInstance.topUpCollateral(web3.utils.toWei("1"), 0, {
          from: accounts[1],
        }),
        "Collateral transfer failed"
      )
    })
  })
  describe("withdrawCollateral()", () => {
    it("should return collateral", async () => {
      await TreasurerInstance.topUpCollateral(web3.utils.toWei("1"), 0, {
        from: accounts[1],
      })
      // set up oracle
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      await TreasurerInstance.withdrawCollateral(web3.utils.toWei("1"), 0, {
        from: accounts[1],
      })
      const transferFunctionality = erc20.contract.methods.transfer(accounts[1], web3.utils.toWei("1")).encodeABI()
      assert.equal(1, await collateralToken.invocationCountForCalldata.call(transferFunctionality))
    })
    it("should fail, if collateral is not sufficient", async () => {
      var currentTimeStamp = await timestamp("latest", web3)
      var era = currentTimeStamp + SECONDS_IN_DAY
      let series = await TreasurerInstance.createNewYToken.call(era.toString())
      await TreasurerInstance.createNewYToken(era.toString())
      // set up oracle
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens, this deposits collateral
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("10"), web3.utils.toWei("1"), { from: accounts[1] })

      await truffleAssert.reverts(
        TreasurerInstance.withdrawCollateral(web3.utils.toWei("1"), series, {
          from: accounts[1],
        }),
        "collateral amount would not be sufficient after withdraw"
      )
    })
  })
  describe("setOracle()", () => {
    it("should set Oracle address", async () => {
      const treasurer = await Treasurer.new(
        collateralToken.address,
        settlementToken.address,
        collateralRatio,
        minCollateralRatio
      )
      await treasurer.setOracle(accounts[5])
      const _address = await treasurer.oracle()
      assert.equal(_address, accounts[5])
    })
    it("should fail, if setOracle is not called by owner", async () => {
      const treasurer = await Treasurer.new(
        collateralToken.address,
        settlementToken.address,
        collateralRatio,
        minCollateralRatio
      )
      await truffleAssert.reverts(treasurer.setOracle(accounts[5], { from: accounts[3] }), "Ownable: caller is not the owner")
    })
    it("should fail, if oracle was already set once", async () => {
      await truffleAssert.reverts(TreasurerInstance.setOracle(accounts[5]), "oracle was already set")
    })
  })
  describe("oracle()", () => {
    it("should provide Oracle address", async () => {
      const _address = await TreasurerInstance.oracle()
      assert.equal(_address, OracleMock.address)
    })
  })
  describe("issueYToken()", () => {
    it("should issueYToken new yTokens", async () => {
      // create another yToken series with a 24 hour period until maturity
      var currentTimeStamp = await timestamp("latest", web3)
      var series = 0
      var era = currentTimeStamp + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("1"), web3.utils.toWei("1"), { from: accounts[1] })

      // check yToken balance
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)
      const balance = await yTokenInstance.balanceOf(accounts[1])
      assert.equal(balance.toString(), web3.utils.toWei("1"), "Did not issueYToken new yTokens")

      //check unlocked collateral, lockedCollateralAmount collateral
      const repo = await TreasurerInstance.repos(series, accounts[1])
      assert.equal(repo.lockedCollateralAmount.toString(), web3.utils.toWei("1"), "Did not lock collateral")
      assert.equal(repo.debtAmount.toString(), web3.utils.toWei("1"), "Did not create debtAmount")
    })
    it("should fail to issueYToken new yTokens, if collateral is not sufficient", async () => {
      // create another yToken series with a 24 hour period until maturity
      var currentTimeStamp = await timestamp("latest", web3)
      var series = 0
      var era = currentTimeStamp + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      var rate = web3.utils.toWei("1") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens
      await truffleAssert.reverts(
        TreasurerInstance.issueYToken(series, web3.utils.toWei("10"), web3.utils.toWei("1"), { from: accounts[1] }),
        "more collateral is required to issue yToken"
      )
    })
    it("should fail to issueYToken new yTokens, if collateral transfer fails", async () => {
      // create another yToken series with a 24 hour period until maturity
      var currentTimeStamp = await timestamp("latest", web3)
      var series = 0
      var era = currentTimeStamp + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      await collateralToken.givenAnyReturnBool(false)

      // issueYToken new yTokens
      await truffleAssert.reverts(
        TreasurerInstance.issueYToken(series, web3.utils.toWei("1"), web3.utils.toWei("1"), { from: accounts[1] }),
        "transferFrom for collateralToken failed"
      )
    })
  })
  describe("redeemDebtByProvidingYTokens()", () => {
    it("should accept tokens to redeemDebtByProvidingYTokens yToken debt", async () => {
      var amountToWipe = web3.utils.toWei(".1")
      var currentTimeStamp = await timestamp("latest", web3)
      var series = 0
      var era = currentTimeStamp + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      const oracle = await Oracle.new()
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("1"), web3.utils.toWei("1"), { from: accounts[1] })

      // get access to token
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)

      //authorize the redeemDebtByProvidingYTokens
      await yTokenInstance.approve(TreasurerInstance.address, amountToWipe, {
        from: accounts[1],
      })
      // redeemDebtByProvidingYTokens tokens
      await TreasurerInstance.redeemDebtByProvidingYTokens(series, amountToWipe, web3.utils.toWei(".1"), {
        from: accounts[1],
      })

      // check yToken balance
      const balance = await yTokenInstance.balanceOf(accounts[1])
      assert.equal(balance.toString(), web3.utils.toWei(".9"), "Did not redeemDebtByProvidingYTokens yTokens")

      //check unlocked collateral, lockedCollateralAmount collateral
      const repo = await TreasurerInstance.repos(series, accounts[1])
      assert.equal(repo.lockedCollateralAmount.toString(), web3.utils.toWei(".9"), "Did not unlock collateral")
      assert.equal(repo.debtAmount.toString(), web3.utils.toWei(".9"), "Did not redeemDebtByProvidingYTokens debg")
    })
    it("should fail, if maturity date is passed", async () => {
      var amountToWipe = web3.utils.toWei(".1")
      var currentTimeStamp = await timestamp("latest", web3)
      var series = 0
      var era = currentTimeStamp + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      const oracle = await Oracle.new()
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("1"), web3.utils.toWei("1"), { from: accounts[1] })

      // get access to token
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)

      //authorize the redeemDebtByProvidingYTokens
      await yTokenInstance.approve(TreasurerInstance.address, amountToWipe, {
        from: accounts[1],
      })
      await helper.advanceTimeAndBlock(SECONDS_IN_DAY * 1.5)

      // redeemDebtByProvidingYTokens tokens
      await truffleAssert.reverts(
        TreasurerInstance.redeemDebtByProvidingYTokens(series, amountToWipe, web3.utils.toWei(".1"), {
          from: accounts[1],
        }),
        "treasurer-wipe-yToken-has-matured"
      )
    })
    it("should fail, if more bonds are supposed to redeem that owned", async () => {
      var amountToWipe = web3.utils.toWei("1.5")
      var currentTimeStamp = await timestamp("latest", web3)
      var series = 0
      var era = currentTimeStamp + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      const oracle = await Oracle.new()
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("1"), web3.utils.toWei("1"), { from: accounts[1] })

      // get access to token
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)

      //authorize the redeemDebtByProvidingYTokens
      await yTokenInstance.approve(TreasurerInstance.address, amountToWipe, {
        from: accounts[1],
      })
      amountToWipe = web3.utils.toWei("1.5")

      // redeemDebtByProvidingYTokens tokens
      await truffleAssert.reverts(
        TreasurerInstance.redeemDebtByProvidingYTokens(series, amountToWipe, web3.utils.toWei(".1"), {
          from: accounts[1],
        }),
        "treasurer-wipe-wipe-more-debtAmount-than-present"
      )
    })
    it("should fail, if more debt is supposed to be freed that owned", async () => {
      var amountToWipe = web3.utils.toWei("1.5")
      var currentTimeStamp = await timestamp("latest", web3)
      var series = 0
      var era = currentTimeStamp + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      const oracle = await Oracle.new()
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("1"), web3.utils.toWei("1"), { from: accounts[1] })

      // get access to token
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)

      //authorize the redeemDebtByProvidingYTokens
      await yTokenInstance.approve(TreasurerInstance.address, amountToWipe, {
        from: accounts[1],
      })
      // redeemDebtByProvidingYTokens tokens
      await truffleAssert.reverts(
        TreasurerInstance.redeemDebtByProvidingYTokens(series, amountToWipe, web3.utils.toWei("1.1"), {
          from: accounts[1],
        }),
        "treasurer-wipe-release-more-than-locked"
      )
    })

    it("should fail, if too much collateral is to be released and hence left over debt is not covered", async () => {
      var amountToWipe = web3.utils.toWei("1.5")
      var currentTimeStamp = await timestamp("latest", web3)
      var series = 0
      var era = currentTimeStamp + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      const oracle = await Oracle.new()
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("50"), web3.utils.toWei("1"), { from: accounts[1] })

      // get access to token
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)

      //authorize the redeemDebtByProvidingYTokens
      await yTokenInstance.approve(TreasurerInstance.address, amountToWipe, {
        from: accounts[1],
      })
      // redeemDebtByProvidingYTokens tokens
      await truffleAssert.reverts(
        TreasurerInstance.redeemDebtByProvidingYTokens(series, amountToWipe, web3.utils.toWei("0.6"), {
          from: accounts[1],
        }),
        "new collateralization ratio is not sufficient"
      )
    })
    it("should fail, if not sufficient yTokens are owned", async () => {
      var amountToWipe = web3.utils.toWei(".1")
      var currentTimeStamp = await timestamp("latest", web3)
      var series = 0
      var era = currentTimeStamp + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      const oracle = await Oracle.new()
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("66"), web3.utils.toWei("1"), { from: accounts[1] })

      // get access to token
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)

      //authorize the redeemDebtByProvidingYTokens
      await yTokenInstance.transfer(accounts[4], web3.utils.toWei("60"), {
        from: accounts[1],
      })

      // redeemDebtByProvidingYTokens tokens
      await truffleAssert.reverts(
        TreasurerInstance.redeemDebtByProvidingYTokens(series, web3.utils.toWei("10"), web3.utils.toWei(".0001"), {
          from: accounts[1],
        }),
        "treasurer-wipe-insufficient-token-balance"
      )
    })
  })
  describe("liquidate()", () => {
    it("should accept liquidations undercollateralized repos", async () => {
      var series = 0
      var era = (await timestamp("latest", web3)) + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens with new account
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("100"), web3.utils.toWei("1.5"), { from: accounts[2] })

      // transfer tokens to another account
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)
      await yTokenInstance.transfer(accounts[3], web3.utils.toWei("100"), {
        from: accounts[2],
      })

      //change rate to issueYToken tokens undercollateralized
      rate = web3.utils.toWei(".02") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate)

      // attempt to liquidate
      const result = await TreasurerInstance.liquidate(series, accounts[2], web3.utils.toWei("50"), { from: accounts[3] })

      //check received 1.05
      const transferFunctionality = erc20.contract.methods.transfer(accounts[3], web3.utils.toWei("1.05")).encodeABI()
      assert.equal(1, await collateralToken.invocationCountForCalldata.call(transferFunctionality))

      //check unlocked collateral, lockedCollateralAmount collateral
      const repo = await TreasurerInstance.repos(series, accounts[2])
      assert.equal(repo.lockedCollateralAmount.toString(), web3.utils.toWei("0.45"), "Did not unlock collateral")
      assert.equal(repo.debtAmount.toString(), web3.utils.toWei("50"), "Did not redeemDebtByProvidingYTokens debg")
    })
    it("should fail liquidations well-collateralized repos", async () => {
      var series = 0
      var era = (await timestamp("latest", web3)) + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens with new account
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("100"), web3.utils.toWei("1.5"), { from: accounts[2] })

      // transfer tokens to another account
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)
      await yTokenInstance.transfer(accounts[3], web3.utils.toWei("100"), {
        from: accounts[2],
      })

      // attempt to liquidate
      await truffleAssert.reverts(
        TreasurerInstance.liquidate(series, accounts[2], web3.utils.toWei("50"), { from: accounts[3] }),
        "series of bum is sufficiently collateralized"
      )
    })
    it("should fail liquidations if settlementTokens are not provided", async () => {
      var series = 0
      var era = (await timestamp("latest", web3)) + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens with new account
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("100"), web3.utils.toWei("1.5"), { from: accounts[2] })

      // transfer tokens to another account
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)
      await yTokenInstance.transfer(accounts[3], web3.utils.toWei("100"), {
        from: accounts[2],
      })

      //change rate to issueYToken tokens undercollateralized
      rate = web3.utils.toWei(".02") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate)

      await settlementToken.givenAnyReturnBool(false)

      // attempt to liquidate
      await truffleAssert.reverts(
        TreasurerInstance.liquidate(series, accounts[2], web3.utils.toWei("50"), { from: accounts[3] }),
        "transfer of settlementToken failed"
      )
    })
    it("should fail liquidations non-initialized repos", async () => {
      var series = 0
      var era = (await timestamp("latest", web3)) + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens with new account
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("100"), web3.utils.toWei("1.5"), { from: accounts[2] })

      // transfer tokens to another account
      const token = await TreasurerInstance.yTokens.call(series)
      const yTokenInstance = await YToken.at(token)
      await yTokenInstance.transfer(accounts[3], web3.utils.toWei("100"), {
        from: accounts[2],
      })

      // attempt to liquidate
      await truffleAssert.reverts(
        TreasurerInstance.liquidate(series + 1, accounts[2], web3.utils.toWei("50"), { from: accounts[3] }),
        "treasurer-liquidate-unissued-series"
      )
    })
  })
  describe("claimFaceValue()", () => {
    it("should allow token holder to claimFaceValue face value", async () => {
      var series = 0
      var era = (await timestamp("latest", web3)) + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      const oracle = await Oracle.new()
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens with new account
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("100"), web3.utils.toWei("1.5"), { from: accounts[2] })
      await helper.advanceTimeAndBlock(SECONDS_IN_DAY * 1.5)

      const result = await TreasurerInstance.claimFaceValue(series, web3.utils.toWei("25"), accounts[2])

      const transferFunctionality = erc20.contract.methods.transfer(accounts[2], web3.utils.toWei("25")).encodeABI()
      assert.equal(1, await settlementToken.invocationCountForCalldata.call(transferFunctionality))
    })
  })
  describe("settleDebtIntoDAIVault()", () => {
    it("should allow repo holder to settleDebtIntoDAIVault repo and receive remaining collateral", async () => {
      var series = 0
      var era = (await timestamp("latest", web3)) + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      //fund account
      await TreasurerInstance.topUpCollateral(web3.utils.toWei("1.5"), series, {
        from: accounts[2],
      })
      // issueYToken new yTokens with new account
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("100"), web3.utils.toWei("1.5"), { from: accounts[2] })
      await helper.advanceTimeAndBlock(SECONDS_IN_DAY * 1.5)

      //run settleDebtIntoDAIVault
      await TreasurerInstance.settleDebtIntoDAIVault(series, { from: accounts[2] })
    })
  })
})
