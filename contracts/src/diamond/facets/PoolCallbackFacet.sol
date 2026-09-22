pragma solidity ^0.8.24;

import { LibPoolSwap } from "../libraries/LibPoolSwap.sol";

contract PoolCallbackFacet {
    error PoolSwapUnauthorized();
    error PoolSwapNothingOwed();
    error PoolSwapOverpay();

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        LibPoolSwap.payV3Callback(amount0Delta, amount1Delta, data);
    }
}
