pragma solidity ^0.8.24;

import { IERC20V2, SafeTransferV2 } from "../libraries/LibAsset.sol";
import { LibDiamond } from "../libraries/LibDiamond.sol";

contract WithdrawFacet {
    using SafeTransferV2 for IERC20V2;

    error InvalidRecipient();
    error NativeTransferFailed();

    function rescueToken(address token, address to, uint256 amount) external {
        LibDiamond.enforceIsContractOwner();
        if (to == address(0)) revert InvalidRecipient();
        if (token == address(0)) {
            (bool ok, ) = to.call{ value: amount }("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20V2(token).safeTransfer(to, amount);
        }
    }
}
