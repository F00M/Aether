"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import { AddLiquidityForm } from "@/components/pools/add-liquidity-form";
import { currentPrice, feeLabel, formatPriceValue, formatTokenAmount, orientationOf } from "@/components/pools/pool-format";
import { Notice, PairIcons, PositionCard, TokenName, card, outlineButton, stagger } from "@/components/pools/pool-parts";
import { CHART_RANGES, bucketize, summarize, type ChartRangeId } from "@/components/pools/pool-stats";
import { PriceChart } from "@/components/pools/price-chart";
import { RemoveLiquidityModal } from "@/components/pools/remove-liquidity-modal";
import { Segmented } from "@/components/ui/segmented";
import { compact, formatAmount, shortenAddress } from "@/lib/format";
import { poolQuery, positionsQuery } from "@/lib/queries";
import type { Pool, Position } from "@/swap/liquidity";
import { loadLiquidityProfile, loadPoolHistory } from "@/swap/poolData";

const EXPLORER = "https://sepolia.etherscan.io";
const POOL_REFRESH_MS = 30_000;
const PROFILE_REFRESH_MS = 60_000;
// Thirty days of events is the heaviest read on the page; the 24h figures don't need it by the second.
const HISTORY_REFRESH_MS = 5 * 60_000;

type Dialog = { kind: "remove" | "collect"; position: Position } | null;

/** A headline amount: no more digits than the size of the number can use. */
const formatFigure = (value: number) =>
  value >= 1e6 ? compact(value) : value >= 100 ? value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : value >= 1 ? value.toFixed(2) : formatAmount(value, 6);

export function PoolView({ address }: { address: `0x${string}` }) {
  const pool = useQuery({ ...poolQuery(address), refetchInterval: POOL_REFRESH_MS, retry: 1 });

  if (pool.isPending) return <PoolSkeleton />;
  if (!pool.data) {
    return (
      <Notice
        text={pool.error?.message === "Not a Uniswap V3 pool" ? "There is no Uniswap V3 pool at this address." : "The pool could not be loaded from the RPC."}
        action={
          <Link href="/pools" className={`${outlineButton} inline-flex items-center`}>
            Back to pools
          </Link>
        }
      />
    );
  }
  return <LoadedPool pool={pool.data} />;
}

