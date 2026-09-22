// Persistent liquidity-graph index — the "any new token, any new pool" backbone.
//
// Instead of a hand-curated bridge list, transit candidates for A→B are DERIVED from data:
// every pool a token belongs to is learned from factory creation events (V2 PairCreated,
// V3 PoolCreated) plus the V4 Initialize discovery, giving a neighbor graph. The candidates
// are the tokens connected to BOTH endpoints, ranked by connectivity and capped. The graph
// only SELECTS candidates — pool existence per fee tier and actual value are still validated
// by getPool/quotes in the engine, so a stale or partial index can never produce a wrong price.
//
// The scan result per token is persisted (localStorage in the app, in-memory in Node scripts)
// with a block-number watermark: a new session replays the stored edges and only scans blocks
// created since, so the first-ever scan of a token is the only expensive one and a pool created
// seconds ago is picked up by the very next quote.
import {
  ETH_ADDRESS,
  MAX_TRANSIT_CANDIDATES,
  POOL_FACTORY,
  V2_FACTORY,
  WETH,
} from './quoteConfig'
import { discoverV4PoolsForCurrency, fetchEventLogs, getLatestBlockNumber } from './quoteProviders'
import { FEED_RECENT_BLOCKS, feedNeighbors, loadPoolFeed } from './poolFeed'
import { screenCorridors } from './corridorScreen'
import { bridgeTokens } from './autoHubs'

const V3_POOL_CREATED_EVENT = {
  type: 'event', name: 'PoolCreated',
  inputs: [
    { name: 'token0', type: 'address', indexed: true },
    { name: 'token1', type: 'address', indexed: true },
    { name: 'fee', type: 'uint24', indexed: true },
    { name: 'tickSpacing', type: 'int24', indexed: false },
    { name: 'pool', type: 'address', indexed: false },
  ],
}
const V2_PAIR_CREATED_EVENT = {
  type: 'event', name: 'PairCreated',
  inputs: [
    { name: 'token0', type: 'address', indexed: true },
    { name: 'token1', type: 'address', indexed: true },
    { name: 'pair', type: 'address', indexed: false },
    { name: 'allPairsLength', type: 'uint256', indexed: false },
  ],
}

const INDEX_STORE_KEY = 'aether_pool_index_v1'
// First-ever scan asks for the token's FULL history in one query (capable RPCs serve it — the
// topic filter keeps results small). Only the windowed fallback is bounded by this lookback,
// because a walk from block 0 would mean thousands of windows. Anything older that it misses is
// by construction an old mainstay pool, and those are all WETH/USDC-paired — covered by the
// pinned WETH transit + direct getPool discovery, which don't depend on this index.
const FACTORY_WINDOW_LOOKBACK = 3_000_000n
// Past the deadline the quote proceeds with legacy bridges; the scan keeps running in the
// background (inflight-deduped) and lands in the store for the next quote — same pattern as V4.
const TRANSIT_SOFT_TIMEOUT_MS = 12_000

// WETH is every token's counterparty on Sepolia: enumerating its neighbors returns thousands of
// logs (the same reason V4 discovery skips native ETH). It's never needed as a scan target —
// as an endpoint, single-sided mode handles it; as a transit, it's pinned unconditionally.
const UNSCANNABLE = new Set([WETH.toLowerCase(), ETH_ADDRESS])

