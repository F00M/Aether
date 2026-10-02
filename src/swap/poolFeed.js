// Global pool feed — every pool CREATED on V2, V3 and V4 inside the lookback window, in one index
// shared by every token and every quote.
//
// Why this exists next to poolIndex's per-token scans: those can't see the ETH/WETH side. WETH
// pairs with nearly everything, so its per-token scan is thousands of logs and was skipped — which
// meant transit ranking never knew whether a USDC neighbour could actually reach ETH, and a V4 pool
// with an unusual fee (86%, 11%, 0.9%…) was only visible when its OTHER token happened to be an
// endpoint. Measured live: the ETH/zkLTC 86% pool that paid 16,361 USDC for 0.001 WETH was
// invisible to WETH→USDC for exactly these reasons. One UNFILTERED creation scan answers both: it
// is ~3k pools per protocol over 1.2M blocks, fetched in a handful of windowed getLogs, then kept
// current with one getLogs per protocol per refresh.
//
// Same contract as poolIndex: the feed only NOMINATES pools and corridors. Every price still comes
// from the quoter / execute() simulation, so a stale or partial feed can hide a route but never
// invent one.
import { toEventSelector } from 'viem'
import { ETH_ADDRESS, POOL_FACTORY, POOL_MANAGER, V2_FACTORY, WETH } from './quoteConfig'
import { fetchRawLogs, getLatestBlockNumber } from './quoteProviders'

const FEED_STORE_KEY = 'aether_pool_feed_v1'
// V4 is scanned from the PoolManager's deployment (tx 0xdb2321e6…, 2024-12-11), so EVERY no-hook
// pool ever initialized is known whatever its fee — the 1.2M-block window used elsewhere turned
// out to be younger than V4 itself (the standard ETH/USDC pools predate it). V2/V3 only need the
// recent window: older pools stay covered by poolIndex's full-history per-token scans.
const V4_DEPLOY_BLOCK = 7_258_946n
const FEED_LOOKBACK = 1_200_000n
// An endpoint that serves wide getLogs ranges can SILENTLY truncate a response once it
// would exceed ~10k logs — a full-history V4 scan came back with 8 logs instead of 8k+, no error.
// 200k blocks is ~1.7k V4 logs today, far from that cliff; a window that still comes back large is
// split again rather than trusted.
const FEED_WINDOW = 200_000n
const FEED_SUSPECT_LOGS = 5_000
const FEED_MIN_WINDOW = 10_000n
// Sepolia makes a block every ~12s; refreshing faster only re-asks for blocks that don't exist.
const FEED_REFRESH_MS = 15_000
// How far (in blocks, ~1h) the stored copy may trail the in-memory one before it is rewritten when
// no pool was added in between.
const FEED_PERSIST_GAP = 300
// "Recent" = created inside roughly the last week. Fresh pools are where Sepolia mispricing lives
// (nobody has arbitraged them yet), so transit ranking reserves room for them.
export const FEED_RECENT_BLOCKS = 50_000n

const V4_INITIALIZE_EVENT = {
  type: 'event', name: 'Initialize',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true },
    { name: 'currency0', type: 'address', indexed: true },
    { name: 'currency1', type: 'address', indexed: true },
    { name: 'fee', type: 'uint24', indexed: false },
    { name: 'tickSpacing', type: 'int24', indexed: false },
    { name: 'hooks', type: 'address', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
  ],
}
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

const lower = address => address.toLowerCase()
// V4 pools are ETH-native; V2/V3 pair against WETH. One graph node for both.
const graphNode = address => (lower(address) === ETH_ADDRESS ? lower(WETH) : lower(address))

// ------------------------------------------------------------------ persistence

// In memory, rows are compact arrays of lowercase addresses:
//   v4: [currency0, currency1, fee, tickSpacing, block]   (no-hook pools only)
//   v3: [token0, token1, fee, pool, block]
//   v2: [token0, token1, pair, block]
// On disk the token columns point into one shared address table — ~17k pools over a few thousand
// tokens, so this keeps the stored copy under a megabyte instead of ~2MB of repeated addresses.
function emptyRaw() {
  return { to: 0, v4: [], v3: [], v2: [] }
}

function loadRaw() {
  try {
    const text = globalThis.localStorage?.getItem(FEED_STORE_KEY)
    if (!text) return emptyRaw()
    const stored = JSON.parse(text)
    const table = stored?.t
    if (!Array.isArray(table) || !Array.isArray(stored.v4) || !Array.isArray(stored.v3) || !Array.isArray(stored.v2)) {
      return emptyRaw()
    }
    return {
      to: Number(stored.to) || 0,
      v4: stored.v4.map(([a, b, fee, ts, block]) => [table[a], table[b], fee, ts, block]),
      v3: stored.v3.map(([a, b, fee, pool, block]) => [table[a], table[b], fee, pool, block]),
      v2: stored.v2.map(([a, b, pair, block]) => [table[a], table[b], pair, block]),
    }
  } catch {
    return emptyRaw()
  }
}

