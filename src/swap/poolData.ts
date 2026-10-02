import { formatUnits, toEventSelector } from "viem";

import { POOL_ABI, type Pool } from "./liquidity";
import { client, fetchRawLogs, getLatestBlockNumber } from "./quoteProviders";
import { MAX_TICK, MIN_TICK, priceAtSqrtRatio } from "./v3Math";

/**
 * What a pool's own page shows beyond its current state: where its liquidity sits across prices,
 * and what has been traded through it. Both are read straight from the pool contract and its
 * `Swap` events — there is no indexer or price feed behind any of it.
 */

// ------------------------------------------------------------------ liquidity across prices

/** Liquidity that is active while the price is inside [tickLower, tickUpper). */
export type LiquiditySegment = { tickLower: number; tickUpper: number; liquidity: bigint };
export type LiquidityProfile = {
  /** Ascending and contiguous from `fromTick` to `toTick`. */
  segments: LiquiditySegment[];
  fromTick: number;
  toTick: number;
};

// How far either side of the price the profile reaches: a factor of 8 in price.
const PROFILE_REACH_TICKS = Math.round(Math.log(8) / Math.log(1.0001));
// A bitmap word covers 256 tick spacings; past this many the read isn't worth its size.
const MAX_BITMAP_WORDS = 240;
const MAX_INITIALIZED_TICKS = 500;
// viem splits a multicall into requests of about 1 KB of calldata by default — hundreds of tick
// reads would become dozens of requests. These are cheap reads; a few large requests serve better.
const MULTICALL_BYTES = 16_384;

/**
 * Active liquidity at every price around the current one. The pool keeps, per initialized tick,
 * the liquidity that switches on (or off) when the price crosses it; walking those outward from
 * the current tick, starting from the liquidity in range now, rebuilds the whole curve.
 */
export async function loadLiquidityProfile(pool: Pool): Promise<LiquidityProfile> {
  const spacing = pool.tickSpacing;
  const compressed = (tick: number) => Math.floor(tick / spacing);
  let fromTick = Math.max(MIN_TICK, pool.tick - PROFILE_REACH_TICKS);
  let toTick = Math.min(MAX_TICK, pool.tick + PROFILE_REACH_TICKS);

  let firstWord = compressed(fromTick) >> 8;
  let lastWord = compressed(toTick) >> 8;
  if (lastWord - firstWord + 1 > MAX_BITMAP_WORDS) {
    // A pool with a spacing of 1: keep the words nearest the price and shorten the reach to match.
    const centre = compressed(pool.tick) >> 8;
    firstWord = centre - MAX_BITMAP_WORDS / 2;
    lastWord = centre + MAX_BITMAP_WORDS / 2 - 1;
    fromTick = Math.max(fromTick, (firstWord << 8) * spacing);
    toTick = Math.min(toTick, (((lastWord + 1) << 8) - 1) * spacing);
  }
  const words = Array.from({ length: lastWord - firstWord + 1 }, (_, index) => firstWord + index);
  const bitmaps = (await client.multicall({
    allowFailure: false,
    batchSize: MULTICALL_BYTES,
    contracts: words.map((word) => ({ address: pool.address, abi: POOL_ABI, functionName: "tickBitmap", args: [word] }) as const),
  })) as bigint[];

  let initialized: number[] = [];
  bitmaps.forEach((bitmap, index) => {
    if (bitmap === 0n) return;
    for (let bit = 0; bit < 256; bit++) {
      if ((bitmap >> BigInt(bit)) & 1n) {
        const tick = (words[index] * 256 + bit) * spacing;
        if (tick >= fromTick && tick <= toTick) initialized.push(tick);
      }
    }
  });
  if (initialized.length > MAX_INITIALIZED_TICKS) {
    // Keep the ticks nearest the price; the curve is only known as far as the furthest one kept.
    initialized = initialized.sort((a, b) => Math.abs(a - pool.tick) - Math.abs(b - pool.tick)).slice(0, MAX_INITIALIZED_TICKS);
    fromTick = Math.max(fromTick, Math.min(...initialized));
    toTick = Math.min(toTick, Math.max(...initialized));
  }
  initialized.sort((a, b) => a - b);

  const details = initialized.length
    ? await client.multicall({
        allowFailure: false,
        batchSize: MULTICALL_BYTES,
        contracts: initialized.map((tick) => ({ address: pool.address, abi: POOL_ABI, functionName: "ticks", args: [tick] }) as const),
      })
    : [];
  const net = new Map(initialized.map((tick, index) => [tick, (details[index] as readonly [bigint, bigint, ...unknown[]])[1]]));
  const atLeastZero = (value: bigint) => (value > 0n ? value : 0n);

  // Upward from the current tick: crossing a tick adds its net liquidity.
  const above: LiquiditySegment[] = [];
  let liquidity = pool.liquidity;
  let edge = pool.tick;
  for (const tick of initialized) {
    if (tick <= pool.tick) continue;
    above.push({ tickLower: edge, tickUpper: tick, liquidity: atLeastZero(liquidity) });
    liquidity += net.get(tick)!;
    edge = tick;
  }
  if (edge < toTick) above.push({ tickLower: edge, tickUpper: toTick, liquidity: atLeastZero(liquidity) });

  // Downward: crossing a tick removes it.
  const below: LiquiditySegment[] = [];
  liquidity = pool.liquidity;
  edge = pool.tick;
  for (const tick of [...initialized].reverse()) {
    if (tick > pool.tick) continue;
    if (tick < edge) below.push({ tickLower: tick, tickUpper: edge, liquidity: atLeastZero(liquidity) });
    liquidity -= net.get(tick)!;
    edge = tick;
  }
  if (edge > fromTick) below.push({ tickLower: fromTick, tickUpper: edge, liquidity: atLeastZero(liquidity) });

  return { segments: [...below.reverse(), ...above], fromTick, toTick };
}

