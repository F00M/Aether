import { parseAbi, parseAbiItem } from "viem";

import { TOKENS } from "../config/tokens";
import { AETHER_AGGREGATOR, AETHER_DEPLOY_BLOCK } from "./quoteConfig";
import { client, fetchEventLogs, getLatestBlockNumber } from "./quoteProviders";
import type { Token } from "./types";

/**
 * Swap history, read straight from the diamond's `SwapExecuted` events — there is no indexer or
 * backend behind this, so what is shown is exactly what the chain recorded.
 */
const SWAP_EXECUTED = parseAbiItem(
  "event SwapExecuted(address indexed sender, address indexed recipient, address indexed tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount)",
);
const ERC20_META = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

// One wallet's history is a handful of logs however far back it goes. Everyone's is not: the only
// endpoints that serve a wide getLogs range silently truncate past ~10k logs, so the shared feed
// only looks back about a week (12s blocks).
const ALL_WALLETS_LOOKBACK = 50_000n;
// For a diamond whose deployment block isn't known (address overridden through env).
const UNKNOWN_DEPLOY_LOOKBACK = 500_000n;
// A single wide query that comes back this full has probably been cut off by the endpoint.
const TRUNCATION_SUSPECT = 9_500;

export type SwapRecord = {
  id: string;
  hash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
  sender: `0x${string}`;
  recipient: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  /** What the recipient received, after the protocol fee. */
  amountOut: bigint;
  feeAmount: bigint;
  /** Unix seconds. From the log when the endpoint includes it, otherwise filled in later. */
  timestamp: number | null;
  /** Set when `timestamp` was interpolated between two known blocks rather than read. */
  timestampEstimated?: boolean;
};

/** "recent" keeps the all-wallets feed to about a week; "all-time" reads back to the deployment. */
export type HistoryReach = "recent" | "all-time";

export type SwapHistory = {
  swaps: SwapRecord[];
  /** False when part of the range could not be read; the list is then partial, not empty. */
  complete: boolean;
  /** How far back the list reaches. */
  fromBlock: bigint;
  head: bigint;
};

type SwapLog = {
  transactionHash: `0x${string}` | null;
  blockNumber: bigint | null;
  logIndex: number | null;
  blockTimestamp?: bigint | number | null;
  args?: Pick<SwapRecord, "sender" | "recipient" | "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "feeAmount">;
};
type Scan = { swaps: SwapRecord[]; scannedTo: bigint; fromBlock: bigint };
const scans = new Map<string, Scan>();

// ------------------------------------------------------------------ stored scans
//
// A scan is also kept in localStorage, so a returning visitor's history and stats are on screen
// from the stored copy and only the blocks since then are read — instead of the whole range again
// behind a skeleton (about three seconds for the all-time view).
const STORE_PREFIX = `aether_swaps_v1:${AETHER_AGGREGATOR.toLowerCase()}:`;
// The newest blocks can still be reorganised. They are left out of the stored copy and simply
// read again next time; the ones before them are final.
const UNFINALIZED_BLOCKS = 64n;
// Rewriting the stored copy costs a serialisation of every swap, so it waits for a new swap or
// for the stored watermark to fall this far behind (about an hour of blocks).
const STORE_GAP_BLOCKS = 300n;
// Past this the copy isn't worth its share of the storage quota; the scan just stays in memory.
const STORE_MAX_SWAPS = 4_000;
const storedTo = new Map<string, bigint>();

type StoredSwap = Omit<SwapRecord, "blockNumber" | "amountIn" | "amountOut" | "feeAmount"> & Record<"blockNumber" | "amountIn" | "amountOut" | "feeAmount", string>;

function restoreScan(key: string): Scan | undefined {
  try {
    const text = globalThis.localStorage?.getItem(STORE_PREFIX + key);
    if (!text) return undefined;
    const stored = JSON.parse(text) as { scannedTo: string; fromBlock: string; swaps: StoredSwap[] };
    if (!Array.isArray(stored?.swaps)) return undefined;
    const scan: Scan = {
      scannedTo: BigInt(stored.scannedTo),
      fromBlock: BigInt(stored.fromBlock),
      swaps: stored.swaps.map((swap) => ({
        ...swap,
        blockNumber: BigInt(swap.blockNumber),
        amountIn: BigInt(swap.amountIn),
        amountOut: BigInt(swap.amountOut),
        feeAmount: BigInt(swap.feeAmount),
      })),
    };
    storedTo.set(key, scan.scannedTo);
    return scan;
  } catch {
    // Unavailable or damaged: scan from the start, as if nothing had been stored.
    return undefined;
  }
}

