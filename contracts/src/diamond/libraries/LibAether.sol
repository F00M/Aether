pragma solidity ^0.8.24;

library LibAether {
    bytes32 internal constant STORAGE_POSITION = keccak256("aether.aggregator.storage.v1");

    struct Storage {
        address weth;
        address v3Router;
        address permit2;
        address universalRouter;
        address feeRecipient;
        uint16 feeBps;
        bool paused;
        bool strictTokenList;
        bool locked;
        mapping(address => bool) allowedExternalTarget;
        mapping(address => bool) allowedToken;
    }

    function store() internal pure returns (Storage storage s) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