function persistRaw(raw) {
  try {
    const table = []
    const index = new Map()
    const ref = address => {
      let i = index.get(address)
      if (i === undefined) {
        i = table.length
        table.push(address)
        index.set(address, i)
      }
      return i
    }
    const stored = {
      to: raw.to,
      v4: raw.v4.map(([a, b, fee, ts, block]) => [ref(a), ref(b), fee, ts, block]),
      v3: raw.v3.map(([a, b, fee, pool, block]) => [ref(a), ref(b), fee, pool, block]),
      v2: raw.v2.map(([a, b, pair, block]) => [ref(a), ref(b), pair, block]),
      t: table,
    }
    globalThis.localStorage?.setItem(FEED_STORE_KEY, JSON.stringify(stored))
  } catch { /* quota/unavailable — the in-memory copy still serves this session */ }
}

// ------------------------------------------------------------------ indexes

function buildSnapshot(raw) {
  const v4ByCurrency = new Map()   // currency (0x0 kept as ETH) -> V4 pool objects
  const edges = new Map()          // graph node -> Map(neighbor -> { v2, v3, v4, last })
  const v3ByPair = new Map()       // 'a-b' (sorted) -> [{ fee, pool, block }]
  const v2ByPair = new Map()       // 'a-b' (sorted) -> { pair, block }

  const addEdge = (a, b, slot, block) => {
    const na = graphNode(a)
    const nb = graphNode(b)
    if (na === nb) return
    for (const [from, to] of [[na, nb], [nb, na]]) {
      let map = edges.get(from)
      if (!map) edges.set(from, (map = new Map()))
      const entry = map.get(to) ?? { v2: 0, v3: 0, v4: 0, last: 0 }
      entry[slot] += 1
      if (block > entry.last) entry.last = block
      map.set(to, entry)
    }
  }

  for (const [c0, c1, fee, tickSpacing, block] of raw.v4) {
    const pool = {
      // Same id shape as event discovery in quoteProviders, so both sources dedupe to one pool.
      id: `evt_${c0}_${c1}_${fee}_${tickSpacing}`,
      currency0: c0,
      currency1: c1,
      fee,
      tickSpacing,
      hooks: ETH_ADDRESS,
      token0IsEth: c0 === ETH_ADDRESS,
      createdAt: block,
    }
    for (const currency of [c0, c1]) {
      const list = v4ByCurrency.get(currency)
      if (list) list.push(pool)
      else v4ByCurrency.set(currency, [pool])
    }
    addEdge(c0, c1, 'v4', block)
  }

  for (const [t0, t1, fee, pool, block] of raw.v3) {
    const key = pairKey(t0, t1)
    const list = v3ByPair.get(key)
    const row = { fee, pool, block }
    if (list) list.push(row)
    else v3ByPair.set(key, [row])
    addEdge(t0, t1, 'v3', block)
  }

  for (const [t0, t1, pair, block] of raw.v2) {
    v2ByPair.set(pairKey(t0, t1), { pair, block })
    addEdge(t0, t1, 'v2', block)
  }

  return {
    toBlock: raw.to,
    counts: { v4: raw.v4.length, v3: raw.v3.length, v2: raw.v2.length },
    v4ByCurrency,
    edges,
    v3ByPair,
    v2ByPair,
  }
}

const pairKey = (a, b) => {
  const [x, y] = [graphNode(a), graphNode(b)].sort()
  return `${x}-${y}`
}

// ------------------------------------------------------------------ scanning

// Windowed scan that refuses to trust a suspiciously full window (see FEED_SUSPECT_LOGS).
async function scanRange(address, topic0, fromBlock, toBlock) {
  if (fromBlock > toBlock) return { logs: [], complete: true }
  const windows = []
  for (let from = fromBlock; from <= toBlock; from += FEED_WINDOW) {
    const to = from + FEED_WINDOW - 1n < toBlock ? from + FEED_WINDOW - 1n : toBlock
    windows.push([from, to])
  }
  const parts = await Promise.all(windows.map(([from, to]) => scanWindow(address, topic0, from, to)))
  return { logs: parts.flatMap(p => p.logs), complete: parts.every(p => p.complete) }
}

async function scanWindow(address, topic0, fromBlock, toBlock) {
  const result = await fetchRawLogs({ address, topic0, fromBlock, toBlock })
  const span = toBlock - fromBlock
  if (result.logs.length < FEED_SUSPECT_LOGS || span <= FEED_MIN_WINDOW) return result
  const mid = fromBlock + span / 2n
  const [left, right] = await Promise.all([
    scanWindow(address, topic0, fromBlock, mid),
    scanWindow(address, topic0, mid + 1n, toBlock),
  ])
  return { logs: [...left.logs, ...right.logs], complete: left.complete && right.complete }
}

