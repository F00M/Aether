"use client";

import { useState } from "react";

export type ColumnDatum = {
  key: string | number;
  /** Short x-axis label; only some are drawn. */
  tick: string;
  /** Full name of the column, for the tooltip and the table. */
  name: string;
  value: number;
  /** The value as it should read. */
  display: string;
};

const PLOT_HEIGHT = 176;
// Room above the tallest column for its cap label.
const HEADROOM = 18;
const MAX_TICK_LABELS = 5;

/** Next 1/2/5 × 10ⁿ at or above the value, so the axis tops out on a clean number. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const lead = value / magnitude;
  return (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 5 ? 5 : 10) * magnitude;
}

/**
 * One series over time as columns: thin bars on a single baseline, hairline grid, and a tooltip on
 * hover or keyboard focus. The tooltip only repeats what the table view (toggled by the parent)
 * already shows, so nothing is readable by pointer alone.
 */
export function ColumnChart({
  data,
  formatTick,
  integer = false,
  label,
}: {
  data: ColumnDatum[];
  /** Formats a y-axis tick. */
  formatTick: (value: number) => string;
  /** Whole-number data never gets a fractional tick. */
  integer?: boolean;
  /** What the chart shows, for assistive tech. */
  label: string;
}) {
  const [active, setActive] = useState<number | null>(null);

  const peak = data.reduce((max, datum) => Math.max(max, datum.value), 0);
  const top = niceCeiling(peak);
  const middle = top / 2;
  const ticks = integer && !Number.isInteger(middle) ? [0, top] : [0, middle, top];
  const peakIndex = peak > 0 ? data.findIndex((datum) => datum.value === peak) : -1;

  const step = Math.max(1, Math.ceil(data.length / MAX_TICK_LABELS));
  const lastIndex = data.length - 1;
  // Every `step`-th column is labelled, plus the last one — unless that lands on top of its neighbour.
  const labelled = (index: number) =>
    index === lastIndex || (index % step === 0 && lastIndex - index >= Math.ceil(step / 2));

  const shown = active != null ? data[active] : null;
  const share = (index: number) => ((index + 0.5) / data.length) * 100;
  // Near an edge the tooltip hangs inward, so it never leaves the card.
  const anchor = (index: number) =>
    index < data.length * 0.25 ? "translate-x-0" : index > data.length * 0.75 ? "-translate-x-full" : "-translate-x-1/2";

  return (
    <div role="group" aria-label={label}>
      <div className="flex">
        <div className="relative w-11 shrink-0" style={{ height: PLOT_HEIGHT }} aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="nums absolute right-2 translate-y-1/2 text-[11px] leading-none text-ink-3"
              style={{ bottom: (tick / top) * (PLOT_HEIGHT - HEADROOM) }}
            >
              {formatTick(tick)}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1" style={{ height: PLOT_HEIGHT }}>
          {ticks.map((tick) => (
            <span
              key={tick}
              aria-hidden="true"
              className={`absolute inset-x-0 border-t ${tick === 0 ? "border-line-2" : "border-line"}`}
              style={{ bottom: (tick / top) * (PLOT_HEIGHT - HEADROOM) }}
            />
          ))}

          <div className="absolute inset-x-0 bottom-0 flex" style={{ top: HEADROOM }}>
            {data.map((datum, index) => (
              // The whole slot is the hit target, not just the painted bar.
              <div
                key={datum.key}
                tabIndex={0}
                aria-label={`${datum.name}: ${datum.display}`}
                onPointerEnter={() => setActive(index)}
                onPointerLeave={() => setActive((current) => (current === index ? null : current))}
                onFocus={() => setActive(index)}
                onBlur={() => setActive((current) => (current === index ? null : current))}
                className="flex min-w-0 flex-1 items-end justify-center px-px outline-none focus-visible:bg-inset"
              >
                <span
                  className={`w-full max-w-6 rounded-t bg-accent transition-opacity ${
                    active != null && active !== index ? "opacity-45" : ""
                  }`}
                  style={{ height: `${(datum.value / top) * 100}%` }}
                />
              </div>
            ))}
          </div>

          {peakIndex >= 0 && active == null ? (
            <span
              aria-hidden="true"
              className={`nums pointer-events-none absolute whitespace-nowrap text-[11px] font-medium leading-none text-ink-2 ${anchor(peakIndex)}`}
              style={{ left: `${share(peakIndex)}%`, bottom: (peak / top) * (PLOT_HEIGHT - HEADROOM) + 5 }}
            >
              {data[peakIndex].display}
            </span>
          ) : null}

          {shown && active != null ? (
            <div
              role="status"
              className={`pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 shadow-pop ${anchor(active)}`}
              style={{
                left: `${share(active)}%`,
                bottom: Math.min((shown.value / top) * (PLOT_HEIGHT - HEADROOM) + 8, PLOT_HEIGHT - 44),
              }}
            >
              <span className="block text-[13px] font-semibold leading-tight text-ink">{shown.display}</span>
              <span className="block text-[11.5px] leading-tight text-ink-2">{shown.name}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-1.5 flex pl-11" aria-hidden="true">
        {data.map((datum, index) => (
          <span
            key={datum.key}
            className={`flex min-w-0 flex-1 text-[11px] leading-none text-ink-3 ${
              index === 0 ? "justify-start" : index === lastIndex ? "justify-end" : "justify-center"
            }`}
          >
            {labelled(index) ? <span className="whitespace-nowrap">{datum.tick}</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The same series as rows: the chart's accessible twin. */
export function ColumnTable({ data, columns }: { data: ColumnDatum[]; columns: [string, string] }) {
  return (
    <div className="overflow-y-auto" style={{ maxHeight: PLOT_HEIGHT + 18 }}>
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 bg-surface text-left text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-3">
          <tr>
            <th scope="col" className="py-1.5 font-medium">
              {columns[0]}
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              {columns[1]}
            </th>
          </tr>
        </thead>
        <tbody>
          {[...data].reverse().map((datum) => (
            <tr key={datum.key} className="border-t border-line">
              <th scope="row" className="py-1.5 text-left font-normal text-ink-2">
                {datum.name}
              </th>
              <td className="nums py-1.5 text-right text-ink">{datum.display}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
