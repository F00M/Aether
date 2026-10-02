"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { formatPriceValue } from "@/components/pools/pool-format";

type Edge = "low" | "high";
/** The slice of (log) price the plot shows, left edge to right edge. */
type Span = { from: number; to: number };

const BARS = 72;
const PLOT_HEIGHT = 132;
// A full-range position is drawn against four times the price either way.
const FULL_RANGE_REACH = Math.log(4);
const ZOOM_MIN = -2;
const ZOOM_MAX = 4;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * The window the range is drawn in, on a log scale (a price range is a ratio, so equal ratios take
 * equal widths): the range stretched to include the current price, with room either side that
 * the zoom level scales.
 */
function spanFor(low: number, high: number, price: number, fullRange: boolean, zoom: number): Span {
  const room = 2 ** zoom;
  if (fullRange) return { from: Math.log(price) - FULL_RANGE_REACH * room, to: Math.log(price) + FULL_RANGE_REACH * room };
  const from = Math.log(Math.min(low, price));
  const to = Math.log(Math.max(high, price));
  const pad = Math.max((to - from) * 0.45 * room, 0.01);
  return { from: from - pad, to: to + pad };
}

/**
 * Where the pool's liquidity sits across prices, with the chosen range on top of it: two handles
 * to drag, the current price as a line. While a handle is held the window stays put, so the price
 * under the pointer doesn't shift as the range grows; on release it re-centres.
 */
