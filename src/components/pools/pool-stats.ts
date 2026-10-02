import { formatUnits } from "viem";

import { currentPrice, type Orientation } from "@/components/pools/pool-format";
import type { Pool } from "@/swap/liquidity";
import type { PoolHistory, PoolTrade } from "@/swap/poolData";

/**
 * A pool's headline numbers, all in its quote token. There is no price feed on Sepolia worth
 * converting to dollars with; the pool's own price is the only honest unit.
 */
export type PoolSummary = {
  /** Everything the pool holds, valued in the quote token at the pool's price. */
  tvl: number;
  volume24h: number;
  /** What liquidity providers earned: the fee tier's cut of the volume. */
  fees24h: number;
  trades24h: number;
  /** A day's fees over the value locked, annualised. Null for an empty pool. */
  apr: number | null;
};

/** The quote-token side of a trade. */
const quoteVolume = (trade: PoolTrade, { inverted }: Orientation) => (inverted ? trade.volume0 : trade.volume1);
/** A trade's price as shown: quote per base. */
const shownPrice = (trade: PoolTrade, { inverted }: Orientation) => (inverted ? 1 / trade.price : trade.price);

export function summarize(pool: Pool, orientation: Orientation, history: PoolHistory | undefined): PoolSummary | null {
  const price = currentPrice(pool, orientation);
  const balance0 = Number(formatUnits(pool.balance0, pool.token0.decimals));
  const balance1 = Number(formatUnits(pool.balance1, pool.token1.decimals));
  const tvl = orientation.inverted ? balance0 + balance1 * price : balance1 + balance0 * price;
  if (!history) return null;

  const since = history.to - 86_400;
  const day = history.trades.filter((trade) => trade.time >= since);
  const volume24h = day.reduce((sum, trade) => sum + quoteVolume(trade, orientation), 0);
  // The fee is a share of what is paid in, in hundredths of a basis point.
  const fees24h = (volume24h * pool.fee) / 1_000_000;
  return { tvl, volume24h, fees24h, trades24h: day.length, apr: tvl > 0 ? ((fees24h * 365) / tvl) * 100 : null };
}

export const CHART_RANGES = [
  { id: "24h", label: "24H", seconds: 86_400, buckets: 48 },
  { id: "7d", label: "7D", seconds: 7 * 86_400, buckets: 56 },
  { id: "30d", label: "30D", seconds: 30 * 86_400, buckets: 60 },
] as const;
export type ChartRangeId = (typeof CHART_RANGES)[number]["id"];

export type ChartBucket = {
  /** Unix seconds. */
  start: number;
  end: number;
  /** The price at the bucket's end; null before the first trade the history knows of. */
  price: number | null;
  /** Quote token traded inside the bucket. */
  volume: number;
  trades: number;
};

/**
 * The history cut into equal stretches of time. A stretch with no trade keeps the price of the
 * one before it — the price didn't move — and the last one ends at the pool's price now.
 */
export function bucketize(pool: Pool, orientation: Orientation, history: PoolHistory, rangeId: ChartRangeId): ChartBucket[] {
  const range = CHART_RANGES.find((entry) => entry.id === rangeId)!;
  const width = range.seconds / range.buckets;
  const begin = history.to - range.seconds;
  const buckets: ChartBucket[] = Array.from({ length: range.buckets }, (_, index) => ({
    start: begin + index * width,
    end: begin + (index + 1) * width,
    price: null,
    volume: 0,
    trades: 0,
  }));

  let last: number | null = null;
  let cursor = 0;
  for (const bucket of buckets) {
    while (cursor < history.trades.length && history.trades[cursor].time < bucket.end) {
      const trade = history.trades[cursor++];
      last = shownPrice(trade, orientation);
      if (trade.time >= bucket.start) {
        bucket.volume += quoteVolume(trade, orientation);
        bucket.trades += 1;
      }
    }
    bucket.price = last;
  }
  buckets[buckets.length - 1].price = currentPrice(pool, orientation);
  return buckets;
}