function storeScan(key: string, scan: Scan, head: bigint, gotNew: boolean) {
  const final = head > UNFINALIZED_BLOCKS ? head - UNFINALIZED_BLOCKS : 0n;
  if (final <= scan.fromBlock) return;
  const last = storedTo.get(key);
  if (last !== undefined && !gotNew && final - last < STORE_GAP_BLOCKS) return;
  const swaps = scan.swaps.filter((swap) => swap.blockNumber <= final);
  if (swaps.length > STORE_MAX_SWAPS) return;
  try {
    globalThis.localStorage?.setItem(
      STORE_PREFIX + key,
      JSON.stringify({ scannedTo: final, fromBlock: scan.fromBlock, swaps }, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
    );
    storedTo.set(key, final);
  } catch {
    // Quota or private mode: the in-memory copy still serves this session.
  }
}

function historyFloor(head: bigint, account: string | undefined, reach: HistoryReach): bigint {
  const deploy = AETHER_DEPLOY_BLOCK > 0n ? AETHER_DEPLOY_BLOCK : head > UNKNOWN_DEPLOY_LOOKBACK ? head - UNKNOWN_DEPLOY_LOOKBACK : 0n;
  if (account || reach === "all-time") return deploy;
  const recent = head > ALL_WALLETS_LOOKBACK ? head - ALL_WALLETS_LOOKBACK : 0n;
  return recent > deploy ? recent : deploy;
}

const newestFirst = (a: SwapRecord, b: SwapRecord) =>
  a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1;

/**
 * Swaps sent by `account`, or by anyone when omitted. Later calls only scan the blocks since the
 * last complete scan, so polling this is one small getLogs.
 */
export async function loadSwaps(account?: string, reach: HistoryReach = "recent"): Promise<SwapHistory> {
  const key = `${account ? account.toLowerCase() : "all"}:${reach}`;
  const head: bigint = await getLatestBlockNumber();
  if (head === 0n) throw new Error("Could not reach an RPC endpoint");

  const floor = historyFloor(head, account, reach);
  const prior = scans.get(key) ?? restoreScan(key);
  const fromBlock = prior ? prior.scannedTo + 1n : floor;
  // The engine's fetch is untyped JS; this is what a decoded SwapExecuted log carries.
  const { logs, complete } = (await fetchEventLogs({
    address: AETHER_AGGREGATOR,
    event: SWAP_EXECUTED,
    args: account ? { sender: account } : undefined,
    fromBlock,
    toBlock: head,
  })) as { logs: SwapLog[]; complete: boolean };
  const whole = complete && logs.length < TRUNCATION_SUSPECT;

  const seen = new Set(prior?.swaps.map((swap) => swap.id));
  const fresh: SwapRecord[] = [];
  for (const log of logs) {
    const id = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(id) || !log.args || log.blockNumber == null || !log.transactionHash) continue;
    seen.add(id);
    fresh.push({
      id,
      hash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: Number(log.logIndex),
      sender: log.args.sender,
      recipient: log.args.recipient,
      tokenIn: log.args.tokenIn,
      tokenOut: log.args.tokenOut,
      amountIn: log.args.amountIn,
      amountOut: log.args.amountOut,
      feeAmount: log.args.feeAmount,
      timestamp: log.blockTimestamp == null ? null : Number(log.blockTimestamp),
    });
  }

  // The floor of the shared feed moves forward with the head; what fell behind it is dropped, so
  // "the last week" stays a week however long ago the first scan was.
  const start = prior && prior.fromBlock > floor ? prior.fromBlock : floor;
  // Only the all-time view needs every swap dated up front (to bucket by day); a list resolves the
  // rows on screen exactly instead.
  if (reach === "all-time" && fresh.some((swap) => swap.timestamp == null)) {
    await estimateTimestamps(fresh, fromBlock, head);
  }
  const swaps = [...fresh, ...(prior?.swaps ?? [])].filter((swap) => swap.blockNumber >= start).sort(newestFirst);
  // A partial scan is returned but not remembered, so the next call retries the same range.
  if (whole) {
    const scan = { swaps, scannedTo: head, fromBlock: start };
    scans.set(key, scan);
    storeScan(key, scan, head, fresh.length > 0);
  }
  return { swaps, complete: whole, fromBlock: start, head };
}

/**
 * Not every endpoint puts the block time on a log. Blocks are 12s apart with the odd missed slot,
 * so interpolating between the two ends of the scanned range lands within minutes — plenty for
 * daily totals, and marked so a list can look the real time up.
 */
async function estimateTimestamps(swaps: SwapRecord[], fromBlock: bigint, head: bigint): Promise<void> {
  const [first, last] = await Promise.all([
    client.getBlock({ blockNumber: fromBlock }).catch(() => null),
    client.getBlock({ blockNumber: head }).catch(() => null),
  ]);
  if (!first || !last || head <= fromBlock) return;
  const span = Number(last.timestamp - first.timestamp);
  const blocks = Number(head - fromBlock);
  for (const swap of swaps) {
    if (swap.timestamp != null) continue;
    swap.timestamp = Math.round(Number(first.timestamp) + (span * Number(swap.blockNumber - fromBlock)) / blocks);
    swap.timestampEstimated = true;
  }
}

const tokenCache = new Map<string, Promise<Token>>();

/** Listed tokens come with their artwork; anything else is read from the token contract. */
export function loadToken(address: string): Promise<Token> {
  const key = address.toLowerCase();
  let token = tokenCache.get(key);
  if (!token) {
    const listed = (TOKENS as Token[]).find((entry) => entry.address.toLowerCase() === key);
    token = listed
      ? Promise.resolve(listed)
      : Promise.all([
          client.readContract({ address: address as `0x${string}`, abi: ERC20_META, functionName: "symbol" }).catch(() => null),
          client.readContract({ address: address as `0x${string}`, abi: ERC20_META, functionName: "decimals" }).catch(() => null),
        ]).then(([symbol, decimals]) => ({
          symbol: typeof symbol === "string" && symbol ? symbol : `${address.slice(0, 6)}…`,
          name: typeof symbol === "string" && symbol ? symbol : address,
          address,
          decimals: decimals == null ? 18 : Number(decimals),
          chainId: 11155111,
          color: `#${key.slice(2, 8)}`,
        }));
    tokenCache.set(key, token);
  }
  return token;
}