function LoadedPool({ pool }: { pool: Pool }) {
  const { address: account } = useAccount();
  const [range, setRange] = useState<ChartRangeId>("7d");
  const [dialog, setDialog] = useState<Dialog>(null);
  const orientation = orientationOf(pool);

  const key = pool.address.toLowerCase();
  const history = useQuery({ queryKey: ["aether-pool-history", key], queryFn: () => loadPoolHistory(pool), refetchInterval: HISTORY_REFRESH_MS, staleTime: 60_000 });
  const profile = useQuery({ queryKey: ["aether-pool-liquidity", key], queryFn: () => loadLiquidityProfile(pool), refetchInterval: PROFILE_REFRESH_MS });
  const positions = useQuery({ ...positionsQuery(account), enabled: Boolean(account), refetchInterval: PROFILE_REFRESH_MS });
  const mine = account ? (positions.data ?? []).filter((position) => position.pool.address.toLowerCase() === key) : [];

  const summary = summarize(pool, orientation, history.data);
  const trades = history.data;
  const buckets = useMemo(() => (trades ? bucketize(pool, orientationOf(pool), trades, range) : null), [pool, trades, range]);
  const quote = orientation.quote.symbol;
  const unit = `${quote} per ${orientation.base.symbol}`;
  const pending = history.isPending ? null : "—";

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <Link href="/pools" aria-label="Back to pools" className="pressable flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-ink-2 hover:border-line-2 hover:text-ink">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M13 8H3M7 4 3 8l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <PairIcons pool={pool} />
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] sm:text-[26px]">
          <TokenName token={orientation.base} /> / <TokenName token={orientation.quote} />
        </h1>
        <span className="rounded-lg bg-inset px-2.5 py-1 text-[12.5px] font-medium text-ink-2">Uniswap V3 · {feeLabel(pool.fee)}</span>
        <a
          href={`${EXPLORER}/address/${pool.address}`}
          target="_blank"
          rel="noreferrer"
          className="nums rounded-lg border border-line bg-surface px-2.5 py-1 text-[12.5px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
        >
          {shortenAddress(pool.address)} ↗
        </a>
      </header>

      <dl className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Figure label="TVL" value={summary ? formatFigure(summary.tvl) : formatFigure(summarize(pool, orientation, { trades: [], from: 0, to: 0, complete: true })!.tvl)} unit={quote} />
        <Figure label="24h volume" value={summary ? formatFigure(summary.volume24h) : pending} unit={quote} />
        <Figure label="24h fees" value={summary ? formatFigure(summary.fees24h) : pending} unit={quote} />
        <Figure label="APR" value={summary ? (summary.apr === null ? "—" : `${summary.apr >= 1000 ? compact(summary.apr) : summary.apr.toFixed(2)}%`) : pending} note="a day's fees over TVL, annualised" />
      </dl>

      {/* One column that may shrink below its content's natural width: without it the form's
          widest row sets the page's width on a phone. */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
        {/* On a phone the form comes first: it is what the page is for. */}
        <section className={`${card} order-1 min-w-0 p-4 sm:p-5 lg:order-2`}>
          <h2 className="mb-3.5 text-[15px] font-semibold tracking-tight">Add liquidity</h2>
          <AddLiquidityForm pool={pool} profile={profile.data} />
        </section>

        <div className="order-2 min-w-0 space-y-5 lg:order-1">
          <section className={`${card} p-4 sm:p-5`}>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-[12.5px] text-ink-2">Price</h2>
                <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
                  <span className="nums text-[24px] font-medium leading-tight tracking-[-0.02em] text-ink">{formatPriceValue(currentPrice(pool, orientation))}</span>
                  <span className="text-[12.5px] text-ink-2">{unit}</span>
                </p>
              </div>
              <Segmented label="Chart range" size="sm" value={range} onChange={setRange} options={CHART_RANGES.map((entry) => ({ value: entry.id, label: entry.label }))} />
            </div>

            {buckets ? (
              <div className="animate-fade">
                <PriceChart buckets={buckets} unit={unit} quoteSymbol={quote} intraday={range === "24h"} />
              </div>
            ) : history.isError ? (
              <div className="flex h-[280px] flex-col items-center justify-center gap-3 text-center">
                <p className="text-[13.5px] text-ink-2">The trade history could not be read from the RPC.</p>
                <button type="button" onClick={() => history.refetch()} className={outlineButton}>
                  Try again
                </button>
              </div>
            ) : (
              <div className="skeleton h-[280px] rounded-field" aria-busy="true" aria-label="Loading the price chart" />
            )}
            {history.data && !history.data.complete ? (
              <p className="mt-3 text-[12px] text-warn">Part of the history could not be read, so the volume shown may be low.</p>
            ) : null}
          </section>

          <section className={`${card} p-4 sm:p-5`}>
            <h2 className="text-[12.5px] text-ink-2">Pool balances</h2>
            <dl className="mt-2 grid grid-cols-2 gap-3">
              {[
                { token: pool.token0, amount: pool.balance0 },
                { token: pool.token1, amount: pool.balance1 },
              ].map(({ token, amount }) => (
                <div key={token.address} className="min-w-0">
                  <dd className="nums truncate text-[18px] font-medium text-ink">{formatTokenAmount(amount, token.decimals)}</dd>
                  <dt className="text-[12.5px] text-ink-2">{token.symbol}</dt>
                </div>
              ))}
            </dl>
          </section>

          {mine.length ? (
            <section>
              <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Your positions in this pool</h2>
              <ul className="grid gap-3 sm:gap-4">
                {mine.map((position, index) => (
                  <li key={position.tokenId.toString()} className={`${card} animate-rise min-w-0 p-4 sm:p-5`} style={stagger(index)}>
                    <PositionCard position={position} onRemove={() => setDialog({ kind: "remove", position })} onCollect={() => setDialog({ kind: "collect", position })} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>

      {dialog ? <RemoveLiquidityModal position={dialog.position} feesOnly={dialog.kind === "collect"} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function Figure({ label, value, unit, note }: { label: string; value: string | null; unit?: string; note?: string }) {
  return (
    <div className={`${card} min-w-0 px-3.5 py-3 sm:px-4 sm:py-3.5`}>
      <dt className="text-[12px] text-ink-2 sm:text-[12.5px]">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[20px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[24px]">
        {value === null ? <span className="skeleton inline-block h-6 w-20 rounded align-middle" aria-label="Loading" /> : <span className="nums truncate">{value}</span>}
        {unit && value !== null && value !== "—" ? <span className="text-[13px] font-medium tracking-normal text-ink-2">{unit}</span> : null}
      </dd>
      {note ? <dd className="mt-1 hidden text-[11.5px] leading-snug text-ink-3 sm:block">{note}</dd> : null}
    </div>
  );
}

function PoolSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the pool">
      <div className="mb-5 flex items-center gap-3">
        <span className="skeleton size-9 rounded-xl" />
        <span className="skeleton h-8 w-56 rounded-lg" />
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <span key={index} className="skeleton h-[76px] rounded-card" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
        <span className="skeleton order-2 h-[380px] rounded-card lg:order-1" />
        <span className="skeleton order-1 h-[520px] rounded-card lg:order-2" />
      </div>
    </div>
  );
}
