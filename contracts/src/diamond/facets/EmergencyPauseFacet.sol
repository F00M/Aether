pragma solidity ^0.8.24;

import { LibAether } from "../libraries/LibAether.sol";
import { LibDiamond } from "../libraries/LibDiamond.sol";

contract EmergencyPauseFacet {
    event PausedSet(bool paused);

    function setPaused(bool paused_) external {
        LibDiamond.enforceIsContractOwner();
        LibAether.store().paused = paused_;
        emit PausedSet(paused_);
    }

    function paused() external view returns (bool) {
        return LibAether.store().paused;
    }
}
