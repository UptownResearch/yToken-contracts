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
      await truffleAssert.reverts(TreasurerInstance.setOracle(accounts[5]), "Oracle was already set")
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
        "More collateral is required to issue yToken"
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
        "transferFrom for collateralToken failed when issuing new YTokens"
      )
    })
    it("should fail, if series does not exist", async () => {
      // create another yToken series with a 24 hour period until maturity
      await truffleAssert.reverts(
        TreasurerInstance.issueYToken(0, web3.utils.toWei("1"), web3.utils.toWei("1"), { from: accounts[1] }),
        "Attempted to issue YTokens of a non-existant series"
      )
    })
    it("should fail to issueYToken new yTokens, if series has passed its maturity time", async () => {
      // create another yToken series with a 24 hour period until maturity
      var currentTimeStamp = await timestamp("latest", web3)
      var series = 0
      var era = currentTimeStamp + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)
      await helper.advanceTimeAndBlock(SECONDS_IN_DAY * 1.5)

      // issueYToken new yTokens
      await truffleAssert.reverts(
        TreasurerInstance.issueYToken(series, web3.utils.toWei("1"), web3.utils.toWei("1"), { from: accounts[1] }),
        "Cannot issue tokens after maturity"
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
        "Cannot redeem debt after yToken has matured"
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
        "Cannot redeem more debt than is present"
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
        "Cannot release more collateral than locked"
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
        "New collateralization ratio is not sufficient"
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
        "Insufficient yToken balance for desired redemption"
      )
    })
    it("should fail, if series does not exists", async () => {
      await truffleAssert.reverts(
        TreasurerInstance.redeemDebtByProvidingYTokens(0, web3.utils.toWei("10"), web3.utils.toWei(".0001"), {
          from: accounts[1],
        }),
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
        "Provided address is sufficiently collateralized for that series"
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
        "Transfer of settlementToken failed"
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
        "Cannot liquidate repo of an unissued series"
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
      yToken = await YToken.at(await TreasurerInstance.yTokens.call(series))
      assert.equal(await yToken.balanceOf.call(accounts[2]), web3.utils.toWei("75"))

      const transferFunctionality = erc20.contract.methods.transfer(accounts[2], web3.utils.toWei("25")).encodeABI()
      assert.equal(1, await settlementToken.invocationCountForCalldata.call(transferFunctionality))
    })
    it("should allow token holder to claimFaceValue face value, even if series is already settled", async () => {
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

      await TreasurerInstance.settleDebtIntoDAIVault(series)

      const result = await TreasurerInstance.claimFaceValue(series, web3.utils.toWei("25"), accounts[2])
      yToken = await YToken.at(await TreasurerInstance.yTokens.call(series))
      assert.equal(await yToken.balanceOf.call(accounts[2]), web3.utils.toWei("75"))

      const transferFunctionality = erc20.contract.methods.transfer(accounts[2], web3.utils.toWei("25")).encodeABI()
      assert.equal(1, await settlementToken.invocationCountForCalldata.call(transferFunctionality))
    })
    it("can not claim more than yTokens owned", async () => {
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

      const result = await TreasurerInstance.claimFaceValue(series, web3.utils.toWei("125"), accounts[2])

      const transferFunctionality = erc20.contract.methods.transfer(accounts[2], web3.utils.toWei("100")).encodeABI()
      assert.equal(1, await settlementToken.invocationCountForCalldata.call(transferFunctionality))
    })
    it("should fail, if series had not been created", async () => {
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

      await truffleAssert.reverts(
        TreasurerInstance.claimFaceValue(series + 2, web3.utils.toWei("25"), accounts[2]),
        "Cannot claim face value of unissued series"
      )
    })
    it("should fail, if maturity time is not yet over", async () => {
      var series = 0
      var era = (await timestamp("latest", web3)) + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      // set up oracle
      const oracle = await Oracle.new()
      var rate = web3.utils.toWei(".01") // rate = Dai/ETH
      await OracleMock.givenAnyReturnUint(rate) // should price ETH at $100 * ONE

      // issueYToken new yTokens with new account
      await TreasurerInstance.issueYToken(series, web3.utils.toWei("100"), web3.utils.toWei("1.5"), { from: accounts[2] })

      await truffleAssert.reverts(
        TreasurerInstance.claimFaceValue(series, web3.utils.toWei("25"), accounts[2]),
        "Cannot claim face value of token yet to mature"
      )
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

      assert.equal(await TreasurerInstance.settled(series), false)

      //run settleDebtIntoDAIVault
      await TreasurerInstance.settleDebtIntoDAIVault(series, { from: accounts[2] })

      assert.equal(await TreasurerInstance.settlementTokenFund.call(series), web3.utils.toWei("100"))
      assert.equal(await TreasurerInstance.settled(series), true)
    })
    it("should fail, if maturity date has not yet passed", async () => {
      var series = 0
      var era = (await timestamp("latest", web3)) + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      //run settleDebtIntoDAIVault
      await truffleAssert.reverts(
        TreasurerInstance.settleDebtIntoDAIVault(series, { from: accounts[2] }),
        "Cannot trigger settlement before maturity"
      )
    })
    it("should fail, if series does not exists", async () => {
      var series = 0
      var era = (await timestamp("latest", web3)) + SECONDS_IN_DAY
      await TreasurerInstance.createNewYToken(era)

      //run settleDebtIntoDAIVault
      await truffleAssert.reverts(
        TreasurerInstance.settleDebtIntoDAIVault(series + 5, { from: accounts[2] }),
        "Cannot trigger settlement of an unissued series"
      )
    })
    it("should not be allowed to be called twice", async () => {
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

      assert.equal(await TreasurerInstance.settled(series), false)

      //run settleDebtIntoDAIVault
      await TreasurerInstance.settleDebtIntoDAIVault(series, { from: accounts[2] })
      await truffleAssert.reverts(
        TreasurerInstance.settleDebtIntoDAIVault(series, { from: accounts[2] }),
        "Series was previously settled"
      )
    })
  })
  describe("reduceDebt()", () => {
    it("should allow debtor to reduce their debt by providing settlementTokens", async () => {
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

      await TreasurerInstance.reduceDebt(series, web3.utils.toWei("50"), { from: accounts[2] })
      assert.equal(await TreasurerInstance.settlementTokenFund.call(series), web3.utils.toWei("50"))

      var result = await TreasurerInstance.repos(series, accounts[2])
      assert.equal(result[1].toString(), web3.utils.toWei("50"))
    })
    it("should fail, if payback is bigger than debt", async () => {
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

      await truffleAssert.reverts(
        TreasurerInstance.reduceDebt(series, web3.utils.toWei("150"), { from: accounts[2] }),
        "Cannot reduce debt by amount greater than series debt"
      )
    })
    it("should fail, if series does not exist", async () => {
      var series = 0
      await truffleAssert.reverts(
        TreasurerInstance.reduceDebt(series, web3.utils.toWei("50"), { from: accounts[2] }),
        "Cannot reduce debt of unissued series"
      )
    })
    it("should fail, if settlementToken transfer fails", async () => {
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

      await settlementToken.givenAnyReturnBool(false)
      await truffleAssert.reverts(
        TreasurerInstance.reduceDebt(series, web3.utils.toWei("50"), { from: accounts[2] }),
        "SettlementToken transfer failed when reducing debt"
      )
    })
  })
})
