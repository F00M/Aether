import type { Quote, Token } from "@/swap/types";

/**
 * Hand-written types for the ported (plain JS) quote hook. Without this,
 * TypeScript infers `never[]` from the `blockedRouteKeys = []` default and the
 * returned quote comes back as `any`.
 */

export type UseQuoteArgs = {
  tokenIn: Token;
  tokenOut: Token;
  amountIn: string;
  slippage: string;
  swapper?: `0x${string}`;
  blockedRouteKeys?: string[];
};

export type UseQuoteResult = {
  quote: Quote | null;
  loading: boolean;
  error: string | null;
  refresh: (options?: { keepCache?: boolean }) => void;
};

export function useQuote(args: UseQuoteArgs): UseQuoteResult;

export function withDeadRouteKeys(tokenIn: Token, tokenOut: Token, keys?: string[]): string[];
export function invalidateQuoteCache(): void;
export function isEthWethPair(tokenIn: Token, tokenOut: Token): boolean;
export function routeExecutionKey(route: unknown): string;
export function resolveAddress(token: Token): `0x${string}`;
export function resolveCurrency(token: Token): `0x${string}`;

export const POSITION_MANAGER: `0x${string}`;
export const UNISWAP_API_ROUTER: `0x${string}`;
export const UNIVERSAL_ROUTER: `0x${string}`;
