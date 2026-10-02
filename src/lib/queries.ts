import { loadSwaps } from "@/swap/activity";
import { loadPool, loadPools, loadPositions } from "@/swap/liquidity";

/**
 * The data each page reads, in one place: the page uses these, and the header warms the same
 * entries when a link is about to be followed — which only works if both name them identically.
 */
export const poolsQuery = () => ({ queryKey: ["aether-pools"] as const, queryFn: loadPools });

/** One pool, by address. */
export const poolQuery = (address: `0x${string}`) => ({
  queryKey: ["aether-pool", address.toLowerCase()] as const,
  queryFn: () => loadPool(address),
});

/** Disabled by the caller while no wallet is connected; the key still has to be well-formed then. */
export const positionsQuery = (account: `0x${string}` | undefined) => ({
  queryKey: ["aether-positions", account?.toLowerCase() ?? null] as const,
  queryFn: () => (account ? loadPositions(account) : Promise.resolve([])),
});

export const statsQuery = () => ({
  queryKey: ["aether-stats"] as const,
  queryFn: () => loadSwaps(undefined, "all-time"),
});
