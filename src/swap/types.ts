/**
 * Shape of the objects the (untyped) quote engine returns. Declared here so the
 * TSX components get real completion without touching the ported JS.
 */

export type Token = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  chainId: number;
  color: string;
};

export type RouteLeg = {
  protocol?: string;
  tokenIn?: string;
  tokenOut?: string;
  via?: string;
  currencyIn?: string;
  currencyOut?: string;
};

export type Route = {
  type?: string;
  percent: number;
  fee: number;
  fee2?: number;
  hops?: number;
  via?: string;
  legs?: RouteLeg[];
  amountIn?: string;
  amountOut?: string;
};

export type ApiQuote = {
  amountOut: string;
  amountOutFormatted: string;
  isBetter?: boolean;
  deltaFormatted?: string | null;
  raw?: unknown;
  at?: number;
};

/** LI.FI's quote for the same trade (see src/swap/lifi.js). */
export type LifiQuote =
  | {
      source: "lifi";
      unavailable: true;
      reason: string;
      at: number;
    }
  | {
      source: "lifi";
      unavailable?: false;
      amountOut: string;
      amountOutMin: string;
      amountOutFormatted: string;
      /** Underlying tool LI.FI routed through, e.g. "Fly". */
      tool: string;
      toolKey: string | null;
      steps: { type: string; tool: string }[];
      feeCosts: { name: string; percentage: number; included: boolean }[];
      /** Total fee deducted from the output, as a fraction (0.0025 = 0.25%). */
      feePct: number;
      gasWei: string;
      durationSec: number;
      approvalAddress: string | null;
      fromToken: string;
      toToken: string;
      /** Native ETH input quoted as WETH — a wrap runs before the swap. */
      wrapInput: boolean;
      /** Native ETH output quoted as WETH — an unwrap runs after the swap. */
      unwrapOutput: boolean;
      fromAddress: string;
      /** Calldata built for `fromAddress`; only executable when `forWallet` is true. */
      forWallet: boolean;
      transactionRequest: {
        to: `0x${string}`;
        data: `0x${string}`;
        value: bigint;
        gasLimit?: bigint;
      };
      at: number;
      /** Set by useQuote against the displayed Aether total. */
      isBetter?: boolean;
      deltaFormatted?: string | null;
    };

/** Where a swap can be executed from. */
export type Venue = "aether" | "api" | "lifi";

export type Quote = {
  routes: Route[];
  totalAmountOut: string;
  amountOutFormatted: string;
  minOutFormatted: string;
  rate: string;
  fee: number;
  priceImpact: number;
  priceImpactPct: string;
  slippageUsed: string;
  isSplit: boolean;
  hasV4: boolean;
  isWrap?: boolean;
  wrapAction?: "wrap" | "unwrap";
  splitMode?: string;
  isBalanced?: boolean;
  balancedRejected?: boolean;
  apiSanityWarning?: boolean;
  apiBetterTooMuch?: boolean;
  apiQuote: ApiQuote | null;
  lifiQuote?: LifiQuote | null;
  /** Routes that shared a pool were collapsed so the total isn't double-counted. */
  sharedPoolsMerged?: number;
  executedTotalSimulated?: boolean;
  /** Locally computed stand-in shown before the engine's first real split lands. */
  provisional?: boolean;
  /** Set once the FULL scan has landed (the fast first paint and local estimates are not final). */
  final?: boolean;
  /** Set when the local math crossed a tick range and is no longer exact. */
  approx?: boolean;
};

export type Protocol = "v2" | "v3" | "v4";
