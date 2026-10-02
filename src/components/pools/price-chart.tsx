"use client";

import { useState, type PointerEvent } from "react";

import { formatPriceValue } from "@/components/pools/pool-format";
import type { ChartBucket } from "@/components/pools/pool-stats";
import { compact, formatAmount } from "@/lib/format";

const PRICE_HEIGHT = 188;
const VOLUME_HEIGHT = 56;
const AXIS_WIDTH = 60;
const WIDTH = 1000;

const formatWhen = (seconds: number, withTime: boolean) =>
  new Date(seconds * 1000).toLocaleString("en-US", withTime ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" });
const formatVolume = (value: number) => (value >= 1e6 ? compact(value) : formatAmount(value, 2));

/**
 * Price over time as a line, and the volume traded in each stretch as bars underneath. Two plots
 * on one time axis rather than one plot with two scales: a line and bars sharing a frame invite
 * reading one against the other's axis.
 */
export function PriceChart({ buckets, unit, quoteSymbol, intraday }: { buckets: ChartBucket[]; unit: string; quoteSymbol: string; intraday: boolean }) {
  const [active, setActive] = useState<number | null>(null);

  const known = buckets.map((bucket) => bucket.price).filter((price): price is number => price !== null);
  const lowest = Math.min(...known);
  const highest = Math.max(...known);
  // A flat line still gets a band to sit in the middle of.
  const padding = (highest - lowest) * 0.12 || highest * 0.01 || 1;
  const floor = Math.max(0, lowest - padding);
  const ceiling = highest + padding;
  const x = (index: number) => ((index + 0.5) / buckets.length) * WIDTH;
  const y = (price: number) => PRICE_HEIGHT - ((price - floor) / (ceiling - floor)) * PRICE_HEIGHT;

  const points = buckets.flatMap((bucket, index) => (bucket.price === null ? [] : [[x(index), y(bucket.price)] as const]));
  const line = points.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
  const area = points.length ? `${line}L${points[points.length - 1][0].toFixed(1)},${PRICE_HEIGHT}L${points[0][0].toFixed(1)},${PRICE_HEIGHT}Z` : "";
  const peakVolume = Math.max(...buckets.map((bucket) => bucket.volume));
  const ticks = [ceiling - padding, (floor + ceiling) / 2, floor + padding];

  const hover = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(Math.min(buckets.length - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * buckets.length))));
  };
  const shown = active === null ? null : buckets[active];
  const share = active === null ? 0 : ((active + 0.5) / buckets.length) * 100;
  const labelled = [0, 0.25, 0.5, 0.75, 1].map((at) => Math.min(buckets.length - 1, Math.round(at * (buckets.length - 1))));

  return (
    <div role="group" aria-label={`Price in ${unit} and volume in ${quoteSymbol} over time`}>
      <div className="flex">
        <div className="relative min-w-0 flex-1">
          {/* Price */}
          <svg viewBox={`0 0 ${WIDTH} ${PRICE_HEIGHT}`} preserveAspectRatio="none" className="block w-full" style={{ height: PRICE_HEIGHT }} aria-hidden="true">
            {ticks.map((tick) => (
              <line key={tick} x1="0" x2={WIDTH} y1={y(tick)} y2={y(tick)} stroke="var(--color-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {area ? <path d={area} fill="var(--color-accent)" opacity="0.08" /> : null}
            {line ? <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
          </svg>

          {/* Volume: its own plot, on the same time axis */}
          <div className="mt-3 flex items-end gap-px border-b border-line-2" style={{ height: VOLUME_HEIGHT }} aria-hidden="true">
            {buckets.map((bucket, index) => (
              <span
                key={bucket.start}
                className={`min-w-0 flex-1 rounded-t-[2px] ${active === index ? "bg-series-2" : "bg-series-2/55"}`}
                style={{ height: `${peakVolume > 0 && bucket.volume > 0 ? Math.max((bucket.volume / peakVolume) * 100, 3) : 0}%` }}
              />
            ))}
          </div>

          {shown ? (
            <>
              <div className="pointer-events-none absolute top-0 w-px bg-ink/30" style={{ left: `${share}%`, height: PRICE_HEIGHT + 12 + VOLUME_HEIGHT }} />
              {shown.price !== null ? (
                <div
                  className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent"
                  style={{ left: `${share}%`, top: y(shown.price) }}
                />
              ) : null}
              <div
                className={`pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] shadow-pop ${
                  share < 30 ? "translate-x-2" : share > 70 ? "-translate-x-[calc(100%+8px)]" : "-translate-x-1/2"
                }`}
                style={{ left: `${share}%` }}
              >
                <p className="text-ink-3">{formatWhen(shown.end, intraday)}</p>
                <p className="nums mt-0.5 text-ink">{shown.price === null ? "No trade yet" : `${formatPriceValue(shown.price)} ${unit}`}</p>
                <p className="nums text-ink-2">
                  {formatVolume(shown.volume)} {quoteSymbol} · {shown.trades} {shown.trades === 1 ? "trade" : "trades"}
                </p>
              </div>
            </>
          ) : null}

          {/* One surface takes the pointer for both plots. */}
          <div className="absolute inset-0 touch-pan-y" onPointerMove={hover} onPointerDown={hover} onPointerLeave={() => setActive(null)} />
        </div>

        {/* One price axis, on the right where the latest price is. */}
        <div className="relative shrink-0" style={{ width: AXIS_WIDTH, height: PRICE_HEIGHT }} aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} className="nums absolute left-2 -translate-y-1/2 text-[11px] leading-none text-ink-3" style={{ top: y(tick) }}>
              {formatPriceValue(tick)}
            </span>
          ))}
          <span className="absolute left-2 text-[11px] leading-none text-ink-3" style={{ top: PRICE_HEIGHT + 12 }}>
            Volume
          </span>
        </div>
      </div>

      <div className="nums relative mt-1.5 h-4 text-[11px] text-ink-3" style={{ marginRight: AXIS_WIDTH }} aria-hidden="true">
        {labelled.map((index, position) => (
          <span
            key={index}
            className={`absolute top-0 whitespace-nowrap ${position === 0 ? "" : position === labelled.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
            style={{ left: `${(position / (labelled.length - 1)) * 100}%` }}
          >
            {formatWhen(buckets[index].end, intraday)}
          </span>
        ))}
      </div>
    </div>
  );
}
