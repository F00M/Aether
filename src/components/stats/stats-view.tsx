"use client";

import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";

import { ColumnChart, ColumnTable, type ColumnDatum } from "@/components/stats/column-chart";
import { Segmented } from "@/components/ui/segmented";
import { TokenIcon } from "@/components/ui/token-icon";
import { compact, formatAmount } from "@/lib/format";
import { statsQuery } from "@/lib/queries";
import { loadToken } from "@/swap/activity";
import { buildStats, type Stats } from "@/swap/stats";
import type { Token } from "@/swap/types";

const RANGES = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "all", label: "All time", days: null },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const REFRESH_MS = 60_000;
const TOP_PAIRS = 8;

const formatCount = (value: number) => value.toLocaleString("en-US");
/** Token amounts span 18 orders of magnitude here; past a million the digits stop mattering. */
function formatToken(amount: bigint, decimals: number): string {
  const value = Number(formatUnits(amount, decimals));
  if (value >= 1e15) return value.toExponential(2);
  if (value >= 1e6) return compact(value);
  return formatAmount(value);
}
/** Axis ticks are already clean numbers: 2500 → "2.5K", 5000 → "5K". */
const formatAxis = (value: number) =>
  value >= 1e6 ? `${+(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${+(value / 1e3).toFixed(1)}K` : String(+value.toFixed(4));
const formatDay = (ms: number, withYear = false) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });

