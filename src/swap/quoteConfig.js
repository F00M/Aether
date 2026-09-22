export const QUOTER_V2 = '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3'
export const POOL_FACTORY = '0x0227628f3F023bb0B980b67D528571c95c6DaC1c'
export const V4_QUOTER = '0x61b3f2011a92d183c7dbadbda940a7555ccf9227'
export const UNIVERSAL_ROUTER = '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b'
// The Trading API's /swap calldata targets ITS OWN Universal Router deployment on Sepolia — NOT
// the one above (verified 2026-07-09 from a live /swap response). Permit2 approvals for the
// execute-via-API path must name this router as spender or every API execution preflight reverts.
export const UNISWAP_API_ROUTER = '0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9'
export const POSITION_MANAGER = '0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4'
export const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543'
export const V2_FACTORY = '0xF62c03E08ada871A0bEb309762E260a7a6a880E6'
export const V2_ROUTER = '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3'

// The Aether diamond (EIP-2535, contracts/src/diamond), deployed 2026-09-22 — see
// contracts/deployments/sepolia.json.
const DEFAULT_AETHER_AGGREGATOR = '0xD21D6bCF47e8b7a0611C0d1d2f718c94B0aC3334'
export const AETHER_AGGREGATOR = process.env.NEXT_PUBLIC_AETHER_AGGREGATOR_ADDRESS || DEFAULT_AETHER_AGGREGATOR
// V3/V2 legs that call the pool directly and pay inside the swap callback: ~31k gas cheaper per V3
// leg, no approvals. Live since the diamond runs AetherSwapFacet 3.1 + PoolCallbackFacet (2026-09-23);
// set NEXT_PUBLIC_AETHER_DIRECT_POOL_LEGS=0 to fall back to the router legs.
export const DIRECT_POOL_LEGS = process.env.NEXT_PUBLIC_AETHER_DIRECT_POOL_LEGS !== '0'

export const ETH_ADDRESS = '0x0000000000000000000000000000000000000000'
export const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'
export const USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
export const SEPOLIA_ADDRESS = '0x95c815AD169527CD940E2d2905BC293bc2156fC4'
export const ZRO_ADDRESS = '0x3367f52b486bE19b6629c9c7e1B7D5B0BCf1267D'
export const IDRX_ADDRESS = '0x20F08bd71d7D346Ff7811EE7dA5404469D7b017e'
export const METH_ADDRESS = '0x4f7A67464B5976d7547c860109e4432d50AfB38e'
export const zkLTC_ADDRESS = '0xae9190aeca45f50dcda0483c0223e191e6811ad2'

