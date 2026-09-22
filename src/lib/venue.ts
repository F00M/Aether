import type { LifiQuote, Quote, Venue } from "@/swap/types";

const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Auto-selection handicap per extra on-chain transaction a venue needs beyond Aether's single
 * execute(). Each one is another wallet prompt, another ~12s block wait and more gas — LI.FI on
 * Sepolia with native ETH in is wrap → approve → swap, three prompts for what Aether does in one.
 * A route must beat Aether by more than this per extra transaction to be picked automatically;
 * the user can still pick it by hand.
 */
export const EXTRA_TX_PENALTY_BPS = 50n;

type LiveLifi = Extract<LifiQuote, { amountOut: string }>;

/**
 * Transactions LI.FI needs on top of the swap itself. Approval is counted every time on purpose:
 * the Diamond only ever gets an exact-amount allowance (LI.FI's July 2024 exploit drained wallets
 * that had granted it unlimited ones).
 */
export function lifiExtraTxs(lifi: LifiQuote | null | undefined): number {
  if (!lifi || lifi.unavailable) return 0;
  const live = lifi as LiveLifi;
  return (live.wrapInput ? 1 : 0) + (live.unwrapOutput ? 1 : 0) + (live.fromToken.toLowerCase() !== NATIVE ? 1 : 0);
}

/**
 * Venue that executes when the user hasn't picked one: the best output after the extra-transaction
 * handicap — but only once Aether's FULL scan has landed. Before that the Aether number on screen is
 * the fast first paint (routinely well below its final split), so any external quote would "win"
 * against a number that is about to be replaced.
 */
export function autoVenue(quote: Quote | null, outs: Partial<Record<Venue, bigint>>): Venue {
  if (!quote?.final) return "aether";
  const penalty = (venue: Venue) =>
    venue === "lifi" ? BigInt(lifiExtraTxs(quote.lifiQuote)) * EXTRA_TX_PENALTY_BPS : 0n;
  let best: Venue = "aether";
  let bestScore = -1n;
  for (const [venue, out] of Object.entries(outs) as [Venue, bigint][]) {
    const score = (out * (10_000n - penalty(venue))) / 10_000n;
    if (score > bestScore) {
      best = venue;
      bestScore = score;
    }
  }
  return best;
}
