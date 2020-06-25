pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "../interface/IEscrowCallable.sol";
import "../interface/IPortfoliosCallable.sol";
import "../interface/IRiskFramework.sol";

import "../upgradeable/Ownable.sol";
import "../upgradeable/Initializable.sol";

import "./Directory.sol";

/**
 * @title Governed
 * A base contract to set the contract references on each contract.
 */
contract Governed is OpenZeppelinUpgradesOwnable, Initializable {
    address public directory;
    mapping(uint256 => address) private contracts;

    function initialize(address _directory) public initializer {
        _owner = msg.sender;
        directory = _directory;
    }

    enum CoreContracts {
        Escrow,
        RiskFramework,
        Portfolios,
        ERC1155Token
    }

    function setContract(CoreContracts name, address _address) public {
        require(msg.sender == directory, $$(ErrorCode(UNAUTHORIZED_CALLER)));
        contracts[uint256(name)] = _address;
    }

    function _fetchDependencies(CoreContracts[] memory dependencies) internal {
        address[] memory _contracts = Directory(directory).getContracts(dependencies);
        for (uint256 i; i < _contracts.length; i++) {
            contracts[uint256(dependencies[i])] = _contracts[i];
        }
    }

    function Escrow() internal view returns (IEscrowCallable) {
        return IEscrowCallable(contracts[uint256(CoreContracts.Escrow)]);
    }

    function Portfolios() internal view returns (IPortfoliosCallable) {
        return IPortfoliosCallable(contracts[uint256(CoreContracts.Portfolios)]);
    }

    function RiskFramework() internal view returns (IRiskFramework) {
        return IRiskFramework(contracts[uint256(CoreContracts.RiskFramework)]);
    }

    function calledByEscrow() internal view returns (bool) {
        return msg.sender == contracts[(uint256(CoreContracts.Escrow))];
    }

    function calledByPortfolios() internal view returns (bool) {
        return msg.sender == contracts[(uint256(CoreContracts.Portfolios))];
    }

    function calledByERC1155() internal view returns (bool) {
        return msg.sender == contracts[(uint256(CoreContracts.ERC1155Token))];
    }
}
