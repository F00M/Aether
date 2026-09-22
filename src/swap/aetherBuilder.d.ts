import type { Abi, PublicClient } from "viem";

import type { Quote, Route, Token } from "./types";

/**
 * Hand-written types for the ported (plain JS) aggregator encoder. Only the
 * boundary is typed — the implementation stays exactly as it shipped.
 */

export const SLIPPAGE_OPTIONS: string[];
export const PERMIT2: `0x${string}`;
export const AETHER_AGGREGATOR: `0x${string}`;
/** Gas limit preflight simulates within — below the per-transaction cap, with room for padding. */
export const AETHER_GAS_BUDGET: bigint;
/** Sepolia's per-transaction gas cap (EIP-7825). */
export const TX_GAS_CAP: bigint;
export const WETH_ADDRESS: `0x${string}`;
export const MAX_UINT256: string;
export const MAX_UINT160: bigint;
export const PERMIT2_EXPIRATION: number;
/** Ladder of extra basis points the preflight walks before giving up. */
export const AUTO_SLIPPAGE_EXTRA_BPS: bigint[];

export const ERC20_ABI: Abi;
export const PERMIT2_ABI: Abi;
export const WETH_ABI: Abi;
export const AETHER_AGGREGATOR_ABI: Abi;
export const UNIVERSAL_ROUTER_ABI: Abi;

export type AetherParams = {
  amountIn: bigint;
  [key: string]: unknown;
};

export type BuildParamsArgs = {
  routes: Route[];
  tokenIn: Token;
  tokenOut: Token;
  totalAmountIn: bigint;
  totalAmountOutMin: bigint;
  recipient: `0x${string}`;
  deadline: bigint;
};

export type PreflightArgs = {
  publicClient: PublicClient | undefined;
  account: `0x${string}`;
  quote: Quote | { routes: Route[] } | null;
  tokenIn: Token;
  tokenOut: Token;
  totalAmountIn: bigint;
  totalAmountOutMin: bigint;
  recipient: `0x${string}`;
  deadline: bigint;
};

export function quoteCanUseAether(quote: Quote | { routes: Route[] } | null): boolean;

export function buildAetherParams(args: BuildParamsArgs): AetherParams;

/** Simulates `execute()` and returns the params that actually go on-chain. */
export function findExecutableAetherParams(
  args: PreflightArgs,
): Promise<{ params: AetherParams; result?: bigint }>;

export function classifyFailingRoutes(args: {
  publicClient: PublicClient | undefined;
  account: `0x${string}`;
  quote: { routes: Route[] };
  tokenIn: Token;
  tokenOut: Token;
  totalAmountIn: bigint;
  recipient: `0x${string}`;
  deadline: bigint;
  slippage: string;
}): Promise<{ key: string }[]>;

export function buildSwapCalldata(args: {
  routes: Route[];
  tokenIn: Token;
  tokenOut: Token;
  totalAmountIn: bigint;
  totalAmountOutMin: bigint;
  recipient: `0x${string}`;
}): {
  commands: `0x${string}`;
  inputs: readonly `0x${string}`[];
  value: bigint;
};
