import type { ApiQuote, Route, Token } from "./types";

/** Hand-written types for the ported (plain JS) routing engine. */

export const API_QUOTE_REFRESH_AGE_MS: number;
export const API_SANITY_MAX_LOCAL_BPS: bigint;
export const POSITION_MANAGER: `0x${string}`;
export const UNISWAP_API_ROUTER: `0x${string}`;
export const UNIVERSAL_ROUTER: `0x${string}`;

export function invalidateQuoteCache(): void;

export function isEthWethPair(tokenIn: Token, tokenOut: Token): boolean;
export function routeExecutionKey(route: Route): string;
export function tokenByAddress(address: string): Token | undefined;
export function resolveAddress(token: Token): `0x${string}`;
export function resolveCurrency(token: Token): `0x${string}`;

export function fetchUniswapApiQuote(args: {
  tokenIn: Token;
  tokenOut: Token;
  amountRaw: string;
  slippage: string;
  swapper?: `0x${string}`;
}): Promise<ApiQuote | null>;

export function fetchUniswapApiSwap(apiRaw: unknown): Promise<{
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}>;

export type SplitResult = {
  routes: Route[];
  totalAmountOut: bigint;
  totalAmountIn?: string;
  priceImpact?: number;
  splitMode?: string;
  balancedRejected?: boolean;
};

export function findSplitRoutes(
  tokenIn: Token,
  tokenOut: Token,
  amountRaw: string,
  options?: { fast?: boolean; blockedRouteKeys?: string[]; enableMixed?: boolean },
): Promise<SplitResult | null>;