export function LiquidityRange({
  low,
  high,
  price,
  fullRange,
  inRange,
  liquidityAtPrice,
  onChange,
  onNudge,
}: {
  low: number;
  high: number;
  price: number;
  fullRange: boolean;
  /** Whether the current price is inside the range: the band is drawn as earning or as idle. */
  inRange: boolean;
  /** Active liquidity at a shown price; undefined until the pool's ticks have been read. */
  liquidityAtPrice: ((price: number) => number) | undefined;
  /** A handle was dragged to this price; the owner snaps it to what the pool allows. */
  onChange: (edge: Edge, value: number) => void;
  /** One step up (+1) or down (−1) from the keyboard. */
  onNudge: (edge: Edge, direction: 1 | -1) => void;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0);
  const [held, setHeld] = useState<{ edge: Edge; span: Span } | null>(null);

  const span = held?.span ?? spanFor(low, high, price, fullRange, zoom);
  const percentAt = (value: number) => clamp(((Math.log(value) - span.from) / (span.to - span.from)) * 100, 0, 100);
  const priceAt = (share: number) => Math.exp(span.from + share * (span.to - span.from));
  const left = fullRange ? 0 : percentAt(low);
  const right = fullRange ? 100 : percentAt(high);
  const marker = percentAt(price);

  const bars = useMemo(() => {
    if (!liquidityAtPrice) return null;
    const values = Array.from({ length: BARS }, (_, index) => liquidityAtPrice(Math.exp(span.from + ((index + 0.5) / BARS) * (span.to - span.from))));
    const peak = Math.max(...values);
    // One position packed into a tick or two can stand a hundred times taller than everything
    // else and flatten the rest of the curve into a line. When the tallest bar is that far above
    // the typical one, the scale tops out lower and the bars beyond it are drawn broken at the top.
    const typical = [...values].filter((value) => value > 0).sort((a, b) => a - b);
    const high = typical.length ? typical[Math.floor(typical.length * 0.85)] : 0;
    const top = peak > high * 4 ? high * 1.6 : peak;
    return values.map((value) => ({ height: top > 0 ? Math.min(value / top, 1) : 0, offScale: value > top }));
  }, [liquidityAtPrice, span.from, span.to]);

  const grab = (edge: Edge) => (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setHeld({ edge, span });
  };
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (!held || !plot) return;
    const box = plot.getBoundingClientRect();
    const share = clamp((event.clientX - box.left) / box.width, 0, 1);
    onChange(held.edge, Math.exp(held.span.from + share * (held.span.to - held.span.from)));
  };
  const release = () => setHeld(null);
  const step = (edge: Edge) => (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    onNudge(edge, direction);
  };

  const handle = (edge: Edge, at: number) => {
    const value = edge === "low" ? low : high;
    const unbounded = fullRange || !Number.isFinite(value);
    const colour = edge === "low" ? "bg-accent" : "bg-series-2";
    return (
      <div
        role="slider"
        tabIndex={0}
        aria-label={edge === "low" ? "Min price" : "Max price"}
        aria-orientation="horizontal"
        aria-valuenow={unbounded ? undefined : Number(value.toPrecision(8))}
        aria-valuetext={unbounded ? (edge === "low" ? "0" : "No upper limit") : formatPriceValue(value)}
        onPointerDown={grab(edge)}
        onPointerMove={drag}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={step(edge)}
        // The hit area is wider than the line it carries, and a finger on it doesn't scroll the page.
        className={`group absolute inset-y-0 flex w-8 -translate-x-1/2 touch-none justify-center outline-none ${
          held?.edge === edge ? "z-20 cursor-grabbing" : "z-10 cursor-ew-resize"
        }`}
        style={{ left: `${at}%` }}
      >
        <span className={`h-full w-0.5 ${colour}`} />
        <span
          className={`absolute top-1.5 size-4 rounded-full border-2 border-surface shadow-sm transition-transform duration-150 group-hover:scale-125 group-focus-visible:ring-2 group-focus-visible:ring-ink/25 ${colour} ${
            held?.edge === edge ? "scale-125" : ""
          }`}
        />
      </div>
    );
  };

  // Finger-sized on a phone, compact with a pointer.
  const zoomButton = "flex size-8 items-center justify-center rounded-md border border-line bg-surface text-[15px] leading-none text-ink-2 transition-colors hover:border-line-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 sm:size-6 sm:text-[14px]";

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-end gap-1">
        <button type="button" aria-label="Zoom in" disabled={zoom <= ZOOM_MIN} onClick={() => setZoom((level) => Math.max(ZOOM_MIN, level - 1))} className={zoomButton}>
          +
        </button>
        <button type="button" aria-label="Zoom out" disabled={zoom >= ZOOM_MAX} onClick={() => setZoom((level) => Math.min(ZOOM_MAX, level + 1))} className={zoomButton}>
          −
        </button>
      </div>

      {/* Inset by half a handle so one parked at either end stays inside the card. */}
      <div className="px-4">
        <div ref={plotRef} className="relative select-none" style={{ height: PLOT_HEIGHT }}>
          {/* The bars: one per slice of price, as tall as the liquidity active there. Those inside
              the chosen range are solid; the rest step back. */}
          <div className="absolute inset-0 flex items-end gap-px" aria-hidden="true">
            {bars
              ? bars.map(({ height, offScale }, index) => {
                  const centre = ((index + 0.5) / BARS) * 100;
                  const chosen = centre >= left && centre <= right;
                  return (
                    <span
                      key={index}
                      className={`relative min-w-0 flex-1 rounded-t-[2px] ${chosen ? (inRange ? "bg-accent" : "bg-warn") : "bg-accent/25"}`}
                      style={{ height: `${height > 0 ? Math.max(height * 100, 1.5) : 0}%` }}
                    >
                      {/* A gap near the top: this bar runs past the scale. */}
                      {offScale ? <span className="absolute inset-x-0 top-1.5 h-[3px] bg-surface" /> : null}
                    </span>
                  );
                })
              : Array.from({ length: 24 }, (_, index) => <span key={index} className="skeleton min-w-0 flex-1 rounded-t-[2px]" style={{ height: `${18 + ((index * 37) % 60)}%` }} />)}
          </div>
          <div className="absolute inset-x-0 bottom-0 h-px bg-line-2" aria-hidden="true" />

          <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${marker}%` }} aria-hidden="true" />
          {handle("low", left)}
          {handle("high", right)}
        </div>

        <div className="nums relative mt-1.5 h-4 text-[10.5px] text-ink-3" aria-hidden="true">
          {/* Four prices along the axis; a phone has room for the two ends and the middle. */}
          {[
            { share: 0, show: "" },
            { share: 1 / 3, show: "hidden sm:inline" },
            { share: 1 / 2, show: "sm:hidden" },
            { share: 2 / 3, show: "hidden sm:inline" },
            { share: 1, show: "" },
          ].map(({ share, show }) => (
            <span
              key={share}
              className={`absolute top-0 whitespace-nowrap ${show} ${share === 0 ? "" : share === 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
              style={{ left: `${share * 100}%` }}
            >
              {formatPriceValue(priceAt(share))}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
