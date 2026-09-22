pragma solidity ^0.8.24;

import { LibAether } from "../libraries/LibAether.sol";
import { LibDiamond } from "../libraries/LibDiamond.sol";

contract ConfigFacet {
    uint256 public constant MAX_FEE_BPS = 100;

    event FeeSet(address indexed recipient, uint16 feeBps);
    event StrictTokenListSet(bool enabled);
    event TokenAllowedSet(address indexed token, bool allowed);

    error InvalidRecipient();
    error InvalidAmount();
    error InvalidTarget();

    function setFee(address recipient, uint16 feeBps_) external {
        LibDiamond.enforceIsContractOwner();
        if (recipient == address(0)) revert InvalidRecipient();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidAmount();
        LibAether.Storage storage s = LibAether.store();
        s.feeRecipient = recipient;
        s.feeBps = feeBps_;
        emit FeeSet(recipient, feeBps_);
    }

    function setStrictTokenList(bool enabled) external {
        LibDiamond.enforceIsContractOwner();
        LibAether.store().strictTokenList = enabled;
        emit StrictTokenListSet(enabled);
    }

    function setAllowedToken(address token, bool allowed) external {
        LibDiamond.enforceIsContractOwner();
        if (token == address(0)) revert InvalidTarget();
        LibAether.store().allowedToken[token] = allowed;
        emit TokenAllowedSet(token, allowed);
    }

    function feeRecipient() external view returns (address) {
        return LibAether.store().feeRecipient;
    }

    function feeBps() external view returns (uint16) {
        return LibAether.store().feeBps;
    }

    function strictTokenList() external view returns (bool) {
        return LibAether.store().strictTokenList;
    }

    function allowedToken(address token) external view returns (bool) {
        return LibAether.store().allowedToken[token];
    }
}
