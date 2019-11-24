pragma solidity ^0.5.2;

import "./yToken.sol";
import "./oracle/Oracle.sol";
import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/math/Math.sol";

import "./libraries/ExponentialOperations.sol";
import "openzeppelin-solidity/contracts/ownership/Ownable.sol";

contract Treasurer is Ownable {
    using SafeMath for uint256;
    using ExponentialOperations for uint256;

    struct Repo {
        uint256 lockedCollateralAmount;
        uint256 debtAmount;
    }

    mapping(uint256 => yToken) public yTokens;
    mapping(uint256 => mapping(address => Repo)) public repos; // lockedCollateralAmount ETH and debtAmount
    mapping(address => uint256) public unlocked; // unlocked ETH
    mapping(uint256 => uint256) public totalCollateralAmountInSeries;
    // This fund collects settlementTokens from upfront re-payments or liquidations
    mapping(uint256 => uint256) public settlementTokenFund; // This fund collects settlementTokens from upfront re-payments or liquidations
    mapping(uint256 => bool) public settled; // indicated whether a series was settled into the fault
    uint256[] public issuedSeries;
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

    // --- Actions ---

    // provide address to oracle
    // oracle_ - address of the oracle contract
    function setOracle(Oracle oracle_) public onlyOwner {
        require(address(oracle) == address(0), "oracle was already set");
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

    // issue new yToken
    // face value of 1 is assumed
    function createNewYToken(uint256 maturityTime)
        public
        returns (uint256 series)
    {
        require(maturityTime > now, "treasurer-issue-maturity-is-in-past");
        series = totalSeries;
        require(
            address(yTokens[series]) == address(0),
            "treasurer-issue-may-not-reissue-series"
        );
        yToken _token = new yToken(maturityTime);
        yTokens[series] = _token;
        issuedSeries.push(series);
        totalSeries = totalSeries + 1;
    }

    // add collateral to repo
    function topUpCollateral(uint256 amountCollateral) public payable {
        require(
            collateralToken.transferFrom(
                msg.sender,
                address(this),
                amountCollateral
            ),
            "treasurer-topUpCollateral-collateralRatio-include-deposit"
        );
        unlocked[msg.sender] = unlocked[msg.sender].add(amountCollateral);
    }

    // remove collateral from repo
    // amount - amount of ETH to remove from unlocked account
    function withdrawCollateral(uint256 amount) public {
        require(
            amount >= 0,
            "treasurer-withdrawCollateral-insufficient-balance"
        );
        unlocked[msg.sender] = unlocked[msg.sender].sub(amount);
        collateralToken.transfer(msg.sender, amount);
    }

    // issueYToken a new yToken
    // series - yToken to mint
    // yTokenAmount   - amount of yToken to mint
    // collateralAmountToLock   - amount of collateral to lock up
    function issueYToken(
        uint256 series,
        uint256 yTokenAmount,
        uint256 collateralAmountToLock
    ) public {
        require(series < totalSeries, "treasurer-make-unissued-series");
        // first check if sufficient capital to lock up
        require(
            unlocked[msg.sender] >= collateralAmountToLock,
            "treasurer-issueYToken-insufficient-unlocked-to-lock"
        );

        Repo memory repo = repos[series][msg.sender];
        uint256 rate = getSettlmentVSCollateralTokenRate(); // to add rate getter!!!
        uint256 min = yTokenAmount.wmul(collateralRatio).wmul(rate);
        require(
            collateralAmountToLock >= min,
            "treasurer-issueYToken-insufficient-collateral-for-those-tokens"
        );

        // lock msg.sender Collateral, add debtAmount
        unlocked[msg.sender] = unlocked[msg.sender].sub(collateralAmountToLock);
        repo.lockedCollateralAmount = repo.lockedCollateralAmount.add(
            collateralAmountToLock
        );
        repo.debtAmount = repo.debtAmount.add(yTokenAmount);
        repos[series][msg.sender] = repo;

        // mint new yTokens
        // first, ensure yToken is initialized and matures in the future
        require(
            yTokens[series].maturityTime() > now,
            "treasurer-issueYToken-invalid-or-matured-ytoken"
        );
        yTokens[series].mint(msg.sender, yTokenAmount);
    }

    // series - yToken  series
    // credit   - amount of yToken to wipe
    function payoutYTokens(uint256 series, uint256 credit)
        public
        returns (bool, uint256)
    {
        require(
            series < totalSeries,
            "treasurer-payoutYTokens-unissued-series"
        );
        require(
            repos[series][msg.sender].debtAmount >= credit,
            "treasurer-wipe-wipe-more-debtAmount-than-present"
        );
        // we assume that the face value == 10**18
        require(
            settlementToken.transferFrom(msg.sender, address(this), credit),
            "treasurer-wipe-wipe-more-debtAmount-than-present"
        );
        settlementTokenFund[series] = settlementTokenFund[series].add(credit);
        repos[series][msg.sender].debtAmount = repos[series][msg.sender]
            .debtAmount
            .sub(credit);
    }

    // wipe repo debtAmount with yToken
    // series - yToken to mint
    // credit   - amount of yToken to wipe
    // released  - amount of collateral to free
    function wipe(uint256 series, uint256 credit, uint256 released) public {
        require(series < totalSeries, "treasurer-wipe-unissued-series");
        // if yToken has matured, should call resolve
        require(
            now < yTokens[series].maturityTime(),
            "treasurer-wipe-yToken-has-matured"
        );

        Repo memory repo = repos[series][msg.sender];
        require(
            repo.lockedCollateralAmount >= released,
            "treasurer-wipe-release-more-than-locked"
        );
        require(
            repo.debtAmount >= credit,
            "treasurer-wipe-wipe-more-debtAmount-than-present"
        );
        // if would be undercollateralized after freeing clean, fail
        uint256 rlocked = repo.lockedCollateralAmount.sub(released);
        uint256 rdebt = repo.debtAmount.sub(credit);
        uint256 rate = getSettlmentVSCollateralTokenRate(); // to add rate getter!!!
        uint256 min = rdebt.wmul(collateralRatio).wmul(rate);
        require(
            rlocked >= min,
            "treasurer-wipe-insufficient-remaining-collateral"
        );

        //burn tokens
        require(
            yTokens[series].balanceOf(msg.sender) > credit,
            "treasurer-wipe-insufficient-token-balance"
        );
        yTokens[series].burnFrom(msg.sender, credit);

        // reduce the collateral and the debtAmount
        repo.lockedCollateralAmount = repo.lockedCollateralAmount.sub(released);
        repo.debtAmount = repo.debtAmount.sub(credit);
        repos[series][msg.sender] = repo;

        // add collateral back to the unlocked
        unlocked[msg.sender] = unlocked[msg.sender].add(released);
    }
    event Log(uint256 number);
    // liquidate a repo
    // series - yToken of debtAmount to buy
    // bum    - owner of the undercollateralized repo
    // amount - amount of yToken debtAmount to buy
    function liquidate(
        uint256 series,
        address bum,
        uint256 settlementTokenAmountToBeProvided
    ) public {
        require(series < totalSeries, "treasurer-liquidate-unissued-series");
        //check that repo is in danger zone
        Repo memory repo = repos[series][bum];
        uint256 rate = getSettlmentVSCollateralTokenRate();
        uint256 min = repo.debtAmount.wmul(minCollateralRatio).wmul(rate);
        require(repo.lockedCollateralAmount < min, "treasurer-bite-still-safe");
        // calculate the amount of settlementTokens to be provied
        uint256 amount = Math.min(
            repo.debtAmount,
            settlementTokenAmountToBeProvided
        );
        emit Log(amount);
        emit Log(rate);

        // exchange collateralToken vs settlmentToken
        uint256 collateralTokensToBeReleased = Math.min(
            (amount.mul(105) / 100).wmul(rate),
            repo.lockedCollateralAmount
        );
        emit Log(repo.lockedCollateralAmount);
        emit Log(collateralTokensToBeReleased);

        //update repo
        repo.lockedCollateralAmount = repo.lockedCollateralAmount.sub(
            collateralTokensToBeReleased
        );
        repo.debtAmount = repo.debtAmount.sub(amount);

        //Make settlementTokens withdrawable in the future
        settlementTokenFund[series] = settlementTokenFund[series].add(amount);

        // exchange funds for liquidator
        require(
            settlementToken.transferFrom(msg.sender, address(this), amount),
            "transfer of settlementToken failed"
        );
        collateralToken.transfer(msg.sender, collateralTokensToBeReleased);
    }

    // redeem yTokens for settlementTokens
    // series - matured yToken
    // amount    - amount of yToken to close
    function withdraw(uint256 series, uint256 amount) public {
        require(series < totalSeries, "treasurer-withdraw-unissued-series");
        require(
            now > yTokens[series].maturityTime(),
            "treasurer-withdraw-yToken-hasnt-matured"
        );
        if (!settled[series]) {
            close(series);
        }

        // Following line should always return amount, unless liquidations were not successful
        amount = Math.min(settlementTokenFund[series], amount);
        settlementTokenFund[series] = settlementTokenFund[series].sub(amount);
        yTokens[series].burnByOwner(msg.sender, amount);
        settlementToken.transfer(msg.sender, amount);
    }

    // closes a series and triggers settlement into dai-vault
    function close(uint256 series) public {
        require(series < totalSeries, "treasurer-close-unissued-series");
        require(
            now > yTokens[series].maturityTime(),
            "treasurer-withdraw-yToken-hasnt-matured"
        );

        //Todo: interaction with vault
        uint256 receivedSettlementTokens = 100 ether;
        //Todo: adjust settlementTokenFund
        settlementTokenFund[series] = settlementTokenFund[series].add(
            receivedSettlementTokens
        );

        settled[series] = true;
    }
}
