/**
 * Uniswap V3 position math: the parts of TickMath and LiquidityAmounts a liquidity form needs, on
 * BigInt so the numbers are the contract's own. Prices here are always the pool's native
 * orientation — token1 per token0 — in human units; flipping for display is the caller's business.
 */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
// 1.0001^(2^i) as Q128 reciprocals, i = 1..19 — the constants of TickMath.getSqrtRatioAtTick.
const TICK_FACTORS = [
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/** sqrt(1.0001^tick) as a Q64.96, exactly as the pool computes it. */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`Tick out of range: ${tick}`);
  const abs = BigInt(Math.abs(tick));
  let ratio = abs & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  TICK_FACTORS.forEach((factor, index) => {
    if (abs & (2n << BigInt(index))) ratio = (ratio * factor) >> 128n;
  });
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Closest tick the pool accepts for a position boundary, kept inside the usable range. */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
  const lowest = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const highest = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  const rounded = Math.round(tick / tickSpacing) * tickSpacing;
  // Math.round can return -0, which would print as "-0" in a tick field.
  return Math.min(highest, Math.max(lowest, rounded)) + 0;
}

/** Widest range a pool with this spacing can hold. */
export function fullRangeTicks(tickSpacing: number): [number, number] {
  return [Math.ceil(MIN_TICK / tickSpacing) * tickSpacing, Math.floor(MAX_TICK / tickSpacing) * tickSpacing];
}

/** token1 per token0, in human units. */
export function priceAtTick(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}

/** Inverse of `priceAtTick`, unrounded to spacing. A float log is plenty: the result gets snapped. */
export function tickAtPrice(price: number, decimals0: number, decimals1: number): number {
  if (!(price > 0)) return MIN_TICK;
  const tick = Math.floor(Math.log(price / 10 ** (decimals0 - decimals1)) / Math.log(1.0001));
  return Math.min(MAX_TICK, Math.max(MIN_TICK, tick));
}

export function priceAtSqrtRatio(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}

const sorted = (a: bigint, b: bigint): [bigint, bigint] => (a > b ? [b, a] : [a, b]);

function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [low, high] = sorted(sqrtA, sqrtB);
  if (high === low) return 0n;
  return (amount0 * ((low * high) / Q96)) / (high - low);
}

function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [low, high] = sorted(sqrtA, sqrtB);
  if (high === low) return 0n;
  return (amount1 * Q96) / (high - low);
}

/** Largest liquidity the two amounts can fund at this price — LiquidityAmounts.getLiquidityForAmounts. */
export function liquidityForAmounts(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint): bigint {
  const [low, high] = sorted(sqrtA, sqrtB);
  if (sqrtPrice <= low) return liquidityForAmount0(low, high, amount0);
  if (sqrtPrice >= high) return liquidityForAmount1(low, high, amount1);
  const from0 = liquidityForAmount0(sqrtPrice, high, amount0);
  const from1 = liquidityForAmount1(low, sqrtPrice, amount1);
  return from0 < from1 ? from0 : from1;
}

/**
 * What a position of this liquidity holds at this price. Rounded down, i.e. what a withdrawal pays;
 * a deposit of the same liquidity costs up to one unit more of each.
 */
export function amountsForLiquidity(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const [low, high] = sorted(sqrtA, sqrtB);
  const amount0Between = (from: bigint, to: bigint) => (((liquidity << 96n) * (to - from)) / to) / from;
  const amount1Between = (from: bigint, to: bigint) => (liquidity * (to - from)) / Q96;
  if (sqrtPrice <= low) return { amount0: amount0Between(low, high), amount1: 0n };
  if (sqrtPrice >= high) return { amount0: 0n, amount1: amount1Between(low, high) };
  return { amount0: amount0Between(sqrtPrice, high), amount1: amount1Between(low, sqrtPrice) };
}

/** Which side(s) a range needs at this price: token0 only above it, token1 only below it. */
export function rangeSides(tick: number, tickLower: number, tickUpper: number): { needs0: boolean; needs1: boolean } {
  return { needs0: tick < tickUpper, needs1: tick >= tickLower };
}
