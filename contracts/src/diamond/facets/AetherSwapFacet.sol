pragma solidity ^0.8.24;

import { IERC20V2, IPermit2V2, IV3SwapRouterV2, IWETH9V2, SafeTransferV2 } from "../libraries/LibAsset.sol";
import { LibAether } from "../libraries/LibAether.sol";
import { LibPoolSwap } from "../libraries/LibPoolSwap.sol";

contract AetherSwapFacet {
    using SafeTransferV2 for IERC20V2;

    string public constant VERSION = "3.1.0";

    uint160 private constant MAX_UINT160 = type(uint160).max;
    uint48 private constant PERMIT2_EXPIRATION = type(uint48).max;

    enum LegType {
        V3_SINGLE,
        V3_PATH,
        UNIVERSAL_ROUTER,
        EXTERNAL_CALL,
        WRAP_ETH,
        UNWRAP_WETH,
        V3_POOL,
        V2_PAIR
    }

    struct V3SingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    struct Leg {
        LegType legType;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address target;
        bytes path;
        V3SingleParams v3Single;
        bytes callData;
        uint256 value;
    }

    struct Route {
        uint256 amountIn;
        uint256 minAmountOut;
        Leg[] legs;
    }

    struct SwapParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address recipient;
        bool unwrapWeth;
        uint256 deadline;
        Route[] routes;
        address[] dustTokens;
    }

    event UniversalRouterCall(address indexed target, address indexed tokenIn, uint256 amountIn, uint256 value);
    event SwapExecuted(
        address indexed sender,
        address indexed recipient,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount
    );
    event RouteExecuted(uint256 indexed routeIndex, uint256 amountIn, uint256 amountOut);
    event LegExecuted(
        uint256 indexed routeIndex,
        uint256 indexed legIndex,
        LegType legType,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    error Reentered();
    error Paused();
    error DeadlineExpired();
    error InvalidRecipient();
    error InvalidAmount();
    error InvalidRoute();
    error InvalidTarget();
    error TokenNotAllowed(address token);
    error InsufficientOutput();
    error NativeTransferFailed();
    error ExternalCallFailed(bytes reason);
    error PoolSwapUnauthorized();
    error PoolSwapNothingOwed();
    error PoolSwapOverpay();
    error PoolDoesNotExist();
    error InsufficientLiquidity();

    modifier nonReentrant() {
        LibAether.Storage storage s = LibAether.store();
        if (s.locked) revert Reentered();
        s.locked = true;
        _;
        s.locked = false;
    }

    function execute(SwapParams calldata params) external payable nonReentrant returns (uint256 amountOut) {
        if (LibAether.store().paused) revert Paused();
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (params.recipient == address(0)) revert InvalidRecipient();
        if (params.amountIn == 0 || params.routes.length == 0) revert InvalidAmount();

        address inputToken = _normalizeToken(params.tokenIn);
        address outputToken = _normalizeToken(params.tokenOut);
        address outputAsset = params.tokenOut;
        _checkTokenAllowed(inputToken);
        _checkTokenAllowed(outputToken);

        if (params.tokenIn == address(0)) {
            if (msg.value != params.amountIn) revert InvalidAmount();
        } else {
            if (msg.value != 0) revert InvalidAmount();
            IERC20V2(inputToken).safeTransferFrom(msg.sender, address(this), params.amountIn);
        }

        uint256 totalRouteInput;
        uint256 outputBefore = _balanceOfAsset(outputAsset);

        for (uint256 i = 0; i < params.routes.length; i++) {
            Route calldata route = params.routes[i];
            if (route.amountIn == 0 || route.legs.length == 0) revert InvalidRoute();
            totalRouteInput += route.amountIn;

            uint256 routeOutputBefore = _balanceOfAsset(outputAsset);

            for (uint256 j = 0; j < route.legs.length; j++) {
                Leg calldata leg = route.legs[j];
                uint256 legAmountIn = leg.amountIn;
                if (legAmountIn == 0) {
                    legAmountIn = j == 0 ? route.amountIn : _balanceOfAsset(leg.tokenIn);
                }
                uint256 legAmountOut = _executeLeg(leg, legAmountIn);
                emit LegExecuted(i, j, leg.legType, leg.tokenIn, leg.tokenOut, legAmountIn, legAmountOut);
            }

            uint256 routeAmountOut = _balanceOfAsset(outputAsset) - routeOutputBefore;
            if (routeAmountOut < route.minAmountOut) revert InsufficientOutput();
            emit RouteExecuted(i, route.amountIn, routeAmountOut);
        }

        if (totalRouteInput > params.amountIn) revert InvalidAmount();

        amountOut = _balanceOfAsset(outputAsset) - outputBefore;
        if (amountOut < params.minAmountOut) revert InsufficientOutput();

        uint256 feeAmount = _takeFee(outputAsset, amountOut);
        uint256 recipientAmount = amountOut - feeAmount;

        if (params.tokenOut == address(0)) {
            _sendNative(params.recipient, recipientAmount);
        } else if (params.unwrapWeth) {
            address weth = LibAether.store().weth;
            if (outputToken != weth) revert InvalidRoute();
            IWETH9V2(weth).withdraw(recipientAmount);
            _sendNative(params.recipient, recipientAmount);
        } else {
            IERC20V2(outputToken).safeTransfer(params.recipient, recipientAmount);
        }

        _refundDustAsset(params.tokenIn, msg.sender);
        for (uint256 i = 0; i < params.dustTokens.length; i++) {
            address dustToken = _normalizeToken(params.dustTokens[i]);
            if (params.tokenOut == address(0) || dustToken != outputToken) {
                _refundDustAsset(params.dustTokens[i], msg.sender);
            }
        }

        emit SwapExecuted(msg.sender, params.recipient, inputToken, outputToken, params.amountIn, recipientAmount, feeAmount);
    }

    function _executeLeg(Leg calldata leg, uint256 amountIn) internal returns (uint256 amountOut) {
        if (amountIn == 0) revert InvalidAmount();

        address tokenIn = _normalizeToken(leg.tokenIn);
        address tokenOut = _normalizeToken(leg.tokenOut);
        _checkTokenAllowed(tokenIn);
        _checkTokenAllowed(tokenOut);
        address weth = LibAether.store().weth;

        if (leg.legType == LegType.WRAP_ETH) {
            if (address(this).balance < amountIn) revert InvalidAmount();
            uint256 beforeWeth = IERC20V2(weth).balanceOf(address(this));
            IWETH9V2(weth).deposit{ value: amountIn }();
            amountOut = IERC20V2(weth).balanceOf(address(this)) - beforeWeth;
            if (amountOut < leg.minAmountOut) revert InsufficientOutput();
            return amountOut;
        }

        if (leg.legType == LegType.UNWRAP_WETH) {
            if (tokenIn != weth) revert InvalidRoute();
            uint256 beforeNative = address(this).balance;
            IWETH9V2(weth).withdraw(amountIn);
            amountOut = address(this).balance - beforeNative;
            if (amountOut < leg.minAmountOut) revert InsufficientOutput();
            return amountOut;
        }

        uint256 beforeOut = _balanceOfAsset(leg.tokenOut);

        if (leg.legType == LegType.V3_SINGLE) {
            address v3Router = LibAether.store().v3Router;
            IERC20V2(tokenIn).forceApprove(v3Router, amountIn);
            IV3SwapRouterV2(v3Router).exactInputSingle(
                IV3SwapRouterV2.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: leg.v3Single.fee,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: leg.minAmountOut,
                    sqrtPriceLimitX96: leg.v3Single.sqrtPriceLimitX96
                })
            );
        } else if (leg.legType == LegType.V3_PATH) {
            if (leg.path.length == 0) revert InvalidRoute();
            address v3Router = LibAether.store().v3Router;
            IERC20V2(tokenIn).forceApprove(v3Router, amountIn);
            IV3SwapRouterV2(v3Router).exactInput(
                IV3SwapRouterV2.ExactInputParams({
                    path: leg.path,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: leg.minAmountOut
                })
            );
        } else if (leg.legType == LegType.V3_POOL) {
            LibPoolSwap.swapV3(tokenIn, tokenOut, leg.v3Single.fee, amountIn, address(this));
        } else if (leg.legType == LegType.V2_PAIR) {
            LibPoolSwap.swapV2(tokenIn, tokenOut, amountIn, address(this));
        } else if (leg.legType == LegType.UNIVERSAL_ROUTER) {
            _executeUniversalRouter(leg, tokenIn, amountIn);
        } else if (leg.legType == LegType.EXTERNAL_CALL) {
            _executeExternal(leg, tokenIn, amountIn, leg.target);
        } else {
            revert InvalidRoute();
        }

        amountOut = _balanceOfAsset(leg.tokenOut) - beforeOut;
        if (amountOut < leg.minAmountOut) revert InsufficientOutput();
    }

    function _executeUniversalRouter(Leg calldata leg, address tokenIn, uint256 amountIn) internal {
        address universalRouter = LibAether.store().universalRouter;
        if (leg.target != address(0) && leg.target != universalRouter) revert InvalidTarget();
        _executeExternal(leg, tokenIn, amountIn, universalRouter);
        emit UniversalRouterCall(universalRouter, tokenIn, amountIn, leg.value);
    }

    function _executeExternal(Leg calldata leg, address tokenIn, uint256 amountIn, address target) internal {
        LibAether.Storage storage s = LibAether.store();
        if (!s.allowedExternalTarget[target]) revert InvalidTarget();

        bool nativeInput = leg.tokenIn == address(0);

        if (nativeInput) {
            if (leg.value != amountIn || address(this).balance < leg.value) revert InvalidAmount();
        } else if (tokenIn == s.weth && leg.value > 0) {
            if (leg.value > amountIn) revert InvalidAmount();
            IWETH9V2(s.weth).withdraw(leg.value);
        } else if (leg.value > 0 && address(this).balance < leg.value) {
            revert InvalidAmount();
        }

        if (!nativeInput && amountIn > 0) {
            IERC20V2(tokenIn).ensureAllowance(s.permit2, amountIn);
            IPermit2V2(s.permit2).approve(tokenIn, target, MAX_UINT160, PERMIT2_EXPIRATION);
            IERC20V2(tokenIn).forceApprove(target, amountIn);
        }

        (bool ok, bytes memory reason) = target.call{ value: leg.value }(leg.callData);
        if (!ok) revert ExternalCallFailed(reason);
    }

    function _takeFee(address outputAsset, uint256 amountOut) internal returns (uint256 feeAmount) {
        LibAether.Storage storage s = LibAether.store();
        if (s.feeBps == 0 || amountOut == 0) return 0;
        feeAmount = amountOut * s.feeBps / 10000;
        if (feeAmount == 0) return 0;
        if (outputAsset == address(0)) {
            _sendNative(s.feeRecipient, feeAmount);
        } else {
            IERC20V2(_normalizeToken(outputAsset)).safeTransfer(s.feeRecipient, feeAmount);
        }
    }

    function _normalizeToken(address token) internal view returns (address) {
        return token == address(0) ? LibAether.store().weth : token;
    }

    function _balanceOfAsset(address token) internal view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20V2(token).balanceOf(address(this));
    }

    function _checkTokenAllowed(address token) internal view {
        LibAether.Storage storage s = LibAether.store();
        if (s.strictTokenList && !s.allowedToken[token]) revert TokenNotAllowed(token);
    }

    function _refundDust(address token, address to) internal {
        uint256 dust = IERC20V2(token).balanceOf(address(this));
        if (dust > 0) IERC20V2(token).safeTransfer(to, dust);
    }

    function _refundDustAsset(address token, address to) internal {
        if (token == address(0)) {
            uint256 dust = address(this).balance;
            if (dust > 0) _sendNative(to, dust);
        } else {
            _refundDust(_normalizeToken(token), to);
        }
    }

    function _sendNative(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
    }
}