function loadStore() {
  try {
    const raw = globalThis.localStorage?.getItem(INDEX_STORE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const store = loadStore()  // token -> { to: number, n: { neighbor: [v2Count, v3Count] } }

function persistStore() {
  try {
    globalThis.localStorage?.setItem(INDEX_STORE_KEY, JSON.stringify(store))
  } catch { /* quota/unavailable — in-memory copy still serves this session */ }
}

function addEdge(neighbors, token0, token1, self, slot) {
  const other = token0.toLowerCase() === self ? token1.toLowerCase() : token0.toLowerCase()
  if (other === self) return
  const entry = neighbors[other] ?? (neighbors[other] = [0, 0])
  entry[slot] += 1
}

const inflightScans = new Map()

// Returns { neighbors: { addrLower: [v2Count, v3Count] }, complete } for one token, incrementally.
export function getTokenNeighbors(address) {
  const key = address.toLowerCase()
  if (inflightScans.has(key)) return inflightScans.get(key)
  const scan = scanTokenNeighbors(key).finally(() => inflightScans.delete(key))
  inflightScans.set(key, scan)
  return scan
}

async function scanTokenNeighbors(key) {
  const stored = store[key]
  const neighbors = stored ? structuredClone(stored.n) : {}
  const latest = await getLatestBlockNumber()
  if (latest === 0n) return { neighbors, complete: false }
  const fromBlock = stored ? BigInt(stored.to) + 1n : 0n
  if (fromBlock > latest) return { neighbors, complete: true }
  const windowFloor = latest > FACTORY_WINDOW_LOOKBACK ? latest - FACTORY_WINDOW_LOOKBACK : 0n

  const [v3AsT0, v3AsT1, v2AsT0, v2AsT1] = await Promise.all([
    fetchEventLogs({ address: POOL_FACTORY, event: V3_POOL_CREATED_EVENT, args: { token0: key }, fromBlock, toBlock: latest, windowFloor }),
    fetchEventLogs({ address: POOL_FACTORY, event: V3_POOL_CREATED_EVENT, args: { token1: key }, fromBlock, toBlock: latest, windowFloor }),
    fetchEventLogs({ address: V2_FACTORY, event: V2_PAIR_CREATED_EVENT, args: { token0: key }, fromBlock, toBlock: latest, windowFloor }),
    fetchEventLogs({ address: V2_FACTORY, event: V2_PAIR_CREATED_EVENT, args: { token1: key }, fromBlock, toBlock: latest, windowFloor }),
  ])

  for (const log of [...v3AsT0.logs, ...v3AsT1.logs]) {
    if (log.args?.token0 && log.args?.token1) addEdge(neighbors, log.args.token0, log.args.token1, key, 1)
  }
  for (const log of [...v2AsT0.logs, ...v2AsT1.logs]) {
    if (log.args?.token0 && log.args?.token1) addEdge(neighbors, log.args.token0, log.args.token1, key, 0)
  }

  const complete = v3AsT0.complete && v3AsT1.complete && v2AsT0.complete && v2AsT1.complete
  if (complete) {
    // Advance the watermark only on a complete scan, so a dropped window is re-scanned next
    // quote instead of leaving a permanent hole in the graph.
    store[key] = { to: Number(latest), n: neighbors }
    persistStore()
  }
  return { neighbors, complete }
}

async function v4NeighborCounts(address) {
  const key = address.toLowerCase()
  if (UNSCANNABLE.has(key)) return {}
  try {
    const pools = await discoverV4PoolsForCurrency(key)
    const counts = {}
    for (const pool of pools) {
      let other = pool.currency0.toLowerCase() === key ? pool.currency1.toLowerCase() : pool.currency0.toLowerCase()
      // Normalize native ETH to WETH so V4 edges land on the same graph node as V2/V3 edges.
      if (other === ETH_ADDRESS) other = WETH.toLowerCase()
      if (other !== key) counts[other] = (counts[other] ?? 0) + 1
    }
    return counts
  } catch {
    return {}
  }
}

// Edges between a side's endpoint and `addr`. poolIndex counts cover the endpoint's full V2/V3
// history, the feed covers every endpoint (WETH/ETH included) for recent V2/V3 and all of V4 —
// the same pool can be in both, so take the larger count per protocol rather than the sum.
function edgeCount(side, addr) {
  const [v2, v3] = side.neighbors?.[addr] ?? [0, 0]
  const f = side.feed.get(addr)
  return Math.max(v2, f?.v2 ?? 0) + Math.max(v3, f?.v3 ?? 0) + Math.max(side.v4?.[addr] ?? 0, f?.v4 ?? 0)
}

function sideNeighborKeys(side) {
  return new Set([...Object.keys(side.neighbors ?? {}), ...Object.keys(side.v4 ?? {}), ...side.feed.keys()])
}

function withDeadline(promise, ms, fallbackValue) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallbackValue),
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms)),
  ])
}

// How many graph candidates get priced by the corridor screen, and how many of those slots are
// reserved for corridors with a recently created pool (unarbitraged → where testnet edge lives).
const SCREEN_MAX = 40
const SCREEN_RECENT = 16
const SCREEN_TIMEOUT_MS = 8_000
const FEED_SOFT_TIMEOUT_MS = 8_000