// The logs are read as raw hex (see fetchRawLogs for why): an indexed address is the low 20 bytes
// of its topic, and each non-indexed field is one 32-byte word of `data`. A log of the wrong shape
// yields null and is skipped, exactly as a failed decode was.
const TOPIC_V4_INITIALIZE = toEventSelector(V4_INITIALIZE_EVENT)
const TOPIC_V3_POOL_CREATED = toEventSelector(V3_POOL_CREATED_EVENT)
const TOPIC_V2_PAIR_CREATED = toEventSelector(V2_PAIR_CREATED_EVENT)

const WORD = 64
const topicAddress = topic => `0x${topic.slice(26)}`.toLowerCase()
const dataWord = (data, index) => data.slice(2 + index * WORD, 2 + (index + 1) * WORD)
const wordAddress = word => `0x${word.slice(24)}`.toLowerCase()
// uint24 / int24 both fit the low four bytes; `| 0` restores the sign of a sign-extended int24.
const wordUint = word => parseInt(word.slice(-8), 16)
const wordInt = word => parseInt(word.slice(-8), 16) | 0
const blockOf = log => parseInt(log.blockNumber ?? '0x0', 16)
const shaped = (log, topics, words) => log?.topics?.length === topics && log.data?.length >= 2 + words * WORD

function v4Row(log) {
  if (!shaped(log, 4, 5)) return null
  // Only no-hook pools: the swap path settles with hookData '0x' and can't drive arbitrary hooks.
  if (wordAddress(dataWord(log.data, 2)) !== ETH_ADDRESS) return null
  return [topicAddress(log.topics[2]), topicAddress(log.topics[3]), wordUint(dataWord(log.data, 0)), wordInt(dataWord(log.data, 1)), blockOf(log)]
}

function v3Row(log) {
  if (!shaped(log, 4, 2)) return null
  return [topicAddress(log.topics[1]), topicAddress(log.topics[2]), wordUint(log.topics[3]), wordAddress(dataWord(log.data, 1)), blockOf(log)]
}

function v2Row(log) {
  if (!shaped(log, 3, 2)) return null
  return [topicAddress(log.topics[1]), topicAddress(log.topics[2]), wordAddress(dataWord(log.data, 0)), blockOf(log)]
}

// What is already in the feed, so a re-scanned range adds nothing twice. Built once from the stored
// rows and then kept in step — rebuilding three sets over ~17k rows on every 15s refresh was part
// of a main-thread hitch that came back with each quote.
let seen = null
const v4Key = row => `${row[0]}-${row[1]}-${row[2]}-${row[3]}`

function seenRows() {
  if (!seen) {
    seen = {
      v4: new Set(raw.v4.map(v4Key)),
      v3: new Set(raw.v3.map(row => row[3])),
      v2: new Set(raw.v2.map(row => row[2])),
    }
  }
  return seen
}

/** Adds the pools these logs announce that the feed doesn't have yet; returns how many were new. */
function mergeLogs({ v4Logs, v3Logs, v2Logs }) {
  const known = seenRows()
  let added = 0
  const take = (logs, toRow, keyOf, rows, set) => {
    for (const log of logs) {
      const row = toRow(log)
      if (!row) continue
      const key = keyOf(row)
      if (set.has(key)) continue
      set.add(key)
      rows.push(row)
      added++
    }
  }
  take(v4Logs, v4Row, v4Key, raw.v4, known.v4)
  take(v3Logs, v3Row, row => row[3], raw.v3, known.v3)
  take(v2Logs, v2Row, row => row[2], raw.v2, known.v2)
  return added
}

// ------------------------------------------------------------------ state

// The stored copy is ~1.4MB of JSON: it is read on first use rather than at import, so parsing it
// and indexing ~17k pools doesn't sit in the page's own start-up.
let raw = null
let snapshot = null
let persistedTo = 0
let inflight = null
let lastRefreshAt = 0

function ensureLoaded() {
  if (raw) return
  raw = loadRaw()
  snapshot = raw.to > 0 ? buildSnapshot(raw) : null
  persistedTo = raw.to
}

// Lets the browser paint and take input between the heavy steps of a refresh.
const breathe = () => new Promise(resolve => setTimeout(resolve, 0))