export function StatsView() {
  const [range, setRange] = useState<RangeId>("30d");
  const rangeDays = RANGES.find((entry) => entry.id === range)!.days;

  const history = useQuery({
    ...statsQuery(),
    refetchInterval: REFRESH_MS,
  });

  // The range only re-slices what is already loaded, and `dataUpdatedAt` is the clock, so
  // switching it is instant and every number below comes from the same slice.
  const stats = useMemo(
    () => (history.data ? buildStats(history.data.swaps, { now: history.dataUpdatedAt, rangeDays }) : null),
    [history.data, history.dataUpdatedAt, rangeDays],
  );

  const tokenAddresses = useMemo(() => {
    if (!stats) return [];
    const addresses = [...stats.fees.map((fee) => fee.token), ...stats.pairs.slice(0, TOP_PAIRS).flatMap((pair) => pair.tokens)];
    return [...new Set(addresses.map((address) => address.toLowerCase()))].sort();
  }, [stats]);
  const tokens = useQuery({
    queryKey: ["aether-stats-tokens", tokenAddresses],
    queryFn: async () => new Map((await Promise.all(tokenAddresses.map(loadToken))).map((token, index) => [tokenAddresses[index], token])),
    enabled: tokenAddresses.length > 0,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
  const tokenOf = (address: string) => tokens.data?.get(address.toLowerCase());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Date range" value={range} onChange={setRange} options={RANGES.map((entry) => ({ value: entry.id, label: entry.label }))} />
        <button
          type="button"
          onClick={() => history.refetch()}
          disabled={history.isFetching}
          className="ml-auto h-8 rounded-lg px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-inset hover:text-ink disabled:opacity-60"
        >
          {history.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {history.isPending ? (
        <LoadingState />
      ) : !stats ? (
        <section className="rounded-card border border-line bg-surface px-5 py-12 text-center shadow-card">
          <p className="text-[14px] text-ink-2">The swap history could not be loaded from the RPC.</p>
          <button
            type="button"
            onClick={() => history.refetch()}
            className="mt-4 h-9 rounded-xl border border-line bg-surface px-4 text-[13px] font-medium text-ink transition-colors hover:bg-inset"
          >
            Try again
          </button>
        </section>
      ) : (
        <div className="animate-rise space-y-4">
          {history.data && !history.data.complete ? (
            <p className="rounded-field border border-warn/25 bg-warn/8 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warn">
              Part of the history could not be read from the RPC, so these totals may be low. It is
              retried automatically.
            </p>
          ) : null}
          <Totals stats={stats} tokenOf={tokenOf} />
          <Charts stats={stats} />
          <div className="grid gap-4 lg:grid-cols-2">
            <FeesTable stats={stats} tokenOf={tokenOf} />
            <PairsTable stats={stats} tokenOf={tokenOf} />
          </div>
          <p className="max-w-3xl text-[12.5px] leading-relaxed text-ink-3">
            Swaps routed through the Uniswap API or LI.FI are not counted here.
          </p>
        </div>
      )}
    </div>
  );
}

function Totals({ stats, tokenOf }: { stats: Stats; tokenOf: (address: string) => Token | undefined }) {
  const leadFee = stats.fees[0];
  const leadToken = leadFee ? tokenOf(leadFee.token) : undefined;
  const ethVolume = Number(formatUnits(stats.ethVolume, 18));

  return (
    <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Tile label="Swaps" value={formatCount(stats.swaps)} note="through the router" />
      <Tile label="Wallets" value={formatCount(stats.wallets)} note="distinct senders" />
      <Tile
        label="Volume"
        value={ethVolume >= 1e6 ? compact(ethVolume) : formatAmount(ethVolume)}
        unit="ETH"
        note="ETH side only"
      />
      <Tile
        label="Fees"
        value={leadFee ? (leadToken ? formatToken(leadFee.amount, leadToken.decimals) : "…") : "—"}
        unit={leadFee ? leadToken?.symbol : undefined}
        note={
          !leadFee
            ? "none in this range"
            : stats.fees.length > 1
              ? `plus ${stats.fees.length - 1} more ${stats.fees.length === 2 ? "token" : "tokens"}`
              : `from ${formatCount(leadFee.swaps)} ${leadFee.swaps === 1 ? "swap" : "swaps"}`
        }
      />
    </dl>
  );
}

function Tile({ label, value, unit, note }: { label: string; value: string; unit?: string; note: string }) {
  return (
    <div className="min-w-0 rounded-card border border-line bg-surface px-4 py-3.5 shadow-card">
      {/* The unit rides on the label's line: beside the figure it wrapped mid-word on a phone
          ("ET / H"), and the two tiles that have one stopped lining up with the two that don't. */}
      <dt className="flex items-baseline justify-between gap-2 whitespace-nowrap text-[12.5px] text-ink-2">
        {label}
        {unit ? <span className="truncate text-[12px] font-medium text-ink-3">{unit}</span> : null}
      </dt>
      {/* Proportional figures: tabular digits look loose at this size. */}
      <dd className="mt-1 truncate text-[24px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[26px]">{value}</dd>
      <dd className="mt-1 text-[12px] leading-snug text-ink-3">{note}</dd>
    </div>
  );
}

function Charts({ stats }: { stats: Stats }) {
  const weekly = stats.buckets.some((bucket) => bucket.days > 1);
  const per = weekly ? "week" : "day";
  const name = (start: number, days: number) =>
    days > 1 ? `Week of ${formatDay(start, true)}` : formatDay(start, true);

  const swaps: ColumnDatum[] = stats.buckets.map((bucket) => ({
    key: bucket.start,
    tick: formatDay(bucket.start),
    name: name(bucket.start, bucket.days),
    value: bucket.swaps,
    display: `${formatCount(bucket.swaps)} ${bucket.swaps === 1 ? "swap" : "swaps"}`,
  }));
  const volume: ColumnDatum[] = stats.buckets.map((bucket) => {
    const value = Number(formatUnits(bucket.ethVolume, 18));
    return {
      key: bucket.start,
      tick: formatDay(bucket.start),
      name: name(bucket.start, bucket.days),
      value,
      display: `${value >= 1e6 ? compact(value) : formatAmount(value)} ETH`,
    };
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard
        title={`Swaps per ${per}`}
        data={swaps}
        integer
        formatTick={formatAxis}
        columns={[weekly ? "Week" : "Day", "Swaps"]}
      />
      <ChartCard
        title={`Volume per ${per}, in ETH`}
        data={volume}
        formatTick={formatAxis}
        columns={[weekly ? "Week" : "Day", "Volume"]}
      />
    </div>
  );
}

function ChartCard({
  title,
  data,
  integer,
  formatTick,
  columns,
}: {
  title: string;
  data: ColumnDatum[];
  integer?: boolean;
  formatTick: (value: number) => string;
  columns: [string, string];
}) {
  const [asTable, setAsTable] = useState(false);
  const empty = data.every((datum) => datum.value === 0);

  return (
    <section className="rounded-card border border-line bg-surface px-4 pb-4 pt-3.5 shadow-card sm:px-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-medium text-ink">{title}</h2>
        <button
          type="button"
          aria-pressed={asTable}
          onClick={() => setAsTable((value) => !value)}
          className="h-7 rounded-lg px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-inset hover:text-ink"
        >
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {asTable ? (
        <ColumnTable data={data} columns={columns} />
      ) : (
        <div className="relative">
          <ColumnChart data={data} integer={integer} formatTick={formatTick} label={title} />
          {empty ? (
            <p className="pointer-events-none absolute inset-x-11 top-1/3 text-center text-[12.5px] text-ink-3">
              Nothing in this range
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function FeesTable({ stats, tokenOf }: { stats: Stats; tokenOf: (address: string) => Token | undefined }) {
  return (
    <section className="rounded-card border border-line bg-surface px-4 pb-3 pt-3.5 shadow-card sm:px-5">
      <h2 className="text-[14px] font-medium text-ink">Protocol fees collected</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
        Taken in the output token; an ETH payout is charged in WETH.
      </p>
      {stats.fees.length ? (
        <table className="mt-3 w-full text-[13px]">
          <thead className="text-left text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-3">
            <tr>
              <th scope="col" className="pb-1.5 font-medium">
                Token
              </th>
              <th scope="col" className="pb-1.5 text-right font-medium">
                Collected
              </th>
              <th scope="col" className="pb-1.5 text-right font-medium">
                Swaps
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.fees.map((fee) => {
              const token = tokenOf(fee.token);
              return (
                <tr key={fee.token} className="border-t border-line">
                  <th scope="row" className="py-2 text-left font-normal">
                    <TokenLabel token={token} />
                  </th>
                  <td className="nums py-2 text-right text-ink">{token ? formatToken(fee.amount, token.decimals) : "…"}</td>
                  <td className="nums py-2 text-right text-ink-2">{formatCount(fee.swaps)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="mt-4 pb-2 text-[13px] text-ink-2">No protocol fee was charged in this range.</p>
      )}
    </section>
  );
}

function PairsTable({ stats, tokenOf }: { stats: Stats; tokenOf: (address: string) => Token | undefined }) {
  const top = stats.pairs.slice(0, TOP_PAIRS);
  return (
    <section className="rounded-card border border-line bg-surface px-4 pb-3 pt-3.5 shadow-card sm:px-5">
      <h2 className="text-[14px] font-medium text-ink">Most traded pairs</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
        Either direction; ETH counts as WETH.
      </p>
      {top.length ? (
        // Fixed layout: the pair column takes what the other two leave and cuts a long name short,
        // instead of every row wrapping differently on a phone.
        <table className="mt-3 w-full table-fixed text-[13px]">
          <thead className="text-left text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-3">
            <tr>
              <th scope="col" className="pb-1.5 font-medium">
                Pair
              </th>
              <th scope="col" className="w-14 pb-1.5 text-right font-medium">
                Swaps
              </th>
              {/* On a phone the share is its number alone; the bar comes back when there is room. */}
              <th scope="col" className="w-16 pb-1.5 pl-4 text-right font-medium sm:w-[38%] sm:text-left">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {top.map((pair) => {
              const share = stats.swaps ? (pair.swaps / stats.swaps) * 100 : 0;
              return (
                <tr key={pair.tokens.join("/")} className="border-t border-line">
                  <th scope="row" className="py-2 text-left font-normal">
                    <PairLabel first={tokenOf(pair.tokens[0])} second={tokenOf(pair.tokens[1])} />
                  </th>
                  <td className="nums py-2 text-right text-ink">{formatCount(pair.swaps)}</td>
                  <td className="py-2 pl-4">
                    <span className="flex items-center justify-end gap-2">
                      {/* A meter: the track is a lighter step of the fill's own colour. */}
                      <span className="hidden h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-accent-wash sm:block" aria-hidden="true">
                        <span className="block h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
                      </span>
                      <span className="nums w-11 shrink-0 text-right text-[12px] text-ink-2">{share.toFixed(1)}%</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="mt-4 pb-2 text-[13px] text-ink-2">No swaps in this range.</p>
      )}
    </section>
  );
}

/** Two overlapping icons and "A / B" on a single line. */
function PairLabel({ first, second }: { first: Token | undefined; second: Token | undefined }) {
  if (!first || !second) return <span className="skeleton inline-block h-4 w-28 rounded align-middle" />;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 items-center">
        <TokenIcon token={first} size="sm" />
        <TokenIcon token={second} size="sm" className="-ml-1.5 rounded-full ring-2 ring-surface" />
      </span>
      <span className="truncate text-ink">
        {first.symbol} <span className="text-ink-3">/</span> {second.symbol}
      </span>
    </span>
  );
}

function TokenLabel({ token }: { token: Token | undefined }) {
  if (!token) return <span className="skeleton inline-block h-4 w-16 rounded align-middle" />;
  return (
    <span className="inline-flex items-center gap-1.5">
      <TokenIcon token={token} size="sm" />
      <span className="text-ink">{token.symbol}</span>
    </span>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading stats">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-card border border-line bg-surface px-4 py-3.5 shadow-card">
            <span className="skeleton block h-3.5 w-16 rounded" />
            <span className="skeleton mt-2.5 block h-7 w-24 rounded" />
            <span className="skeleton mt-2.5 block h-3 w-28 rounded" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="skeleton h-[250px] rounded-card" />
        ))}
      </div>
    </div>
  );
}
