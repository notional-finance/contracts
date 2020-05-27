pragma solidity ^0.6.0;

contract MockAggregator {
    int256 private _answer;

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function setAnswer(int256 a) external {
        _answer = a;
    }
}