async function refreshFeed() {
  ensureLoaded()
  const latest = await getLatestBlockNumber()
  if (latest === 0n) return snapshot
  const recentFloor = latest > FEED_LOOKBACK ? latest - FEED_LOOKBACK : 0n
  const fromBlock = raw.to > 0 ? BigInt(raw.to) + 1n : null
  if (fromBlock !== null && fromBlock > latest) return snapshot

  const [v4, v3, v2] = await Promise.all([
    scanRange(POOL_MANAGER, TOPIC_V4_INITIALIZE, fromBlock ?? V4_DEPLOY_BLOCK, latest),
    scanRange(POOL_FACTORY, TOPIC_V3_POOL_CREATED, fromBlock ?? recentFloor, latest),
    scanRange(V2_FACTORY, TOPIC_V2_PAIR_CREATED, fromBlock ?? recentFloor, latest),
  ])

  // Partial logs are still merged (dedupe makes a later re-scan of the same range harmless), but
  // the watermark only advances on a COMPLETE scan so a dropped window is re-read next refresh
  // instead of becoming a permanent hole.
  const added = mergeLogs({ v4Logs: v4.logs, v3Logs: v3.logs, v2Logs: v2.logs })
  const complete = v4.complete && v3.complete && v2.complete
  if (complete) raw.to = Number(latest)

  // Nearly every refresh finds no new pool. Re-indexing ~17k pools and rewriting the stored copy
  // for those was a 100ms+ hitch every 15s while a quote was on screen; now the watermark just
  // moves, and the stored copy follows only once it has fallen far enough behind to matter (a
  // reload re-reads the gap in a single small getLogs).
  if (added > 0 || !snapshot) {
    await breathe()
    snapshot = buildSnapshot(raw)
  } else if (snapshot.toBlock !== raw.to) {
    snapshot = { ...snapshot, toBlock: raw.to }
  }
  if (complete && (added > 0 || raw.to - persistedTo >= FEED_PERSIST_GAP)) {
    await breathe()
    persistRaw(raw)
    persistedTo = raw.to
  }

  if (globalThis.__AETHER_DEBUG) {
    console.log(`[dbg] pool feed: ${v4.logs.length} v4 / ${v3.logs.length} v3 / ${v2.logs.length} v2 logs, +${added} pools`,
      `from ${fromBlock ?? 'genesis'} → ${latest}`, complete ? 'complete' : 'PARTIAL', snapshot.counts)
  }
  return snapshot
}

function withDeadline(promise, ms, fallbackValue) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallbackValue),
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms)),
  ])
}

/**
 * Brings the feed up to date (throttled, in-flight deduped) and returns the freshest snapshot the
 * deadline allows. Past the deadline the previous snapshot (or null on a cold first load) comes
 * back while the scan keeps running and lands for the next quote.
 */
export function loadPoolFeed({ timeoutMs = 8_000 } = {}) {
  ensureLoaded()
  const now = Date.now()
  if (!inflight && now - lastRefreshAt >= FEED_REFRESH_MS) {
    lastRefreshAt = now
    inflight = refreshFeed()
      .catch(() => snapshot)
      .finally(() => { inflight = null })
  }
  if (!inflight) return Promise.resolve(snapshot)
  return withDeadline(inflight, timeoutMs, snapshot)
}

/** Latest built snapshot, synchronously — null until the first scan (or stored copy) exists. */
export function poolFeedSnapshot() {
  ensureLoaded()
  return snapshot
}

// ------------------------------------------------------------------ queries

/** Every no-hook V4 pool touching `currency`; WETH also returns the native-ETH pools it can use. */
export function feedV4PoolsFor(feed, currency) {
  if (!feed) return []
  const key = lower(currency)
  const direct = feed.v4ByCurrency.get(key) ?? []
  if (key !== lower(WETH)) return direct
  return [...direct, ...(feed.v4ByCurrency.get(ETH_ADDRESS) ?? [])]
}

/**
 * No-hook V4 pools between two EXACT currencies (native ETH and WETH are different V4 currencies,
 * so nothing is folded here). Enumerates from the non-ETH side — ETH touches most V4 pools.
 */
export function feedV4PoolsBetween(feed, currencyA, currencyB) {
  if (!feed) return []
  const a = lower(currencyA)
  const b = lower(currencyB)
  if (a === b) return []
  const list = feed.v4ByCurrency.get(a === ETH_ADDRESS ? b : a) ?? []
  const other = a === ETH_ADDRESS ? a : b
  return list.filter(pool => pool.currency0 === other || pool.currency1 === other)
}

/** Graph neighbours of a token (ETH folded into WETH): Map(neighbor -> { v2, v3, v4, last }). */
export function feedNeighbors(feed, address) {
  if (!feed) return new Map()
  return feed.edges.get(graphNode(address)) ?? new Map()
}

export function feedV3Pools(feed, a, b) {
  return feed?.v3ByPair.get(pairKey(a, b)) ?? []
}

export function feedV2Pair(feed, a, b) {
  return feed?.v2ByPair.get(pairKey(a, b)) ?? null
}
