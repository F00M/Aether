pragma solidity ^0.8.24;

import { IERC173 } from "../interfaces/IDiamond.sol";
import { LibDiamond } from "../libraries/LibDiamond.sol";

contract OwnershipFacet is IERC173 {
    event OwnershipTransferStarted(address indexed oldOwner, address indexed pendingOwner);

    error InvalidRecipient();

    function owner() external view override returns (address) {
        return LibDiamond.contractOwner();
    }

    function pendingOwner() external view returns (address) {
        return LibDiamond.diamondStorage().pendingOwner;
    }

    function transferOwnership(address newOwner) external override {
        LibDiamond.enforceIsContractOwner();
        if (newOwner == address(0)) revert InvalidRecipient();
        LibDiamond.diamondStorage().pendingOwner = newOwner;
        emit OwnershipTransferStarted(LibDiamond.contractOwner(), newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != LibDiamond.diamondStorage().pendingOwner) revert LibDiamond.NotOwner();
        LibDiamond.setContractOwner(msg.sender);
    }

    function cancelOwnershipTransfer() external {
        LibDiamond.enforceIsContractOwner();
        LibDiamond.diamondStorage().pendingOwner = address(0);
    }
}