export const FEE_TIERS = [100, 500, 3000, 10000]
export const MAX_CANDIDATE_ROUTES = 120
// Hard cap on routes in one execute() tx. Raised 6→12 so the ADAPTIVE per-trade cap in
// getTradeScaleConfig (16 for ≥1M, 12 for ≥100k, 8 for ≥10k, 5 for ≥1k, 3 below) can actually take
// effect — large/whale trades now spread across up to 12 corridors to absorb every deep pool, while
// small trades stay lean (3-5). Preflight always simulates the FULL displayed set (no route-drop).
export const MAX_EXECUTED_ROUTES = 12
export const MAX_EXECUTABLE_SPLIT_ROUTES = 12
export const COMPETITIVE_ROUTE_BPS = 9800
export const V4_COMPETITIVE_ROUTE_BPS = 8500
export const BALANCED_ROUTE_BPS = 6500
export const V4_BALANCED_ROUTE_BPS = 4500
export const MIN_EXECUTABLE_ROUTE_BPS = 7000
export const BALANCED_IMPACT_THRESHOLD = 0.05
export const BALANCED_MAX_ROUTE_SHARE = 0.45
export const BALANCED_PROBE_SHARE = 0.01
export const PROBE_ONLY_MAX_ROUTE_SHARE = 0.03
// Policy: best price first. A wider/balanced split (more routes, e.g. forcing V2 in) is only
// accepted if its output is at least this fraction of the best result. At 10000 (100%) the
// router never sacrifices output just to spread across more pools — extra routes like V2 are
// included only when they genuinely match/beat the best price. Lower it (e.g. 9700) to allow
// trading up to 3% output for wider liquidity spreading.
export const MIN_BALANCED_OUTPUT_BPS = 10000
export const RELIEF_IMPACT_THRESHOLD = 0.0025
export const DIRECT_RELIEF_MAX_SHARE_BPS = 5000n
export const V4_ASSIST_PCTS = [1, 2, 3, 5]
export const MIN_V4_ASSIST_GAIN_BPS = 10001
export const BRIDGE_ASSIST_PCTS = [1, 2, 3, 5, 8, 10, 12, 15, 20, 25, 33, 40, 50, 60, 67, 75]
export const OPTIMIZED_SPLIT_SHARES = [1, 2, 3, 4, 5, 8, 10, 12, 15, 20, 25, 33, 40, 45, 50, 55, 60, 65, 67, 70, 75, 80, 88, 90, 92, 95, 96, 97, 98, 99, 100]
export const OPTIMIZED_MAX_ROUTES = 64
export const MARGINAL_SPLIT_CHUNKS = 120
// Must track MAX_EXECUTED_ROUTES (12): when the route cap was raised 6→12 this stayed at 6, so any
// large trade whose optimizer candidate set exceeded 6 silently LOST the marginal greedy (the
// strongest allocator, the +47%-vs-Uniswap wins) and fell to the dp-matrix path. The greedy's cost
// is bounded by the pre-warmed quote ladder (one parallel wave), not by candidate count.
export const MAX_MARGINAL_GREEDY_ROUTES = 12
export const MAX_MARGINAL_GREEDY_CHUNKS = 30
// Max V4 pools per hop considered for multi-hop (USDC→ETH→TOKEN) routes, by ascending fee. Each
// combo is full-quoted now, so this caps the combo count (pools/hop²). 8 keeps the competitive
// low/standard-fee pools (a deep high-fee pool can't beat its own fee anyway).
export const MAX_MULTIHOP_POOLS_PER_HOP = 8
// Greedy runs its rounds sequentially (each waits on RPC), so round count drives quote latency.
// The fast scan uses fewer, coarser rounds to get a price on screen quickly; the full scan that
// follows refines with the full round count. Time budgets stop a slow RPC from hanging the
// quote: past the deadline the remaining amount is allocated in one final round.
export const FAST_GREEDY_CHUNKS = 5
export const GREEDY_TIME_BUDGET_FAST_MS = 5000
export const GREEDY_TIME_BUDGET_FULL_MS = 12000
export const ROUTE_WEIGHT_POWER = 4
export const BALANCED_ROUTE_WEIGHT_POWER = 1.25
// The API reference must be compared same-instant with our final split (Sepolia pools drift in
// minutes). When the full scan lands and the API number in hand is older than this, re-fetch it
// once so the winner check is honest — the API result itself is NEVER discarded on a timer.
export const API_QUOTE_REFRESH_AGE_MS = 4000
export const API_SANITY_MAX_LOCAL_BPS = 10050n
export const ENABLE_SPLIT_EXECUTION = true
export const PREFER_V3_SINGLE_ROUTE_EXECUTION = false
export const ENABLE_V4_MULTIHOP_ROUTES = true

