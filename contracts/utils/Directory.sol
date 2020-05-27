pragma solidity ^0.6.0;
pragma experimental ABIEncoderV2;

import "./Governed.sol";
import "../upgradeable/Ownable.sol";
import "../upgradeable/Initializable.sol";

/**
 * @title Directory
 * Stores the addresses and the dependency map for the entire Swapnet system. Allows
 * for the system to upgrade other contracts in the system.
 */
contract Directory is OpenZeppelinUpgradesOwnable, Initializable {
    mapping(uint256 => address) public contracts;

    function initialize() public initializer {
        _owner = msg.sender;
    }

    /**
     * Given a list of contracts that depend on "name", will set the current address on each one
     * of those contracts.
     *
     * @param name the contract that dependencies depend on
     * @param dependencies a list of contracts that depend on name
     */
    function setDependencies(Governed.CoreContracts name, Governed.CoreContracts[] calldata dependencies)
        external
        onlyOwner
    {
        address _address = contracts[uint256(name)];
        for (uint256 i; i < dependencies.length; i++) {
            Governed(contracts[uint256(dependencies[i])]).setContract(name, _address);
        }
    }

    /**
     * Returns the addresses for a list of contracts. Used to set dependencies in non-core
     * contracts. These contracts will have to be updated by governance if core contracts
     * change.
     *
     * @param dependencies a list of core contracts required by the caller
     * @return a list of addresses corresponding to the dependencies
     */
    function getContracts(Governed.CoreContracts[] memory dependencies) public view returns (address[] memory) {
        address[] memory _contracts = new address[](dependencies.length);
        for (uint256 i; i < _contracts.length; i++) {
            _contracts[i] = contracts[uint256(dependencies[i])];
        }
        return _contracts;
    }

    /**
     * Sets the global contract address for the directory. Must be called before updating
     * dependencies.
     *
     * @param name the enum of the contract
     * @param _address the address of the contract
     */
    function setContract(Governed.CoreContracts name, address _address) public onlyOwner {
        contracts[uint256(name)] = _address;
    }
}
