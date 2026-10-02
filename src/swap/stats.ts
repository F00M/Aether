import type { SwapRecord } from "./activity";
import { WETH } from "./quoteConfig";

/**
 * Totals over the diamond's swap history. Pure: the same swaps and clock give the same numbers, so
 * the page can recompute per date range without another RPC round.
 *
 * There is no price feed on Sepolia worth trusting, so nothing here is converted to dollars.
 * Volume is counted in ETH for the swaps that have ETH or WETH on one side (the router records
 * both as WETH); the rest are counted as swaps but not as volume, and the share is reported.
 */
export type StatsBucket = {
  /** Local midnight that opens the bucket, in ms. */
  start: number;
  /** How many days the bucket spans (1, or 7 on long ranges). */
  days: number;
  swaps: number;
  /** ETH-side volume in wei. */
  ethVolume: bigint;
};

export type TokenTotal = { token: `0x${string}`; amount: bigint; swaps: number };
export type PairTotal = { tokens: [`0x${string}`, `0x${string}`]; swaps: number };

export type Stats = {
  swaps: number;
  wallets: number;
  ethVolume: bigint;
  /** Swaps with an ETH/WETH side, i.e. the ones `ethVolume` is made of. */
  ethSwaps: number;
  feeSwaps: number;
  /** Protocol fees by the token they were taken in, largest count first. */
  fees: TokenTotal[];
  /** Most traded pairs regardless of direction. */
  pairs: PairTotal[];
  buckets: StatsBucket[];
};

const DAY_MS = 86_400_000;
// Past this many daily columns they stop being readable; group by week instead.
const MAX_DAILY_BUCKETS = 60;

const startOfLocalDay = (ms: number) => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** ETH-side size of a swap in wei, or null when neither side is ETH/WETH. */
function ethSide(swap: SwapRecord, weth: string): bigint | null {
  if (swap.tokenIn.toLowerCase() === weth) return swap.amountIn;
  // amountOut is what the recipient got; the fee came out of the same output.
  if (swap.tokenOut.toLowerCase() === weth) return swap.amountOut + swap.feeAmount;
  return null;
}

/**
 * @param rangeDays Only swaps from the last N days (by local calendar day, today included); null
 *   for the whole history.
 */
export function buildStats(swaps: SwapRecord[], { now, rangeDays }: { now: number; rangeDays: number | null }): Stats {
  const weth = WETH.toLowerCase();
  const today = startOfLocalDay(now);
  const dated = swaps.filter((swap) => swap.timestamp != null);
  const oldest = dated.reduce((min, swap) => Math.min(min, swap.timestamp! * 1000), now);
  const rangeStart = rangeDays == null ? startOfLocalDay(oldest) : today - (rangeDays - 1) * DAY_MS;
  // An undated swap can't be placed in a range, so it only counts toward the whole history.
  const inRange = rangeDays == null ? swaps : dated.filter((swap) => swap.timestamp! * 1000 >= rangeStart);

  const totalDays = Math.max(1, Math.round((today - rangeStart) / DAY_MS) + 1);
  const span = totalDays > MAX_DAILY_BUCKETS ? 7 : 1;
  const buckets: StatsBucket[] = [];
  for (let day = 0; day < totalDays; day += span) {
    // Calendar arithmetic, not +24h: a daylight-saving day is not 86,400s long.
    const start = new Date(rangeStart);
    start.setDate(start.getDate() + day);
    buckets.push({ start: start.getTime(), days: Math.min(span, totalDays - day), swaps: 0, ethVolume: 0n });
  }

  const wallets = new Set<string>();
  const fees = new Map<string, TokenTotal>();
  const pairs = new Map<string, PairTotal>();
  let ethVolume = 0n;
  let ethSwaps = 0;
  let feeSwaps = 0;

  for (const swap of inRange) {
    wallets.add(swap.sender.toLowerCase());
    const eth = ethSide(swap, weth);
    if (eth != null) {
      ethVolume += eth;
      ethSwaps++;
    }

    if (swap.feeAmount > 0n) {
      feeSwaps++;
      const key = swap.tokenOut.toLowerCase();
      const total = fees.get(key) ?? { token: swap.tokenOut, amount: 0n, swaps: 0 };
      total.amount += swap.feeAmount;
      total.swaps++;
      fees.set(key, total);
    }

    const [a, b] = [swap.tokenIn, swap.tokenOut].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
    const pairKey = `${a}/${b}`.toLowerCase();
    const pair = pairs.get(pairKey) ?? { tokens: [a, b], swaps: 0 };
    pair.swaps++;
    pairs.set(pairKey, pair);

    if (swap.timestamp != null) {
      const at = swap.timestamp * 1000;
      // Buckets are few; the last one that starts at or before the swap is its bucket.
      for (let index = buckets.length - 1; index >= 0; index--) {
        if (at >= buckets[index].start) {
          buckets[index].swaps++;
          if (eth != null) buckets[index].ethVolume += eth;
          break;
        }
      }
    }
  }

  return {
    swaps: inRange.length,
    wallets: wallets.size,
    ethVolume,
    ethSwaps,
    feeSwaps,
    fees: [...fees.values()].sort((x, y) => y.swaps - x.swaps),
    pairs: [...pairs.values()].sort((x, y) => y.swaps - x.swaps),
    buckets,
  };
}