// Transit candidates for a swap addrIn→addrOut (both already resolved to ERC20 — WETH for ETH).
//
// Returns { addresses, fromGraph, screened }: WETH pinned first, then graph picks capped at
// MAX_TRANSIT_CANDIDATES. Candidates must connect to BOTH endpoints — the pool feed supplies the
// ETH/WETH side that per-token scans can't enumerate. Up to SCREEN_MAX of them (connectivity
// leaders plus the most recently created corridors) are priced by the corridor screen and ranked
// by what they pay; `screened` carries that ranking so the engine can quote a corridor that beats
// every direct pool even when the heavy bridge search is off. When the graph can't answer (scan
// failed/timed out/both endpoints WETH) the legacy seed list is merged in, so routing under RPC
// failure is never NARROWER than the pre-graph engine.
export async function getTransitCandidates(addrIn, addrOut, max = MAX_TRANSIT_CANDIDATES, { amountRaw } = {}) {
  const startedAt = Date.now()
  const inKey = addrIn.toLowerCase()
  const outKey = addrOut.toLowerCase()
  const scannable = [inKey, outKey].filter(key => !UNSCANNABLE.has(key))

  const [results, feed] = await Promise.all([
    withDeadline(
      Promise.all([
        ...scannable.map(key => getTokenNeighbors(key)),
        ...scannable.map(key => v4NeighborCounts(key)),
      ]),
      TRANSIT_SOFT_TIMEOUT_MS,
      null,
    ),
    loadPoolFeed({ timeoutMs: FEED_SOFT_TIMEOUT_MS }),
  ])

  const legacy = [WETH, ...bridgeTokens()].filter(addr =>
    addr.toLowerCase() !== inKey && addr.toLowerCase() !== outKey)

  if (scannable.length === 0 || (!results && !feed)) return { addresses: legacy, fromGraph: false, screened: null }

  const sides = [inKey, outKey].map(key => {
    const i = scannable.indexOf(key)
    const scan = results && i >= 0 ? results[i] : null
    return {
      key,
      neighbors: scan?.neighbors ?? {},
      v4: results && i >= 0 ? results[scannable.length + i] : {},
      feed: feedNeighbors(feed, key),
      // An unscannable endpoint (WETH) is only as complete as the feed that stands in for it.
      complete: i >= 0 ? Boolean(scan?.complete) : Boolean(feed),
    }
  })

  const excluded = new Set([inKey, outKey, WETH.toLowerCase(), ETH_ADDRESS])
  const [smaller, larger] = sideNeighborKeys(sides[0]).size <= sideNeighborKeys(sides[1]).size
    ? [sides[0], sides[1]]
    : [sides[1], sides[0]]
  const blindSide = sides.find(side => UNSCANNABLE.has(side.key))
  const twoSided = []
  const oneSided = []
  for (const addr of sideNeighborKeys(smaller)) {
    if (excluded.has(addr)) continue
    const counts = [edgeCount(smaller, addr), edgeCount(larger, addr)]
    const entry = {
      addr,
      min: Math.min(...counts),
      total: counts[0] + counts[1],
      last: Math.max(smaller.feed.get(addr)?.last ?? 0, larger.feed.get(addr)?.last ?? 0),
    }
    if (counts[1] > 0) twoSided.push(entry)
    // Only the WETH side can be blind (its pre-feed V2/V3 pools); the screen's getPool/getPair
    // lookups verify those, so they stay as a lower-priority fallback instead of being dropped.
    else if (larger === blindSide) oneSided.push(entry)
  }
  const byConnectivity = (a, b) => b.min - a.min || b.total - a.total
  twoSided.sort(byConnectivity)
  oneSided.sort(byConnectivity)

  const recentFloor = (feed?.toBlock ?? 0) - Number(FEED_RECENT_BLOCKS)
  const recent = twoSided.filter(c => c.last >= recentFloor).sort((a, b) => b.last - a.last)
  const screenSet = [...new Set([
    ...twoSided.slice(0, SCREEN_MAX - SCREEN_RECENT).map(c => c.addr),
    ...recent.slice(0, SCREEN_RECENT).map(c => c.addr),
    ...twoSided.map(c => c.addr),
    ...oneSided.map(c => c.addr),
  ])].slice(0, SCREEN_MAX)

  const screened = amountRaw && screenSet.length
    ? await withDeadline(
      screenCorridors({ addrIn: inKey, addrOut: outKey, amountRaw, candidates: screenSet, feed }),
      SCREEN_TIMEOUT_MS,
      null,
    )
    : null

  // Priced corridors first (best payout first); the rest keep connectivity order behind them, so a
  // screen that times out or can't price a pool degrades to the old ranking instead of dropping it.
  // Corridors the quoters priced at zero go last — they're kept only as the deepest fallback.
  const pricedOrder = screened?.corridors.map(c => c.address) ?? []
  const rejected = new Set(screened?.rejected ?? [])
  const ordered = [...new Set([...pricedOrder, ...screenSet.filter(addr => !rejected.has(addr)), ...rejected])]

  const pinned = (inKey !== WETH.toLowerCase() && outKey !== WETH.toLowerCase()) ? [WETH] : []
  const addresses = [...pinned, ...ordered].slice(0, Math.min(max, MAX_TRANSIT_CANDIDATES))

  // A partial scan can only be MISSING edges — merge the legacy seeds so no corridor the old
  // engine had disappears; a complete graph stands on its own (that's the whole point).
  const complete = sides.every(side => side.complete)
  if (!complete) {
    for (const addr of legacy) {
      if (!addresses.some(existing => existing.toLowerCase() === addr.toLowerCase())) addresses.push(addr)
    }
  }

  if (globalThis.__AETHER_DEBUG) {
    console.log('[dbg] transit:', complete ? 'graph' : 'graph+legacy(partial)',
      `(${Date.now() - startedAt}ms)`, `two-sided ${twoSided.length} recent ${recent.length} screened ${pricedOrder.length}`,
      '|', addresses.map(a => a.slice(0, 8)).join(','),
      screened ? `| direct ${screened.directOut} best ${screened.corridors[0]?.address?.slice(0, 8)}=${screened.corridors[0]?.out}` : '')
  }
  return {
    addresses,
    fromGraph: true,
    screened: screened ? { directOut: screened.directOut, corridors: screened.corridors.slice(0, 12) } : null,
  }
}
