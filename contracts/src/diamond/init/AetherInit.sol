pragma solidity ^0.8.24;

import { IDiamondCut, IDiamondLoupe, IERC165, IERC173 } from "../interfaces/IDiamond.sol";
import { LibAether } from "../libraries/LibAether.sol";
import { LibDiamond } from "../libraries/LibDiamond.sol";

contract AetherInit {
    event ExternalTargetSet(address indexed target, bool allowed);
    event FeeSet(address indexed recipient, uint16 feeBps);

    error AlreadyInitialized();
    error InvalidTarget();

    function init(
        address weth,
        address v3Router,
        address permit2,
        address universalRouter,
        address[] calldata extraTargets
    ) external {
        LibAether.Storage storage s = LibAether.store();
        if (s.weth != address(0)) revert AlreadyInitialized();
        if (weth == address(0) || v3Router == address(0) || permit2 == address(0) || universalRouter == address(0)) {
            revert InvalidTarget();
        }

        s.weth = weth;
        s.v3Router = v3Router;
        s.permit2 = permit2;
        s.universalRouter = universalRouter;
        s.feeRecipient = LibDiamond.contractOwner();
        emit FeeSet(s.feeRecipient, 0);

        s.allowedExternalTarget[universalRouter] = true;
        emit ExternalTargetSet(universalRouter, true);
        for (uint256 i; i < extraTargets.length; i++) {
            if (extraTargets[i] == address(0)) revert InvalidTarget();
            s.allowedExternalTarget[extraTargets[i]] = true;
            emit ExternalTargetSet(extraTargets[i], true);
        }

        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds.supportedInterfaces[type(IERC165).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;
        ds.supportedInterfaces[type(IERC173).interfaceId] = true;
    }
}
