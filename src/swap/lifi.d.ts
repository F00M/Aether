import type { LifiQuote, Token } from "./types";

/** Hand-written types for the plain-JS LI.FI client. */

export const LIFI_DIAMOND: `0x${string}`;
export const LIFI_QUOTE_PLACEHOLDER: `0x${string}`;

export function fetchLifiQuote(args: {
  tokenIn: Token;
  tokenOut: Token;
  amountRaw: string;
  slippage: string;
  fromAddress?: `0x${string}`;
}): Promise<LifiQuote>;
