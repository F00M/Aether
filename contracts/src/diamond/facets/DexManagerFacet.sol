pragma solidity ^0.8.24;

import { LibAether } from "../libraries/LibAether.sol";
import { LibDiamond } from "../libraries/LibDiamond.sol";

contract DexManagerFacet {
    event RouterSet(bytes32 indexed key, address indexed oldRouter, address indexed newRouter);
    event ExternalTargetSet(address indexed target, bool allowed);

    error InvalidTarget();

    function setExternalTarget(address target, bool allowed) external {
        LibDiamond.enforceIsContractOwner();
        if (target == address(0)) revert InvalidTarget();
        LibAether.store().allowedExternalTarget[target] = allowed;
        emit ExternalTargetSet(target, allowed);
    }

    function setRouter(bytes32 key, address router) external {
        LibDiamond.enforceIsContractOwner();
        if (router == address(0)) revert InvalidTarget();
        LibAether.Storage storage s = LibAether.store();

        if (key == keccak256("V3_ROUTER")) {
            emit RouterSet(key, s.v3Router, router);
            s.v3Router = router;
        } else if (key == keccak256("PERMIT2")) {
            emit RouterSet(key, s.permit2, router);
            s.permit2 = router;
        } else if (key == keccak256("UNIVERSAL_ROUTER")) {
            emit RouterSet(key, s.universalRouter, router);
            s.universalRouter = router;
            s.allowedExternalTarget[router] = true;
            emit ExternalTargetSet(router, true);
        } else {
            revert InvalidTarget();
        }
    }

    function allowedExternalTarget(address target) external view returns (bool) {
        return LibAether.store().allowedExternalTarget[target];
    }

    function weth() external view returns (address) {
        return LibAether.store().weth;
    }

    function v3Router() external view returns (address) {
        return LibAether.store().v3Router;
    }

    function permit2() external view returns (address) {
        return LibAether.store().permit2;
    }

    function universalRouter() external view returns (address) {
        return LibAether.store().universalRouter;
    }
}
