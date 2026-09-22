"use client";

import { RouteDisplay } from "@/components/swap/route-display";
import { lifiExtraTxs } from "@/lib/venue";
import type { LifiQuote, Quote, Token, Venue } from "@/swap/types";

type Card = {
  venue: Venue;
  name: string;
  detail: string;
  amountOut: bigint;
  amountOutFormatted: string;
  fee: string;
  steps: string;
};

const LIFI_STEP_NAMES = (lifi: Extract<LifiQuote, { amountOut: string }>) => {
  const steps = [
    lifi.wrapInput ? "Wrap" : null,
    lifi.fromToken.toLowerCase() !== "0x0000000000000000000000000000000000000000" ? "Approve" : null,
    "Swap",
    lifi.unwrapOutput ? "Unwrap" : null,
  ].filter(Boolean);
  return `${steps.length} tx · ${steps.join(" → ")}`;
};

function buildCards(quote: Quote): Card[] {
  const cards: Card[] = [];
  const shares = new Set(
    quote.routes.flatMap((route) => {
      if (route.type?.startsWith("mixed")) return route.legs?.map((leg) => leg.protocol?.toUpperCase()) ?? [];
      if (route.type?.startsWith("v2")) return ["V2"];
      if (route.type?.startsWith("v4")) return ["V4"];
      return ["V3"];
    }),
  );
  const protocols = ["V2", "V3", "V4"].filter((p) => shares.has(p)).join(" + ") || "Uniswap";

  cards.push({
    venue: "aether",
    name: "Aether",
    detail: quote.routes.length > 1 ? `Split across ${quote.routes.length} routes · ${protocols}` : `Single route · ${protocols}`,
    amountOut: BigInt(quote.totalAmountOut),
    amountOutFormatted: quote.amountOutFormatted,
    fee: "Pool fees only",
    steps: "1 tx",
  });

  if (quote.apiQuote?.amountOut) {
    cards.push({
      venue: "api",
      name: "Uniswap API",
      detail: "Trading API · Universal Router",
      amountOut: BigInt(quote.apiQuote.amountOut),
      amountOutFormatted: quote.apiQuote.amountOutFormatted,
      fee: "Pool fees only",
      steps: "1 tx",
    });
  }

  const lifi = quote.lifiQuote;
  if (lifi && !lifi.unavailable) {
    cards.push({
      venue: "lifi",
      name: "LI.FI",
      detail: `via ${lifi.tool}`,
      amountOut: BigInt(lifi.amountOut),
      amountOutFormatted: lifi.amountOutFormatted,
      fee: `${(lifi.feePct * 100).toFixed(2)}% LI.FI fee (already deducted)`,
      steps: LIFI_STEP_NAMES(lifi),
    });
  }

  return cards.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
}

function pctAhead(best: bigint, amount: bigint): string {
  if (amount <= 0n) return "";
  return `${(Number(((best - amount) * 10000n) / amount) / 100).toFixed(2)}%`;
}

function pctBehind(amount: bigint, best: bigint): string {
  if (best <= 0n) return "";
  const bps = Number(((best - amount) * 10000n) / best);
  return `−${(bps / 100).toFixed(2)}%`;
}

/**
 * Right-hand route list, LI.FI-widget style: every venue that can execute this trade as its own
 * card, best return first. Clicking a card selects where the swap executes; by default the best
 * one is selected and the selection follows it as quotes refresh.
 */