export const V4_COMMON_FEE_TIERS = [
  // 0% fee (tickSpacing 1) probed deterministically so a 0-fee pool is always found even when
  // event-log discovery misses it (public RPCs drop getLogs windows). Non-existent ones are
  // filtered by the quoter, so this is free when no 0% pool exists.
  { fee: 0, tickSpacing: 1 },
  { fee: 20, tickSpacing: 1 },
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
  // 2% tier (seen live on Sepolia, e.g. the ETH/USDC 2% pool). Listed as a tier rather than a
  // single known pool so auto-discovery finds 2% pools for EVERY pair, including pasted tokens.
  { fee: 20000, tickSpacing: 400 },
  // High-fee tiers, 5% → ~100%: pool creators on Sepolia actually use these (live examples:
  // ETH/USDC 10%/20%/80%, zkLTC/ETH 50%/90%/99%/99.9999% — the 90% one held the only real
  // liquidity and was invisible to the guess list). tickSpacing follows the Uniswap-UI default
  // for custom fees (fee/50, matching every such pool observed on-chain). Event discovery still
  // catches arbitrary fee/tickSpacing combos; these make the common creation path deterministic
  // even when getLogs is starved. Non-existent pools are revert-filtered by the quoter, and the
  // multi-hop per-hop cap sorts fee-ascending so high tiers never crowd out cheap ones.
  // `exotic` marks them for the FAST scan filter: the first on-screen price skips exotic-tier
  // guesses unless the pool has already proven alive (v4 liveness cache) — the full scan that
  // follows still probes them all, so coverage is unchanged, only the first paint is lighter.
  { fee: 50000, tickSpacing: 1000, exotic: true },
  { fee: 100000, tickSpacing: 2000, exotic: true },
  { fee: 200000, tickSpacing: 4000, exotic: true },
  { fee: 500000, tickSpacing: 10000, exotic: true },
  { fee: 800000, tickSpacing: 16000, exotic: true },
  { fee: 900000, tickSpacing: 18000, exotic: true },
  { fee: 990000, tickSpacing: 19800, exotic: true },
  { fee: 999999, tickSpacing: 20000, exotic: true },
]

// Bridge tokens are DETECTED, not listed: autoHubs.js scores every token that pairs with both WETH
// and USDC by routing a real trade through it in both directions, and keeps the ones that hold
// their value (measured 2026-09-22: the old MUSD/tBTC/SOL/PEPE list had three dead corridors, and
// the most-connected token on Sepolia — 301 pools — paid nothing). This seed only stands in on a
// cold start, before the first detection lands; it's the user's own pick from 2026-09-19.
export const SEED_BRIDGE_ADDRESSES = [SEPOLIA_ADDRESS, ZRO_ADDRESS, IDRX_ADDRESS, METH_ADDRESS, zkLTC_ADDRESS]

// Cold-start V4 guess set (static poolKey guesses across the fee ladder). Once the pool feed has
// the full V4 history, the engine quotes the pools that actually exist instead.
export const INTERMEDIATE_ADDRESSES = [
  WETH,
  USDC_ADDRESS,
  ...SEED_BRIDGE_ADDRESSES,
  '0x779877a7b0d9e8603169ddbd7836e478b4624789', // LINK
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', // UNI
]

// Dynamic transit (poolIndex.js liquidity graph) replaces the hardcoded bridge lists on the full
// scan: candidates for A→B are derived from indexed pool-creation events (neighbors(A)∩neighbors(B)),
// so ANY token with two-sided liquidity becomes a corridor without touching config. This cap bounds
// the per-quote RPC cost however many pools exist on-chain; the optimizer's real quotes do the final
// value ranking.
export const MAX_TRANSIT_CANDIDATES = 8

// Anchor currencies: every hub pair is checked against these. ETH/WETH is Sepolia's universal
// counterparty (V2/V3 hop through WETH, V4 through native ETH); USDC is the stable anchor.
export const V4_DYNAMIC_HUBS = [ETH_ADDRESS, USDC_ADDRESS]

