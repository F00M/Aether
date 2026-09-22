pragma solidity ^0.8.24;

import { IDiamondLoupe, IERC165 } from "../interfaces/IDiamond.sol";
import { LibDiamond } from "../libraries/LibDiamond.sol";

contract DiamondLoupeFacet is IDiamondLoupe, IERC165 {
    function facets() external view override returns (Facet[] memory facets_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        uint256 count = ds.facetAddresses.length;
        facets_ = new Facet[](count);
        for (uint256 i; i < count; i++) {
            address facet = ds.facetAddresses[i];
            facets_[i].facetAddress = facet;
            facets_[i].functionSelectors = ds.facetFunctionSelectors[facet].functionSelectors;
        }
    }

    function facetFunctionSelectors(address _facet) external view override returns (bytes4[] memory) {
        return LibDiamond.diamondStorage().facetFunctionSelectors[_facet].functionSelectors;
    }

    function facetAddresses() external view override returns (address[] memory) {
        return LibDiamond.diamondStorage().facetAddresses;
    }

    function facetAddress(bytes4 _functionSelector) external view override returns (address) {
        return LibDiamond.diamondStorage().selectorToFacetAndPosition[_functionSelector].facetAddress;
    }

    function supportsInterface(bytes4 _interfaceId) external view override returns (bool) {
        return LibDiamond.diamondStorage().supportedInterfaces[_interfaceId];
    }
}
