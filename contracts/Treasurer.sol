pragma solidity ^0.5.2;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/math/Math.sol";
import "openzeppelin-solidity/contracts/ownership/Ownable.sol";

import "./yToken.sol";
import "./oracle/Oracle.sol";
import "./libraries/ExponentialOperations.sol";

contract Treasurer is Ownable {
    using SafeMath for uint256;
    using ExponentialOperations for uint256;

    uint256 public constant LIQUIDATION_PAYOUT_PERCENTAGE = 5;
    // 5 percent is the additional reward paid in collateralToken
    // for liquidation calls

    struct Repo {
        uint256 lockedCollateralAmount;
        uint256 debtAmount;
    }

    event NewSeries(uint256 series, uint256 maturityTime);

    mapping(uint256 => yToken) public yTokens;
    mapping(uint256 => mapping(address => Repo)) public repos; // lockedCollateralAmount ETH and debtAmount
    mapping(uint256 => uint256) public totalCollateralAmountInSeries;
    mapping(uint256 => uint256) public totalDebtAmountInSeries;

    // This fund collects settlementTokens from upfront re-payments or liquidations
    mapping(uint256 => uint256) public settlementTokenFund; // This fund collects settlementTokens from upfront re-payments or liquidations
    mapping(uint256 => bool) public settled; // indicated whether a series was settled into the fault
    Oracle public oracle;
    uint256 public collateralRatio; // collateralization ratio
    uint256 public minCollateralRatio; // minimum collateralization ratio
    uint256 public totalSeries = 0;
    ERC20 public collateralToken;
    ERC20 public settlementToken;

    constructor(
        ERC20 _collateralToken,
        ERC20 _settlementToken,
        uint256 collateralRatio_,
        uint256 minCollateralRatio_
    ) public Ownable() {
        settlementToken = _settlementToken;
        collateralToken = _collateralToken;
        collateralRatio = collateralRatio_;
        minCollateralRatio = minCollateralRatio_;
    }

    // oracle_ - address of the oracle contract
    function setOracle(Oracle oracle_) public onlyOwner {
        require(address(oracle) == address(0), "Oracle was already set");
        oracle = oracle_;
    }

    // get oracle value
    function getSettlmentVSCollateralTokenRate()
        public
        view
        returns (uint256 r)
    {
        r = oracle.read();
    }

    function createNewYToken(uint256 maturityTime)
        public
        returns (uint256 series)
    {
        require(maturityTime > now, "New token maturity is in the past");
        series = totalSeries;
        yToken _token = new yToken(maturityTime);
        yTokens[series] = _token;
        totalSeries = totalSeries + 1;
        emit NewSeries(series, maturityTime);
    }

    function topUpCollateral(uint256 amountCollateral, uint256 series)
        public
        payable
    {
        require(
            collateralToken.transferFrom(
                msg.sender,
                address(this),
                amountCollateral
            ),
            "Collateral transfer failed"
        );
        addCollateralToRepo(series, msg.sender, amountCollateral);
    }

    // remove collateral from repo
    // amount - amount of ETH to remove from repo
    function withdrawCollateral(uint256 amount, uint256 series) public {
        reduceCollateralOfRepo(series, msg.sender, amount);
        require(
            checkCollateralSufficiency(series, msg.sender),
            "collateral amount would not be sufficient after withdraw"
        );

        collateralToken.transfer(msg.sender, amount);
    }

    // issueYToken: issue new yTokens
    // series - yToken to issue
    // yTokenAmount   - amount of yToken to issue
    // collateralAmountToLock   - amount of collateral to lock up
    function issueYToken(
        uint256 series,
        uint256 yTokenAmount,
        uint256 collateralAmountToLock
    ) public {
        require(series < totalSeries, "Attempted to issue YTokens of a non-existant series");
        require(
            yTokens[series].maturityTime() > now,
            "Cannot issue tokens after maturity"
        );
        require(
            collateralToken.transferFrom(
                msg.sender,
                address(this),
                collateralAmountToLock
            ),
            "transferFrom for collateralToken failed when issuing new YTokens"
        );
        addCollateralToRepo(series, msg.sender, collateralAmountToLock);
        addDebtToRepo(series, msg.sender, yTokenAmount);

        require(
            checkCollateralSufficiency(series, msg.sender),
            "More collateral is required to issue yToken"
        );
        // mint new yTokens
        yTokens[series].mint(msg.sender, yTokenAmount);
    }

    // series - yToken  series
    // credit   - amount of yToken to wipe
    function reduceDebt(uint256 series, uint256 credit)
        public
        returns (bool, uint256)
    {
        require(series < totalSeries, "Cannot reduce debt of unissued series");
        require(
            repos[series][msg.sender].debtAmount >= credit,
            "Cannot reduce debt by amount greater than series debt"
        );
        // we assume that the face value == 10**18
        require(
            settlementToken.transferFrom(msg.sender, address(this), credit),
            "SettlementToken transfer failed when reducing debt"
        );
        settlementTokenFund[series] = settlementTokenFund[series].add(credit);
        reduceDebtOfRepo(series, msg.sender, credit);
    }

    // redeemDebtByProvidingYTokens repo debtAmount with yToken
    // series - yToken to mint
    // credit   - amount of yToken to wipe
    // released  - amount of collateral to free
    function redeemDebtByProvidingYTokens(
        uint256 series,
        uint256 credit,
        uint256 released
    ) public {
        require(series < totalSeries, "Cannot redeem debt of non-existant series");
        // if yToken has matured, should call resolve
        require(
            now < yTokens[series].maturityTime(),
            "Cannot redeem debt after yToken has matured"
        );

        Repo memory repo = repos[series][msg.sender];
        require(
            repo.lockedCollateralAmount >= released,
            "Cannot release more collateral than locked"
        );
        require(
            repo.debtAmount >= credit,
            "Cannot redeem more debt than is present"
        );

        //burn tokens
        require(
            yTokens[series].balanceOf(msg.sender) >= credit,
            "Insufficient yToken balance for desired redemption"
        );
        yTokens[series].burnFrom(msg.sender, credit);

        // reduce the collateral and the debtAmount
        reduceCollateralOfRepo(series, msg.sender, released);
        reduceDebtOfRepo(series, msg.sender, credit);

        require(
            checkCollateralSufficiency(series, msg.sender),
            "New collateralization ratio is not sufficient"
        );

        collateralToken.transfer(msg.sender, released);
    }

    // liquidates a repo (partially)
    // series - yToken of debtAmount to buy
    // bum    - owner of the undercollateralized repo
    // settlementTokenAmountToBeProvided - amount of settlementTokens to sell
    function liquidate(
        uint256 series,
        address bum,
        uint256 settlementTokenAmountToBeProvided
    ) public {
        require(series < totalSeries, "Cannot liquidate repo of an unissued series");

        //check that repo is in danger zone
        require(
            !checkCollateralSufficiency(series, bum),
            "Provided address is sufficiently collateralized for that series"
        );

        // calculate the amount of settlementTokens to be provied

        Repo memory repo = repos[series][bum];
        uint256 rate = getSettlmentVSCollateralTokenRate(); // to add rate getter!!!
        uint256 amount = Math.min(
            repo.debtAmount,
            settlementTokenAmountToBeProvided
        );

        // exchange collateralToken vs settlmentToken
        uint256 collateralTokensToBeReleased = Math.min(
            (amount.mul(100 + LIQUIDATION_PAYOUT_PERCENTAGE) / 100).wmul(rate),
            repo.lockedCollateralAmount
        );

        //update repo
        reduceCollateralOfRepo(series, bum, collateralTokensToBeReleased);
        reduceDebtOfRepo(series, bum, amount);

        //Make settlementTokens withdrawable in the future
        settlementTokenFund[series] = settlementTokenFund[series].add(amount);

        // exchange funds for liquidator
        require(
            settlementToken.transferFrom(msg.sender, address(this), amount),
            "Transfer of settlementToken failed"
        );
        collateralToken.transfer(msg.sender, collateralTokensToBeReleased);
    }

    // redeem yTokens for settlementTokens
    // series - matured yToken
    // amount    - amount of yToken to close
    function claimFaceValue(uint256 series, uint256 amount, address owner)
        public
    {
        require(series < totalSeries, "Cannot claim face value of unissued series");
        require(
            now > yTokens[series].maturityTime(),
            "Cannot claim face value of token yet to mature"
        );
        if (!settled[series]) {
            settleDebtIntoDAIVault(series);
        }

        // Following line should always return amount, unless liquidations were not successful
        uint256 yTokenAmount = Math.min(settlementTokenFund[series], amount);
        settlementTokenFund[series] = settlementTokenFund[series].sub(
            yTokenAmount
        );
        yTokens[series].burnByOwner(owner, yTokenAmount);
        settlementToken.transfer(owner, yTokenAmount);
    }

    // closes a series and triggers settlement into dai-vault
    function settleDebtIntoDAIVault(uint256 series) public {
        require(
            series < totalSeries,
            "Cannot trigger settlement of an unissued series"
        );
        require(
            now > yTokens[series].maturityTime(),
            "Cannot trigger settlement before maturity"
        );
        require(!settled[series], "Series was previously settled");

        //Todo: interaction with vault
        uint256 receivedSettlementTokens = totalDebtAmountInSeries[series];

        //Todo: adjust settlementTokenFund
        settlementTokenFund[series] = settlementTokenFund[series].add(
            receivedSettlementTokens
        );

        settled[series] = true;
    }

    function checkCollateralSufficiency(uint256 series, address owner)
        public
        view
        returns (bool)
    {
        Repo memory repo = repos[series][owner];
        uint256 rate = getSettlmentVSCollateralTokenRate();
        uint256 min = repo.debtAmount.wmul(collateralRatio).wmul(rate);
        return repo.lockedCollateralAmount >= min;
    }

    function reduceDebtOfRepo(uint256 series, address owner, uint256 amount)
        internal
    {
        repos[series][owner].debtAmount = repos[series][owner].debtAmount.sub(
            amount
        );
        totalDebtAmountInSeries[series] = totalDebtAmountInSeries[series].sub(
            amount
        );
    }
    function reduceCollateralOfRepo(
        uint256 series,
        address owner,
        uint256 amount
    ) internal {
        repos[series][owner].lockedCollateralAmount = repos[series][owner]
            .lockedCollateralAmount
            .sub(amount);
        totalCollateralAmountInSeries[series] = totalCollateralAmountInSeries[series]
            .sub(amount);
    }
    function addDebtToRepo(uint256 series, address owner, uint256 amount)
        internal
    {
        repos[series][owner].debtAmount = repos[series][owner].debtAmount.add(
            amount
        );
        totalDebtAmountInSeries[series] = totalDebtAmountInSeries[series].add(
            amount
        );
    }
    function addCollateralToRepo(uint256 series, address owner, uint256 amount)
        internal
    {
        repos[series][owner].lockedCollateralAmount = repos[series][owner]
            .lockedCollateralAmount
            .add(amount);
        totalCollateralAmountInSeries[series] = totalCollateralAmountInSeries[series]
            .add(amount);
    }
}