/** The active liquidity at a tick, from a profile. */
export function liquidityAt(profile: LiquidityProfile, tick: number): bigint {
  // Segments are few (one per initialized tick), so a scan is plenty.
  for (const segment of profile.segments) if (tick >= segment.tickLower && tick < segment.tickUpper) return segment.liquidity;
  return 0n;
}

// ------------------------------------------------------------------ what was traded

export type PoolTrade = {
  /** Unix seconds. */
  time: number;
  /** The pool's price after the trade: token1 per token0, in human units. */
  price: number;
  /** How much of each token changed hands, unsigned, in human units. */
  volume0: number;
  volume1: number;
};

export type PoolHistory = {
  /** Oldest first. */
  trades: PoolTrade[];
  /** Unix seconds: the stretch the trades cover. */
  from: number;
  to: number;
  /** False when part of the range could not be read; totals are then low, not wrong. */
  complete: boolean;
};

const SWAP_TOPIC = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");
const BLOCKS_PER_DAY = 7_200n;
const HISTORY_WINDOW = 50_000n;
const HISTORY_MIN_WINDOW = 5_000n;
// A window that comes back this full has probably been cut off by the endpoint.
const TRUNCATION_SUSPECT = 9_500;
const WORD = 64;

type RawLog = { data: string; blockNumber: string; blockTimestamp?: string };

async function scanTrades(address: `0x${string}`, fromBlock: bigint, toBlock: bigint): Promise<{ logs: RawLog[]; complete: boolean }> {
  const result = (await fetchRawLogs({ address, topic0: SWAP_TOPIC, fromBlock, toBlock })) as { logs: RawLog[]; complete: boolean };
  const span = toBlock - fromBlock;
  if (result.logs.length < TRUNCATION_SUSPECT) return result;
  if (span <= HISTORY_MIN_WINDOW) return { logs: result.logs, complete: false };
  const middle = fromBlock + span / 2n;
  const [left, right] = await Promise.all([scanTrades(address, fromBlock, middle), scanTrades(address, middle + 1n, toBlock)]);
  return { logs: [...left.logs, ...right.logs], complete: left.complete && right.complete };
}

/** The pool's trades over the last `days`, read from its Swap events. */
export async function loadPoolHistory(pool: Pool, days = 30): Promise<PoolHistory> {
  const head: bigint = await getLatestBlockNumber();
  if (head === 0n) throw new Error("Could not reach an RPC endpoint");
  const reach = BigInt(days) * BLOCKS_PER_DAY;
  const start = head > reach ? head - reach : 0n;

  const windows: [bigint, bigint][] = [];
  for (let from = start; from <= head; from += HISTORY_WINDOW) windows.push([from, from + HISTORY_WINDOW - 1n < head ? from + HISTORY_WINDOW - 1n : head]);
  const [parts, first, last] = await Promise.all([
    Promise.all(windows.map(([from, to]) => scanTrades(pool.address, from, to))),
    client.getBlock({ blockNumber: start }).catch(() => null),
    client.getBlock({ blockNumber: head }).catch(() => null),
  ]);

  const to = last ? Number(last.timestamp) : Math.floor(Date.now() / 1000);
  const from = first ? Number(first.timestamp) : to - days * 86_400;
  // Not every endpoint stamps a log with its block's time; between two known blocks the block
  // number places it to within a few minutes, which is finer than any bucket on the chart.
  const timeOf = (log: RawLog) =>
    log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : Math.round(from + ((to - from) * Number(BigInt(log.blockNumber) - start)) / Math.max(1, Number(head - start)));
  const signed = (word: string) => BigInt.asIntN(256, BigInt(`0x${word}`));
  const magnitude = (value: bigint, decimals: number) => Number(formatUnits(value < 0n ? -value : value, decimals));

  const trades: PoolTrade[] = [];
  for (const log of parts.flatMap((part) => part.logs)) {
    // amount0, amount1, sqrtPriceX96, liquidity, tick — one 32-byte word each.
    if (!log?.data || log.data.length < 2 + 5 * WORD) continue;
    const word = (index: number) => log.data.slice(2 + index * WORD, 2 + (index + 1) * WORD);
    trades.push({
      time: timeOf(log),
      price: priceAtSqrtRatio(BigInt(`0x${word(2)}`), pool.token0.decimals, pool.token1.decimals),
      volume0: magnitude(signed(word(0)), pool.token0.decimals),
      volume1: magnitude(signed(word(1)), pool.token1.decimals),
    });
  }
  trades.sort((a, b) => a.time - b.time);
  return { trades, from, to, complete: parts.every((part) => part.complete) };
}
