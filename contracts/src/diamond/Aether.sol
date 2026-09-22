pragma solidity ^0.8.24;

import { IDiamondCut } from "./interfaces/IDiamond.sol";
import { LibAether } from "./libraries/LibAether.sol";
import { LibDiamond } from "./libraries/LibDiamond.sol";

contract Aether {
    error FunctionNotFound(bytes4 selector);
    error UnexpectedNativeTransfer();

    constructor(address owner_, address diamondCutFacet) payable {
        LibDiamond.setContractOwner(owner_);

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = IDiamondCut.diamondCut.selector;
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: diamondCutFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
        LibDiamond.diamondCut(cut, address(0), "");
    }

    fallback() external payable {
        address facet = LibDiamond.diamondStorage().selectorToFacetAndPosition[msg.sig].facetAddress;
        if (facet == address(0)) revert FunctionNotFound(msg.sig);
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    receive() external payable {
        LibAether.Storage storage s = LibAether.store();
        if (msg.sender != s.weth && !s.allowedExternalTarget[msg.sender]) revert UnexpectedNativeTransfer();
    }
}