const KNOWN_V4_POOLS = [
  {
    id: 'eth_usdc_20',
    currency0: ETH_ADDRESS,
    currency1: USDC_ADDRESS,
    fee: 20,
    tickSpacing: 1,
    hooks: ETH_ADDRESS,
    token0IsEth: true,
  },
  {
    id: 'eth_usdc_100',
    currency0: ETH_ADDRESS,
    currency1: USDC_ADDRESS,
    fee: 100,
    tickSpacing: 1,
    hooks: ETH_ADDRESS,
    token0IsEth: true,
  },
  {
    id: 'eth_usdc_500',
    currency0: ETH_ADDRESS,
    currency1: USDC_ADDRESS,
    fee: 500,
    tickSpacing: 10,
    hooks: ETH_ADDRESS,
    token0IsEth: true,
  },
  {
    id: 'eth_usdc_3000',
    currency0: ETH_ADDRESS,
    currency1: USDC_ADDRESS,
    fee: 3000,
    tickSpacing: 60,
    hooks: ETH_ADDRESS,
    token0IsEth: true,
  },
  {
    id: 'eth_usdc_10000',
    currency0: ETH_ADDRESS,
    currency1: USDC_ADDRESS,
    fee: 10000,
    tickSpacing: 200,
    hooks: ETH_ADDRESS,
    token0IsEth: true,
  },
]

function compareAddress(a, b) {
  const aa = BigInt(a.toLowerCase())
  const bb = BigInt(b.toLowerCase())
  return aa < bb ? -1 : aa > bb ? 1 : 0
}

export function makeV4Pool(currencyA, currencyB, feeTier) {
  if (currencyA.toLowerCase() === currencyB.toLowerCase()) return null
  const [currency0, currency1] = compareAddress(currencyA, currencyB) <= 0
    ? [currencyA, currencyB]
    : [currencyB, currencyA]

  return {
    id: `auto_${currency0.toLowerCase()}_${currency1.toLowerCase()}_${feeTier.fee}`,
    currency0,
    currency1,
    fee: feeTier.fee,
    tickSpacing: feeTier.tickSpacing,
    hooks: ETH_ADDRESS,
    token0IsEth: currency0.toLowerCase() === ETH_ADDRESS,
    autoDiscovered: true,
    exotic: feeTier.exotic === true,
  }
}

const V4_ROUTING_HUB_ADDRESSES = [
  ETH_ADDRESS,
  WETH,
  USDC_ADDRESS,
]

const V4_ROUTING_TOKEN_ADDRESSES = [
  ...new Set([
    ...INTERMEDIATE_ADDRESSES,
    ...V4_ROUTING_HUB_ADDRESSES,
  ].map(address => address.toLowerCase())),
].map(address => {
  const known = [
    ...V4_ROUTING_HUB_ADDRESSES,
    ...INTERMEDIATE_ADDRESSES,
  ].find(candidate => candidate.toLowerCase() === address)
  return known ?? address
})

const PRIORITY_V4_PAIRS = [
  ...V4_ROUTING_HUB_ADDRESSES.flatMap((hub, index) =>
    V4_ROUTING_HUB_ADDRESSES.slice(index + 1).map(otherHub => [hub, otherHub])
  ),
  ...V4_ROUTING_TOKEN_ADDRESSES.flatMap(token =>
    V4_ROUTING_HUB_ADDRESSES.map(hub => [token, hub])
  ),
]

const PRIORITY_AUTO_V4_POOLS = PRIORITY_V4_PAIRS.flatMap(([currencyA, currencyB]) =>
  V4_COMMON_FEE_TIERS
    .map(feeTier => makeV4Pool(currencyA, currencyB, feeTier))
    .filter(Boolean)
)

const V4_POOL_BY_ID = new Map()
export const V4_POOLS = [...KNOWN_V4_POOLS, ...PRIORITY_AUTO_V4_POOLS].filter(pool => {
  const key = `${pool.currency0.toLowerCase()}-${pool.currency1.toLowerCase()}-${pool.fee}-${pool.tickSpacing}-${pool.hooks.toLowerCase()}`
  if (V4_POOL_BY_ID.has(key)) return false
  V4_POOL_BY_ID.set(key, pool)
  return true
})

export const v4PoolSet = () => V4_POOLS
