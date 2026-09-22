pragma solidity ^0.8.24;

interface IERC20V2 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWETH9V2 is IERC20V2 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IPermit2V2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IV3SwapRouterV2 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

library SafeTransferV2 {
    error TransferFailed();
    error ApproveFailed();

    function safeTransfer(IERC20V2 token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transfer.selector, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function safeTransferFrom(IERC20V2 token, address from, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function forceApprove(IERC20V2 token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, amount)
        );
        if (ok && (data.length == 0 || abi.decode(data, (bool)))) return;

        (ok, data) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, 0)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert ApproveFailed();

        (ok, data) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }

    function ensureAllowance(IERC20V2 token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).staticcall(
            abi.encodeWithSelector(token.allowance.selector, address(this), spender)
        );
        if (ok && data.length >= 32 && abi.decode(data, (uint256)) >= amount) return;
        forceApprove(token, spender, amount);
    }
}
