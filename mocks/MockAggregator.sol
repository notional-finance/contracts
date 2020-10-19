pragma solidity ^0.6.0;

contract MockAggregator {
    int256 private _answer;
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 timestamp);

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function setAnswer(int256 a) external {
        _answer = a;
        emit AnswerUpdated(a, 0, block.timestamp);
    }
}