export function RoutesPanel({
  quote,
  tokenIn,
  tokenOut,
  quoteLoading,
  amountIn,
  activeVenue,
  pinnedVenue,
  executableVenues,
  onSelectVenue,
}: {
  quote: Quote | null;
  tokenIn: Token;
  tokenOut: Token;
  quoteLoading: boolean;
  amountIn: string;
  activeVenue: Venue;
  /** The user's explicit pick, or null while the selection follows the best route. */
  pinnedVenue: Venue | null;
  /** Venues that can execute right now (e.g. a venue whose execution just failed is left out). */
  executableVenues: Venue[];
  onSelectVenue: (venue: Venue | null) => void;
}) {
  const ready = Boolean(quote && !quote.provisional);
  const cards = ready && quote ? buildCards(quote) : [];
  const best = cards.find((card) => executableVenues.includes(card.venue)) ?? cards[0];
  const lifiMissing = ready && quote?.lifiQuote?.unavailable ? quote.lifiQuote : null;
  const lifiPending = ready && quote && quote.lifiQuote == null;

  return (
    <section className="min-w-0 rounded-card border border-line bg-surface p-4 shadow-card">
      <header className="mb-3.5 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[15px] font-semibold tracking-tight">Routes</h2>
          {cards.length ? <span className="text-[12px] text-ink-3">{cards.length} available</span> : null}
        </div>
        <span
          className={`flex items-center gap-1.5 text-[11.5px] ${quoteLoading ? "text-ink-2" : "text-accent"}`}
        >
          <span className={`size-[7px] rounded-full ${quoteLoading ? "bg-ink-3" : "bg-accent"}`} />
          {quoteLoading ? "searching…" : "live"}
        </span>
      </header>

      {!amountIn ? (
        <div className="px-3 py-10 text-center text-[13px] leading-relaxed text-ink-3">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="mx-auto mb-2.5 text-accent/55"
          >
            <path
              d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          Enter an amount to compare
          <br />
          Aether · LI.FI · Uniswap API
        </div>
      ) : null}

      {amountIn && !ready ? (
        <div className="flex flex-col gap-2.5">
          {[112, 76, 76].map((h, i) => (
            <div key={i} className="skeleton rounded-field" style={{ height: h }} />
          ))}
        </div>
      ) : null}

      {amountIn && ready && quote ? (
        <div role="radiogroup" aria-label="Choose execution route" className="flex flex-col gap-2.5">
          {cards.map((card) => {
            const selected = card.venue === activeVenue;
            const isBest = card === best;
            const executable = executableVenues.includes(card.venue);
            return (
              <div
                key={card.venue}
                className={`rounded-field border transition-colors ${
                  selected
                    ? "border-accent/45 bg-accent-wash"
                    : executable
                      ? "border-line hover:border-line-2"
                      : "border-line opacity-60"
                }`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`${card.name}: ${card.amountOutFormatted} ${tokenOut.symbol}${isBest ? ", best return" : ""}`}
                  disabled={!executable}
                  onClick={() => onSelectVenue(isBest ? null : card.venue)}
                  className="block w-full p-3 text-left disabled:cursor-not-allowed"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    {!executable ? (
                      <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10.5px] font-medium text-ink-3">
                        Not executable · reference
                      </span>
                    ) : isBest ? (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-semibold text-white">
                        Best return
                      </span>
                    ) : (
                      <span className="nums rounded-full border border-line bg-surface px-2 py-0.5 text-[10.5px] font-medium text-ink-2">
                        {pctBehind(card.amountOut, best.amountOut)}
                      </span>
                    )}
                    {selected ? (
                      <span className="rounded-full border border-accent/40 px-2 py-0.5 text-[10.5px] font-medium text-accent">
                        {pinnedVenue === card.venue ? "Pinned" : "Executing"}
                      </span>
                    ) : null}
                    <span className="ml-auto flex items-center gap-1.5 text-[12px] font-semibold">
                      <VenueMark venue={card.venue} />
                      {card.name}
                    </span>
                  </div>

                  <p className="nums text-[21px] leading-tight tracking-[-0.02em]">
                    {card.amountOutFormatted}{" "}
                    <span className="text-[13px] text-ink-2">{tokenOut.symbol}</span>
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-2">{card.detail}</p>
                  {selected && !isBest && !pinnedVenue && quote.final && best?.venue === "lifi" ? (
                    <p className="mt-1.5 text-[11.5px] leading-relaxed text-accent">
                      Auto-selected: LI.FI pays only {pctAhead(best.amountOut, card.amountOut)} more but needs{" "}
                      {lifiExtraTxs(quote.lifiQuote)} extra transactions. Tap the LI.FI card to use it anyway.
                    </p>
                  ) : null}

                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
                    <span>{card.fee}</span>
                    <span aria-hidden="true">·</span>
                    <span>{card.steps}</span>
                  </div>
                </button>

                {card.venue === "aether" ? (
                  <div className="px-3 pb-3">
                    <RouteDisplay quote={quote} tokenIn={tokenIn} tokenOut={tokenOut} />
                    {quote.sharedPoolsMerged ? (
                      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                        {quote.sharedPoolsMerged} routes sharing the same pool were merged, so the total is not
                        double counted.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}

          {lifiMissing ? (
            <div className="flex items-center gap-2 rounded-field border border-dashed border-line px-3 py-2.5 text-[12px] text-ink-3">
              <VenueMark venue="lifi" muted />
              <span className="font-medium text-ink-2">LI.FI</span>
              <span className="min-w-0 truncate">· no route ({lifiMissing.reason})</span>
            </div>
          ) : null}
          {lifiPending ? (
            <div className="flex items-center gap-2 rounded-field border border-dashed border-line px-3 py-2.5 text-[12px] text-ink-3">
              <VenueMark venue="lifi" muted />
              <span className="font-medium text-ink-2">LI.FI</span>
              <span>· waiting for quote…</span>
            </div>
          ) : null}

        </div>
      ) : null}
    </section>
  );
}

function VenueMark({ venue, muted = false }: { venue: Venue; muted?: boolean }) {
  const color = muted ? "var(--color-ink-3)" : venue === "lifi" ? "#6d45d9" : venue === "api" ? "#d6336c" : "var(--color-accent)";
  if (venue === "lifi") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 3v10h10" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="11" cy="5" r="2" fill={color} />
      </svg>
    );
  }
  if (venue === "api") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke={color} strokeWidth="1.8" />
        <path d="M5.5 8h5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 17 12 6.5 17 17" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.3 13.4h5.4" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
