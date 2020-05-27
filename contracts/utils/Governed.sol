pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../upgradeable/Ownable.sol";
import "../upgradeable/Initializable.sol";

/**
 * @title Governed
 * A base contract to set the contract references on each contract.
 */
contract Governed is OpenZeppelinUpgradesOwnable, Initializable {
    address public directory;
    mapping(uint256 => address) public contracts;

    function initialize(address _directory) public initializer {
        _owner = msg.sender;
        directory = _directory;
    }

    // TODO: consider moving this enum to Common
    enum CoreContracts {
        Escrow,
        Instruments,
        LiquidationAuction,
        RiskFramework,
        Swap,
        Portfolios,
        SettlementOracle,
        ERC1155Token,
        SwapnetUtils,
        PoolShares
    }

    function setContract(CoreContracts name, address _address) public {
        require(msg.sender == directory, $$(ErrorCode(UNAUTHORIZED_CALLER)));
        contracts[uint256(name)] = _address;
    }
}
