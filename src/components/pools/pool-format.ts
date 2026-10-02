import { formatUnits } from "viem";

import { TOKENS } from "@/config/tokens";
import { compact, formatAmount } from "@/lib/format";
import type { Pool } from "@/swap/liquidity";
import { WETH } from "@/swap/quoteConfig";
import type { Token } from "@/swap/types";
import { MAX_TICK, MIN_TICK, priceAtSqrtRatio, priceAtTick, tickAtPrice } from "@/swap/v3Math";

const USDC = (TOKENS as Token[]).find((token) => token.symbol === "USDC");

/**
 * A pool stores its price as token1 per token0, whichever way the addresses happen to sort. People
 * read "1 WETH = 31,304 USDC", so prices are shown in the more money-like of the two tokens.
 */
export type Orientation = {
  /** The token being priced. */
  base: Token;
  /** The token the price is in. */
  quote: Token;
  /** True when the shown price is the reciprocal of the pool's own. */
  inverted: boolean;
};

const sameAddress = (token: Token, address: string | undefined) => !!address && token.address.toLowerCase() === address.toLowerCase();

export function orientationOf(pool: Pool): Orientation {
  // By address: an unlisted token calling itself "USDC" gets no special treatment.
  const rank = (token: Token) => (sameAddress(token, USDC?.address) ? 2 : sameAddress(token, WETH) ? 1 : 0);
  const quoteIs0 = rank(pool.token0) > rank(pool.token1);
  return quoteIs0
    ? { base: pool.token1, quote: pool.token0, inverted: true }
    : { base: pool.token0, quote: pool.token1, inverted: false };
}

/** The pool's current price, in quote per base. */
export function currentPrice(pool: Pool, { inverted }: Orientation): number {
  const native = priceAtSqrtRatio(pool.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
  return inverted ? 1 / native : native;
}

/**
 * How the pool's holdings split between its two tokens by value, at the pool's own price: the
 * base token's share, 0 to 1. Null for a pool that holds nothing.
 */
export function baseShare(pool: Pool, { inverted }: Orientation): number | null {
  const native = priceAtSqrtRatio(pool.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
  // Both sides in token1: token0's balance at the price, token1's as it is.
  const value0 = Number(formatUnits(pool.balance0, pool.token0.decimals)) * native;
  const value1 = Number(formatUnits(pool.balance1, pool.token1.decimals));
  const total = value0 + value1;
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return inverted ? value1 / total : value0 / total;
}

/** A tick as a shown price. */
export function shownPriceAtTick(pool: Pool, { inverted }: Orientation, tick: number): number {
  const native = priceAtTick(tick, pool.token0.decimals, pool.token1.decimals);
  return inverted ? 1 / native : native;
}

/** A shown price as a tick, not yet snapped to the pool's spacing. */
export function tickAtShownPrice(pool: Pool, { inverted }: Orientation, price: number): number {
  if (!(price > 0)) return inverted ? MAX_TICK : MIN_TICK;
  return tickAtPrice(inverted ? 1 / price : price, pool.token0.decimals, pool.token1.decimals);
}

/**
 * A position's range as [low, high] shown prices. Inverting a price flips the order, so the lower
 * tick is the upper shown bound of an inverted pool.
 */
export function shownRange(pool: Pool, orientation: Orientation, tickLower: number, tickUpper: number): [number, number] {
  const a = shownPriceAtTick(pool, orientation, tickLower);
  const b = shownPriceAtTick(pool, orientation, tickUpper);
  return a < b ? [a, b] : [b, a];
}

/** True for a range that spans every usable tick of the pool. */
export function isFullRange(pool: Pool, tickLower: number, tickUpper: number): boolean {
  return tickLower <= Math.ceil(MIN_TICK / pool.tickSpacing) * pool.tickSpacing && tickUpper >= Math.floor(MAX_TICK / pool.tickSpacing) * pool.tickSpacing;
}

export function formatPriceValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1e15) return "∞";
  if (value >= 1e9) return compact(value);
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  // Small prices keep four significant digits instead of rounding away to zero.
  return Number(value.toPrecision(4)).toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  const value = Number(formatUnits(amount, decimals));
  if (value >= 1e15) return value.toExponential(2);
  if (value >= 1e6) return compact(value);
  return formatAmount(value);
}

export const feeLabel = (fee: number) => `${fee / 10_000}%`;
/** Tokens outside the app's list are named by whoever deployed them; show which contract it is. */
export const isListed = (token: Token) => (TOKENS as Token[]).some((entry) => sameAddress(entry, token.address));
