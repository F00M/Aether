pragma solidity ^0.8.24;

import { IERC20V2, SafeTransferV2 } from "./LibAsset.sol";

interface IUniswapV3PoolSwap {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IUniswapV2PairSwap {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

library LibPoolSwap {
    using SafeTransferV2 for IERC20V2;

    address internal constant V3_FACTORY = 0x0227628f3F023bb0B980b67D528571c95c6DaC1c;
    bytes32 internal constant V3_INIT_CODE_HASH =
        0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    address internal constant V2_FACTORY = 0xF62c03E08ada871A0bEb309762E260a7a6a880E6;
    bytes32 internal constant V2_INIT_CODE_HASH =
        0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f;

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;

    bytes32 internal constant EXPECTED_POOL_SLOT = keccak256("aether.poolswap.expected.pool");
    bytes32 internal constant EXPECTED_TOKEN_SLOT = keccak256("aether.poolswap.expected.token");
    bytes32 internal constant MAX_PAY_SLOT = keccak256("aether.poolswap.max.pay");

    error PoolSwapUnauthorized();
    error PoolSwapNothingOwed();
    error PoolSwapOverpay();
    error PoolDoesNotExist();
    error InsufficientLiquidity();

    function poolV3(address tokenA, address tokenB, uint24 fee) internal pure returns (address pool) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pool = address(uint160(uint256(keccak256(abi.encodePacked(
            hex"ff",
            V3_FACTORY,
            keccak256(abi.encode(token0, token1, fee)),
            V3_INIT_CODE_HASH
        )))));
    }

    function pairV2(address tokenA, address tokenB) internal pure returns (address pair) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pair = address(uint160(uint256(keccak256(abi.encodePacked(
            hex"ff",
            V2_FACTORY,
            keccak256(abi.encodePacked(token0, token1)),
            V2_INIT_CODE_HASH
        )))));
    }

    function swapV3(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        address recipient
    ) internal returns (uint256 amountOut) {
        address pool = poolV3(tokenIn, tokenOut, fee);
        if (pool.code.length == 0) revert PoolDoesNotExist();
        bool zeroForOne = tokenIn < tokenOut;

        _armCallback(pool, tokenIn, amountIn);
        (int256 amount0, int256 amount1) = IUniswapV3PoolSwap(pool).swap(
            recipient,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            abi.encode(tokenIn)
        );
        _disarmCallback();

        int256 received = zeroForOne ? -amount1 : -amount0;
        amountOut = received > 0 ? uint256(received) : 0;
    }

    function swapV2(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address recipient
    ) internal returns (uint256 amountOut) {
        address pair = pairV2(tokenIn, tokenOut);
        if (pair.code.length == 0) revert PoolDoesNotExist();
        bool zeroForOne = tokenIn < tokenOut;

        (uint112 reserve0, uint112 reserve1, ) = IUniswapV2PairSwap(pair).getReserves();
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne
            ? (uint256(reserve0), uint256(reserve1))
            : (uint256(reserve1), uint256(reserve0));
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        uint256 amountInWithFee = amountIn * 997;
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
        if (amountOut == 0) revert InsufficientLiquidity();

        IERC20V2(tokenIn).safeTransfer(pair, amountIn);
        IUniswapV2PairSwap(pair).swap(
            zeroForOne ? 0 : amountOut,
            zeroForOne ? amountOut : 0,
            recipient,
            ""
        );
    }

    function payV3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        address expectedPool = _load(EXPECTED_POOL_SLOT);
        if (expectedPool == address(0) || msg.sender != expectedPool) revert PoolSwapUnauthorized();

        address tokenIn = abi.decode(data, (address));
        if (tokenIn != _load(EXPECTED_TOKEN_SLOT)) revert PoolSwapUnauthorized();

        uint256 amountToPay = amount0Delta > 0
            ? uint256(amount0Delta)
            : (amount1Delta > 0 ? uint256(amount1Delta) : 0);
        if (amountToPay == 0) revert PoolSwapNothingOwed();
        if (amountToPay > _loadUint(MAX_PAY_SLOT)) revert PoolSwapOverpay();

        IERC20V2(tokenIn).safeTransfer(msg.sender, amountToPay);
    }

    function _armCallback(address pool, address tokenIn, uint256 maxPay) private {
        _store(EXPECTED_POOL_SLOT, pool);
        _store(EXPECTED_TOKEN_SLOT, tokenIn);
        _storeUint(MAX_PAY_SLOT, maxPay);
    }

    function _disarmCallback() private {
        _store(EXPECTED_POOL_SLOT, address(0));
        _store(EXPECTED_TOKEN_SLOT, address(0));
        _storeUint(MAX_PAY_SLOT, 0);
    }

    function _store(bytes32 slot, address value) private {
        assembly {
            tstore(slot, value)
        }
    }

    function _storeUint(bytes32 slot, uint256 value) private {
        assembly {
            tstore(slot, value)
        }
    }

    function _load(bytes32 slot) private view returns (address value) {
        assembly {
            value := tload(slot)
        }
    }

    function _loadUint(bytes32 slot) private view returns (uint256 value) {
        assembly {
            value := tload(slot)
        }
    }
}
