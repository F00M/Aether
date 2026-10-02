type Tone = "accent" | "warn" | "muted";
/** The slice of (log) price a track shows, left edge to right edge. */
type Span = { from: number; to: number };

const BAND: Record<Tone, string> = { accent: "bg-accent", warn: "bg-warn", muted: "bg-ink-3" };
// What a full-range position is drawn against: four times the price either way.
const FULL_RANGE_REACH = Math.log(4);

/**
 * The window a range is drawn in, on a log scale (a price range is a ratio, so equal ratios take
 * equal widths): a little wider than whichever is wider — the range, or the range stretched to
 * include the current price.
 */
function spanFor(low: number, high: number, price: number, fullRange: boolean, padding: number): Span {
  if (fullRange) return { from: Math.log(price) - FULL_RANGE_REACH, to: Math.log(price) + FULL_RANGE_REACH };
  const from = Math.log(Math.min(low, price));
  const to = Math.log(Math.max(high, price));
  const pad = (to - from) * padding || 0.1;
  return { from: from - pad, to: to + pad };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const percentAt = (span: Span, value: number) => clamp(((Math.log(value) - span.from) / (span.to - span.from)) * 100, 0, 100);

/** Where a position's range sits against the current price. Read-only: a picture of the numbers beside it. */
export function RangeTrack({
  low,
  high,
  price,
  fullRange,
  tone = "accent",
}: {
  low: number;
  high: number;
  price: number;
  fullRange: boolean;
  /** The band's colour: earning, idle, or empty. Always paired with a text status elsewhere. */
  tone?: Tone;
}) {
  const span = spanFor(low, high, price, fullRange, 0.18);
  const left = fullRange ? 0 : percentAt(span, low);
  const right = fullRange ? 100 : percentAt(span, high);

  return (
    <div className="relative h-7" aria-hidden="true">
      <div className="absolute inset-x-0 top-2.5 h-2 rounded-full bg-inset-2" />
      <div className={`absolute top-2.5 h-2 rounded-full ${BAND[tone]}`} style={{ left: `${left}%`, width: `${Math.max(right - left, 1.5)}%` }} />
      <div className="absolute top-0.5 h-6 w-[3px] -translate-x-1/2 rounded-full bg-ink ring-2 ring-surface" style={{ left: `${percentAt(span, price)}%` }} />
    </div>
  );
}
